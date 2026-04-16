function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  port: parseInt(env("PORT", "3300")),
  logLevel: env("LOG_LEVEL", "info"),

  api: {
    internalSecret: env(
      "SIM_SERVICE_SECRET",
      env("RELAY_SIM_SERVICE_SECRET", "")
    ),
  },

  relay: {
    wsUrl: env("RELAY_WS_URL", "wss://sg-relay-1.sharky.gg/ws"),
  },

  sim: {
    botNamePrefix: env("SIM_BOT_NAME", "SimBot"),
    defaultTickRate: parseInt(env("SIM_DEFAULT_TICK_RATE", "30")),
    maxTickRate: parseInt(env("SIM_MAX_TICK_RATE", "60")),
    maxTtlMs: parseInt(env("SIM_MAX_TTL_MS", "2400000")),
    idleTimeoutMs: parseInt(env("SIM_IDLE_TIMEOUT_MS", "600000")),
    reserveMaxTtlMs: parseInt(env("SIM_RESERVE_MAX_TTL_MS", "120000")),
    reserveIdleTimeoutMs: parseInt(
      env("SIM_RESERVE_IDLE_TIMEOUT_MS", "60000")
    ),
    fetchTimeoutMs: parseInt(env("SIM_FETCH_TIMEOUT_MS", "5000")),
    maxHtmlBytes: parseInt(env("SIM_MAX_HTML_BYTES", "2000000")),
    sourceCacheEnabled:
      env("SIM_SOURCE_CACHE_ENABLED", "1").trim() !== "0",
    sourceCacheTtlMs: parseInt(env("SIM_SOURCE_CACHE_TTL_MS", "300000")),
    sourceCacheMaxEntries: parseInt(
      env("SIM_SOURCE_CACHE_MAX_ENTRIES", "64")
    ),
    sourceCacheMaxBytes: parseInt(
      env("SIM_SOURCE_CACHE_MAX_BYTES", "33554432")
    ),
    defaultStartAction: env("SIM_DEFAULT_START_ACTION", "START"),
    warmPoolSize: parseInt(env("SIM_WARM_POOL_SIZE", "2")),
    workerThreadsEnabled:
      env("SIM_WORKER_THREADS_ENABLED", "0").trim() !== "0",
    workerStatsIntervalMs: parseInt(
      env("SIM_WORKER_STATS_INTERVAL_MS", "1000")
    ),
    workerUnresponsiveTimeoutMs: parseInt(
      env("SIM_WORKER_UNRESPONSIVE_TIMEOUT_MS", "5000")
    ),
    runtimeStepWarnMs: parseInt(env("SIM_RUNTIME_STEP_WARN_MS", "25")),
    runtimeStepHardMs: parseInt(env("SIM_RUNTIME_STEP_HARD_MS", "120")),
    runtimeMaxOverruns: parseInt(env("SIM_RUNTIME_MAX_OVERRUNS", "2")),
  },
} as const;
