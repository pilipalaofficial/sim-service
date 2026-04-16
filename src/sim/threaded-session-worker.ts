import { parentPort, threadId, workerData } from "node:worker_threads";
import { config } from "../config.js";
import { SimSession, type SimSessionOptions } from "./session.js";

interface WorkerCommandMessage {
  type: "command";
  requestId: number;
  command: "ensureReserved" | "ensureActive" | "stop" | "getStats";
}

function ensurePort() {
  if (!parentPort) {
    throw new Error("sim threaded session worker missing parentPort");
  }
  return parentPort;
}

function serializeUnknown(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
}

function createWorkerLogger(roomKey: string) {
  const port = ensurePort();
  const emit = (level: "info" | "warn" | "error" | "debug", args: unknown[]) => {
    port.postMessage({
      type: "log",
      level,
      args: [`[sim-worker][t${threadId}][${roomKey}]`, ...args.map(serializeUnknown)],
    });
  };
  return {
    info: (...args: unknown[]) => emit("info", args),
    warn: (...args: unknown[]) => emit("warn", args),
    error: (...args: unknown[]) => emit("error", args),
    debug: (...args: unknown[]) => emit("debug", args),
  };
}

const port = ensurePort();
const opts = workerData as Omit<SimSessionOptions, "logger" | "warmPool">;
const logger = createWorkerLogger(opts.roomKey);
const session = new SimSession({
  ...opts,
  logger,
});

let commandChain = Promise.resolve();
let statsTimer: ReturnType<typeof setInterval> | null = null;

function emitStats(): void {
  port.postMessage({
    type: "stats",
    threadId,
    stats: {
      ...session.stats,
      workerIsolation: true,
      workerThreadId: threadId,
    },
  });
}

function respond(
  requestId: number,
  ok: boolean,
  error?: string
): void {
  port.postMessage({
    type: "response",
    requestId,
    ok,
    error,
    sessionId: session.id,
    userId: session.userId,
    stats: {
      ...session.stats,
      workerIsolation: true,
      workerThreadId: threadId,
    },
  });
}

function shutdown(reason: string): void {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  port.postMessage({
    type: "dead",
    reason,
    threadId,
    stats: {
      ...session.stats,
      workerIsolation: true,
      workerThreadId: threadId,
    },
  });
}

session.onDead(() => shutdown("session_dead"));

statsTimer = setInterval(
  () => emitStats(),
  Math.max(250, config.sim.workerStatsIntervalMs || 1000)
);

port.postMessage({
  type: "ready",
  sessionId: session.id,
  userId: session.userId,
  threadId,
  stats: {
    ...session.stats,
    workerIsolation: true,
    workerThreadId: threadId,
  },
});

port.on("message", (msg: WorkerCommandMessage) => {
  if (!msg || msg.type !== "command") return;
  commandChain = commandChain
    .then(async () => {
      try {
        switch (msg.command) {
          case "ensureReserved":
            await session.ensureReserved();
            break;
          case "ensureActive":
            await session.ensureActive();
            break;
          case "stop":
            await session.stop();
            if (statsTimer) {
              clearInterval(statsTimer);
              statsTimer = null;
            }
            break;
          case "getStats":
            break;
        }
        respond(msg.requestId, true);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err || "unknown error");
        respond(msg.requestId, false, message);
      }
    })
    .catch((err) => {
      const message =
        err instanceof Error ? err.message : String(err || "unknown error");
      respond(msg.requestId, false, message);
    });
});

process.on("uncaughtException", (err) => {
  logger.error("[sim-worker] uncaughtException", err);
  shutdown("uncaught_exception");
});

process.on("unhandledRejection", (reason) => {
  logger.error("[sim-worker] unhandledRejection", reason);
  shutdown("unhandled_rejection");
});
