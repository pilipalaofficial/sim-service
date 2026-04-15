import { config } from "../config.js";
import { simMetrics } from "../metrics.js";
import {
  SimSession,
  type SimSessionMode,
  type SimSessionOptions,
} from "./session.js";
import { SandboxWarmPool } from "./warm-pool.js";

export interface SimManagerLogger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
}

export class SimManager {
  private sessions = new Map<string, SimSession>();
  private inflightTransitions = new Map<string, Promise<SimSession>>();
  private logger: SimManagerLogger;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private warmPool: SandboxWarmPool;

  static readonly GC_INTERVAL_MS = 60_000;

  constructor(logger: SimManagerLogger) {
    this.logger = logger;
    this.warmPool = new SandboxWarmPool(logger, config.sim.warmPoolSize);
    this.gcTimer = setInterval(() => this.gc(), SimManager.GC_INTERVAL_MS);
  }

  private gc(): void {
    const before = this.sessions.size;
    for (const [roomKey, session] of this.sessions) {
      if (!session.active || session.isExpired()) {
        this.logger.info(
          `[sim-manager] GC reaping room=${roomKey} mode=${session.mode} active=${session.active} expired=${session.isExpired()}`
        );
        session.stop().catch(() => {});
        this.sessions.delete(roomKey);
      }
    }
    const reaped = before - this.sessions.size;
    if (reaped > 0) {
      this.logger.info(
        `[sim-manager] GC done: reaped=${reaped} remaining=${this.sessions.size}`
      );
    }
  }

  async join(
    roomKey: string,
    opts: Omit<SimSessionOptions, "roomKey" | "logger" | "warmPool"> & {
      logger?: SimManagerLogger;
      mode?: SimSessionMode;
    }
  ): Promise<SimSession> {
    const targetMode = opts.mode || "active";
    simMetrics.recordJoinRequest(targetMode);
    const inflight = this.inflightTransitions.get(roomKey);
    if (inflight) {
      this.logger.info(
        `[sim-manager] transition already inflight room=${roomKey} target=${targetMode}`
      );
      await inflight;
      return this.join(roomKey, opts);
    }

    const existing = this.sessions.get(roomKey);
    if (existing?.active) {
      if (targetMode === "reserve" || existing.mode === "active") {
        return existing;
      }
    }
    if (existing && !existing.active) {
      this.sessions.delete(roomKey);
    }

    const transition = (async () => {
      const startedAt = Date.now();
      let session = this.sessions.get(roomKey);
      let createdSession = false;
      if (!session || !session.active) {
        if (session && !session.active) {
          this.sessions.delete(roomKey);
        }
        session = new SimSession({
          roomKey,
          gameUrl: opts.gameUrl,
          relayWsUrl: opts.relayWsUrl,
          tickRate: opts.tickRate,
          startAction: opts.startAction,
          logger: opts.logger || this.logger,
          warmPool: this.warmPool,
        });
        session.onDead((s) => {
          this.logger.warn(
            `[sim-manager] session dead room=${s.roomKey} id=${s.id}`
          );
          this.sessions.delete(s.roomKey);
          this.logger.info(
            `[sim-manager] removed dead session (total=${this.sessions.size})`
          );
        });
        this.sessions.set(roomKey, session);
        createdSession = true;
      }

      try {
        await this.ensureSessionMode(session, targetMode);
        const stats = session.stats;
        if (targetMode === "reserve" && createdSession) {
          simMetrics.observeReservePrepareMs(Date.now() - startedAt);
        }
        if (targetMode === "active") {
          const path = createdSession ? "cold_start" : "reserve_hit";
          simMetrics.recordActivation(path, Date.now() - startedAt);
          if (
            path === "reserve_hit" &&
            stats.reservedAt > 0 &&
            stats.activatedAt > stats.reservedAt
          ) {
            simMetrics.observeReserveToActiveMs(
              stats.activatedAt - stats.reservedAt
            );
          }
        }
        this.logger.info(
          `[sim-manager] ready room=${roomKey} mode=${session.mode} (total=${this.sessions.size})`
        );
        return session;
      } catch (err) {
        if (this.sessions.get(roomKey) === session) {
          this.sessions.delete(roomKey);
        }
        await session.stop().catch(() => {});
        throw err;
      }
    })();

    this.inflightTransitions.set(roomKey, transition);
    try {
      return await transition;
    } finally {
      if (this.inflightTransitions.get(roomKey) === transition) {
        this.inflightTransitions.delete(roomKey);
      }
    }
  }

  async leave(roomKey: string): Promise<boolean> {
    const inflight = this.inflightTransitions.get(roomKey);
    if (inflight) {
      try {
        await inflight;
      } catch {
        // ignore failed transition; session may already be gone
      }
    }

    const session = this.sessions.get(roomKey);
    if (!session) return false;
    await session.stop();
    this.sessions.delete(roomKey);
    this.logger.info(
      `[sim-manager] left room=${roomKey} (total=${this.sessions.size})`
    );
    return true;
  }

  getSession(roomKey: string): SimSession | undefined {
    return this.sessions.get(roomKey);
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => s.stats);
  }

  get status() {
    let reservedSims = 0;
    let activeSims = 0;
    for (const session of this.sessions.values()) {
      if (!session.active) continue;
      if (session.mode === "active") {
        activeSims++;
      } else {
        reservedSims++;
      }
    }
    return {
      sessions: this.sessions.size,
      reservedSims,
      activeSims,
      warmingSims: this.inflightTransitions.size,
      warmPool: this.warmPool.status,
    };
  }

  async shutdown(): Promise<void> {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    for (const [roomKey, session] of this.sessions) {
      await session.stop();
      this.sessions.delete(roomKey);
    }
    this.logger.info("[sim-manager] all sessions stopped");
  }

  private async ensureSessionMode(
    session: SimSession,
    targetMode: SimSessionMode
  ): Promise<void> {
    if (targetMode === "reserve") {
      await session.ensureReserved();
      return;
    }
    await session.ensureActive();
  }
}
