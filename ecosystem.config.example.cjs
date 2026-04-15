/**
 * 复制为 ecosystem.config.cjs 或 ecosystem.config.<env>.cjs（如 sg-lab），填写密钥与 RELAY 地址。
 * 这些文件已加入 .gitignore，勿提交。
 * 部署：./deploy.sh --env sg-lab 会把 ecosystem.config.sg-lab.cjs 拷到远端 ecosystem.config.cjs
 */
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
        // 须与网关 RELAY_SIM_SERVICE_SECRET / relay 配置一致
        SIM_SERVICE_SECRET: "replace-with-long-random-secret",
        // 与 relay 同机部署可用 ws://127.0.0.1:8090/ws；跨机用 wss://your-relay.example.com/ws
        RELAY_WS_URL: "wss://your-relay.example.com/ws",
        SIM_BOT_NAME: "SimBot",
        SIM_DEFAULT_TICK_RATE: "30",
        SIM_MAX_TICK_RATE: "60",
        SIM_MAX_TTL_MS: "2400000",
        SIM_IDLE_TIMEOUT_MS: "600000",
        SIM_RESERVE_MAX_TTL_MS: "120000",
        SIM_RESERVE_IDLE_TIMEOUT_MS: "60000",
        SIM_FETCH_TIMEOUT_MS: "5000",
        SIM_MAX_HTML_BYTES: "2000000",
        SIM_DEFAULT_START_ACTION: "START",
        SIM_WARM_POOL_SIZE: "2",
      },
    },
  ],
};
