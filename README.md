# sim-service

Server-authoritative game simulation sidecar for Sharky: loads game HTML in a sandbox, runs `initState` / `onAction` / `onTick`, and syncs state via the relay WebSocket as `sim-bot-*`.

## Requirements

- Node.js 20+
- A relay instance reachable at `RELAY_WS_URL` (must match the region games use)
- Shared secret `SIM_SERVICE_SECRET` — must match gateway `RELAY_SIM_SERVICE_SECRET` / relay config

## Runtime AI

Generated server-authoritative games can call `ctx.requestFlavor()` / `ctx.getFlavor()` for NPC dialogue, narration, and other lightweight runtime text. To use real AI instead of deterministic fallbacks, point sim-service at the go-backend internal broker:

```bash
SIM_AI_ENABLED=1
SIM_AI_FLAVOR_URL=https://your-api.example.com/internal/runtime-ai/flavor
SIM_AI_SECRET=the-same-secret-configured-as-RUNTIME_AI_INTERNAL_SECRET
SIM_AI_TIMEOUT_MS=12000
SIM_AI_MAX_TOKENS=180
```

If this is not configured, sim-service stays safe and returns each request's `fallbackText`.

## Configuration（systemd）

生产部署现在使用：

- `deploy/envs/<env>.env`
- `deploy/systemd/sim-service.service.tpl`

部署脚本会把对应环境的 `.env` 上传到远端 `/data/sim-service/.env`，再把 systemd unit 安装到 `/etc/systemd/system/sim-service.service`。

当前保留 `ecosystem.config.*.cjs` 仅作历史参考/兼容，不再作为生产托管入口。

## Deploy script

`deploy.sh` expects environment variables for remote access (no hosts or keys are stored in the repo):

```bash
export DEPLOY_SG_LAB_HOST='your.server.ip'
export DEPLOY_SSH_KEY="$HOME/.ssh/id_ed25519"
./deploy.sh --env sg-lab
```

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
