# sim-service

Server-authoritative game simulation sidecar for Sharky: loads game HTML in a sandbox, runs `initState` / `onAction` / `onTick`, and syncs state via the relay WebSocket as `sim-bot-*`.

## Requirements

- Node.js 20+
- A relay instance reachable at `RELAY_WS_URL` (must match the region games use)
- Shared secret `SIM_SERVICE_SECRET` — must match gateway `RELAY_SIM_SERVICE_SECRET` / relay config

## Configuration

Copy `.env.example` to `.env` and set variables (never commit `.env`).

For PM2, export secrets before start, e.g.:

```bash
export SIM_SERVICE_SECRET='your-long-random-secret'
pm2 start ecosystem.config.cjs
```

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
