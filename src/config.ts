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
    defaultStartAction: env("SIM_DEFAULT_START_ACTION", "START"),
    warmPoolSize: parseInt(env("SIM_WARM_POOL_SIZE", "2")),
  },
} as const;
