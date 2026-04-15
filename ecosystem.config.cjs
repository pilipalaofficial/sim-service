module.exports = {
  apps: [
    {
      name: "sim-service",
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        PORT: "3500",
        LOG_LEVEL: "info",
        SIM_SERVICE_SECRET: "replace-with-long-random-secret",
        RELAY_WS_URL: "wss://sg-relay-1.sharky.gg/ws",
        SIM_BOT_NAME: "SimBot",
        SIM_DEFAULT_TICK_RATE: "20",
        SIM_MAX_TICK_RATE: "60",
        SIM_MAX_TTL_MS: "2400000",
        SIM_IDLE_TIMEOUT_MS: "600000",
        SIM_RESERVE_MAX_TTL_MS: "120000",
        SIM_RESERVE_IDLE_TIMEOUT_MS: "60000",
        SIM_FETCH_TIMEOUT_MS: "5000",
        SIM_MAX_HTML_BYTES: "2000000",
        SIM_DEFAULT_START_ACTION: "START",
        SIM_WARM_POOL_SIZE: "2"
      },
    },
  ],
};
