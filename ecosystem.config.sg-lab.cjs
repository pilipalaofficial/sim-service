const simPm2MaxMemoryRestart =
  process.env.SIM_PM2_MAX_MEMORY_RESTART || "4G";
const simNodeArgs =
  process.env.SIM_NODE_ARGS || "--max-old-space-size=3072";

module.exports = {
  apps: [
    {
      name: "sim-service",
      script: "dist/index.js",
      interpreter: "node",
      node_args: simNodeArgs,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: simPm2MaxMemoryRestart,
      env: {
        NODE_ENV: "production",
        PORT: "3500",
        LOG_LEVEL: "info",
        // Must match delta2-backend/deploy/envs/sg-lab-relay.env RELAY_SIM_SERVICE_SECRET.
        SIM_SERVICE_SECRET: "123123",
        RELAY_WS_URL: "ws://127.0.0.1:8090/ws",
        SIM_BOT_NAME: "SimBot",
        SIM_DEFAULT_TICK_RATE: "20",
        SIM_MAX_TICK_RATE: "60",
        SIM_DEFAULT_SNAPSHOT_RATE: "12",
        SIM_MAX_SNAPSHOT_RATE: "30",
        SIM_MAX_TTL_MS: "2400000",
        SIM_IDLE_TIMEOUT_MS: "600000",
        SIM_RESERVE_MAX_TTL_MS: "120000",
        SIM_RESERVE_IDLE_TIMEOUT_MS: "60000",
        SIM_FETCH_TIMEOUT_MS: "5000",
        SIM_MAX_HTML_BYTES: "2000000",
        SIM_SOURCE_CACHE_ENABLED: "1",
        SIM_SOURCE_CACHE_TTL_MS: "300000",
        SIM_SOURCE_CACHE_MAX_ENTRIES: "64",
        SIM_SOURCE_CACHE_MAX_BYTES: "33554432",
        SIM_DEFAULT_START_ACTION: "START",
        SIM_WARM_POOL_SIZE: "2",
        SIM_WORKER_THREADS_ENABLED: "1",
        SIM_WORKER_STATS_INTERVAL_MS: "1000",
        SIM_WORKER_UNRESPONSIVE_TIMEOUT_MS: "5000",
        SIM_RUNTIME_STEP_WARN_MS: "25",
        SIM_RUNTIME_STEP_HARD_MS: "120",
        SIM_RUNTIME_MAX_OVERRUNS: "2"
      },
    },
  ],
};
