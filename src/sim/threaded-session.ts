import { Worker } from "node:worker_threads";
import { config } from "../config.js";
import type { SimManagerLogger } from "./manager.js";
import type { SimSessionMode, SimSessionOptions, SimSessionStats } from "./session.js";

interface WorkerCommandMessage {
  type: "command";
  requestId: number;
  command: "ensureReserved" | "ensureActive" | "stop" | "getStats";
}

interface WorkerResponseMessage {
  type: "response";
  requestId: number;
  ok: boolean;
  stats?: SimSessionStats;
  sessionId?: string;
  userId?: string;
  error?: string;
}

interface WorkerReadyMessage {
  type: "ready";
  sessionId: string;
  userId: string;
  stats: SimSessionStats;
  threadId: number;
}

interface WorkerStatsMessage {
  type: "stats";
  stats: SimSessionStats;
  threadId: number;
}

interface WorkerDeadMessage {
  type: "dead";
  reason: string;
  stats?: SimSessionStats;
  threadId?: number;
}

interface WorkerLogMessage {
  type: "log";
  level: "info" | "warn" | "error" | "debug";
  args: unknown[];
}

type WorkerInboundMessage =
  | WorkerResponseMessage
  | WorkerReadyMessage
  | WorkerStatsMessage
  | WorkerDeadMessage
  | WorkerLogMessage;

interface PendingRequest {
  resolve: (stats: SimSessionStats) => void;
  reject: (err: Error) => void;
}

function getWorkerModuleURL(): URL {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./threaded-session-worker.${ext}`, import.meta.url);
}

function getWorkerExecArgv(): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i];
    if (!arg) continue;
    if (arg === "--input-type") {
      i += 1;
      continue;
    }
    if (arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--input-type=")) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function cloneStats(stats: SimSessionStats): SimSessionStats {
  return { ...stats };
}

export class ThreadedSimSession {
  readonly roomKey: string;
  readonly gameUrl: string;

  private logger: SimManagerLogger;
  private worker: Worker;
  private requestSeq = 0;
  private pending = new Map<number, PendingRequest>();
  private deadCallbacks: Array<(session: ThreadedSimSession) => void> = [];
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private terminated = false;
  private _id = "";
  private _userId = "";
  private _threadId = 0;
  private _stats: SimSessionStats;

  constructor(
    opts: Omit<SimSessionOptions, "logger" | "warmPool">
      & { logger: SimManagerLogger }
  ) {
    this.roomKey = opts.roomKey;
    this.gameUrl = opts.gameUrl;
    this.logger = opts.logger;
    this._stats = {
      id: "",
      roomKey: opts.roomKey,
      gameUrl: opts.gameUrl,
      userId: "",
      active: false,
      mode: "reserve",
      lifecycle: "new",
      tickRate: opts.tickRate || config.sim.defaultTickRate,
      phase: "lobby",
      relay: false,
      relayDisconnects: 0,
      queuedActions: 0,
      players: 0,
      stateBytes: 0,
      startedAt: 0,
      reservedAt: 0,
      activatedAt: 0,
      uptimeMs: 0,
      idleMs: 0,
      htmlSize: 0,
      observedAt: Date.now(),
      workerIsolation: true,
      workerThreadId: 0,
    };

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.worker = new Worker(getWorkerModuleURL(), {
      workerData: {
        roomKey: opts.roomKey,
        gameUrl: opts.gameUrl,
        relayWsUrl: opts.relayWsUrl,
        tickRate: opts.tickRate,
        startAction: opts.startAction,
        preparedSource: opts.preparedSource,
      },
      execArgv: getWorkerExecArgv(),
      name: `sim:${opts.roomKey}`,
    });

    this.worker.on("message", (msg: WorkerInboundMessage) =>
      this.handleMessage(msg)
    );
    this.worker.on("error", (err) => {
      this.logger.error(
        `[sim-worker] worker error room=${this.roomKey}: ${err.message}`
      );
      this.failAll(err);
      this.notifyDead("worker_error");
    });
    this.worker.on("exit", (code) => {
      if (this.terminated) return;
      const reason = code === 0 ? "worker_exit" : `worker_exit_${code}`;
      this.logger.warn(
        `[sim-worker] worker exited room=${this.roomKey} code=${code}`
      );
      this.failAll(new Error(`sim worker exited with code ${code}`));
      this.notifyDead(reason);
    });
  }

  get id(): string {
    return this._id;
  }

  get userId(): string {
    return this._userId;
  }

  get active(): boolean {
    return !!this._stats.active;
  }

  get mode(): SimSessionMode | "stopped" {
    return this._stats.mode;
  }

  get stats(): SimSessionStats {
    return cloneStats(this._stats);
  }

  onDead(cb: (session: ThreadedSimSession) => void): void {
    this.deadCallbacks.push(cb);
  }

  async ensureReserved(): Promise<void> {
    await this.sendCommand("ensureReserved");
  }

  async ensureActive(): Promise<void> {
    await this.sendCommand("ensureActive");
  }

  async stop(): Promise<void> {
    if (this.terminated) return;
    try {
      await this.sendCommand("stop");
    } catch {
      // ignore stop errors; worker may already be gone
    }
    await this.terminateWorker();
  }

  isExpired(): boolean {
    if (!this.active) return false;
    const stats = this._stats;
    const elapsedSinceObservation = Math.max(
      0,
      Date.now() - (stats.observedAt || Date.now())
    );
    const effectiveIdleMs = (stats.idleMs || 0) + elapsedSinceObservation;
    if (this.mode === "reserve") {
      if (
        stats.reservedAt > 0 &&
        Date.now() - stats.reservedAt > config.sim.reserveMaxTtlMs
      ) {
        return true;
      }
      return effectiveIdleMs > config.sim.reserveIdleTimeoutMs;
    }
    if (stats.startedAt > 0 && Date.now() - stats.startedAt > config.sim.maxTtlMs) {
      return true;
    }
    return effectiveIdleMs > config.sim.idleTimeoutMs;
  }

  private async sendCommand(
    command: WorkerCommandMessage["command"]
  ): Promise<SimSessionStats> {
    await this.readyPromise;
    if (this.terminated) {
      throw new Error(`sim worker already terminated room=${this.roomKey}`);
    }
    const requestId = ++this.requestSeq;
    return new Promise<SimSessionStats>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({
        type: "command",
        requestId,
        command,
      } satisfies WorkerCommandMessage);
    });
  }

  private handleMessage(msg: WorkerInboundMessage): void {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "ready":
        this._id = msg.sessionId;
        this._userId = msg.userId;
        this._threadId = msg.threadId;
        this.updateStats(msg.stats, msg.threadId);
        this.resolveReady();
        return;
      case "stats":
        this.updateStats(msg.stats, msg.threadId);
        return;
      case "response": {
        const pending = this.pending.get(msg.requestId);
        if (!pending) return;
        this.pending.delete(msg.requestId);
        if (msg.stats) {
          this.updateStats(msg.stats);
        }
        if (msg.sessionId) this._id = msg.sessionId;
        if (msg.userId) this._userId = msg.userId;
        if (!msg.ok) {
          pending.reject(
            new Error(msg.error || `sim worker command failed: ${msg.requestId}`)
          );
          return;
        }
        pending.resolve(this.stats);
        return;
      }
      case "dead":
        if (msg.stats) {
          this.updateStats(msg.stats, msg.threadId || this._threadId);
        }
        this.notifyDead(msg.reason || "worker_dead");
        return;
      case "log": {
        const level = msg.level || "info";
        const fn = this.logger[level] || this.logger.info;
        fn.apply(this.logger, msg.args || []);
        return;
      }
    }
  }

  private updateStats(stats: SimSessionStats, threadId = this._threadId): void {
    this._stats = {
      ...stats,
      workerIsolation: true,
      workerThreadId: threadId || stats.workerThreadId || 0,
    };
  }

  private failAll(err: Error): void {
    if (this._id === "") {
      this.rejectReady(err);
    }
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  private notifyDead(reason: string): void {
    if (this.terminated) return;
    this.terminated = true;
    this._stats = {
      ...this._stats,
      active: false,
      mode: "stopped",
      lifecycle: "stopped",
      observedAt: Date.now(),
      workerIsolation: true,
      workerThreadId: this._threadId,
    };
    this.worker.terminate().catch(() => {});
    for (const cb of this.deadCallbacks) {
      try {
        cb(this);
      } catch {
        // ignore callback errors
      }
    }
    this.logger.warn(
      `[sim-worker] session dead room=${this.roomKey} reason=${reason}`
    );
  }

  private async terminateWorker(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    this.failAll(new Error(`sim worker terminated room=${this.roomKey}`));
    await this.worker.terminate();
    this._stats = {
      ...this._stats,
      active: false,
      mode: "stopped",
      lifecycle: "stopped",
      observedAt: Date.now(),
      workerIsolation: true,
      workerThreadId: this._threadId,
    };
  }
}
