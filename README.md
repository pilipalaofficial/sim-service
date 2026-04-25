# sim-service

Server-authoritative game simulation sidecar for Sharky: loads game HTML in a sandbox, runs `initState` / `onAction` / `onTick`, and syncs state via the relay WebSocket as `sim-bot-*`.

## Requirements

- Node.js 20+
- A relay instance reachable at `RELAY_WS_URL` (must match the region games use)
- Shared secret `SIM_SERVICE_SECRET` — must match gateway `RELAY_SIM_SERVICE_SECRET` / relay config

## Runtime AI

Generated server-authoritative games can call Runtime AI lanes:
`ctx.requestFlavor/getFlavor`, `ctx.requestJudge/getJudge`,
`ctx.requestDirector/getDirectorProposal`, and `ctx.requestContent/getContent`.
To use real AI instead of deterministic fallbacks, point sim-service at the
internal Runtime AI resolver:

```bash
SIM_AI_ENABLED=1
SIM_AI_URL=https://your-api.example.com/api/runtime-ai/resolve
# Legacy alias still works if SIM_AI_URL is unset:
# SIM_AI_FLAVOR_URL=https://your-api.example.com/api/runtime-ai/resolve
SIM_AI_SECRET=the-same-secret-configured-as-RUNTIME_AI_INTERNAL_SECRET
SIM_AI_TIMEOUT_MS=12000
SIM_AI_MAX_TOKENS=180
```

If this is not configured, sim-service stays safe and resolves each lane through
its deterministic fallback (`fallbackText`, `fallbackData`, `unresolved`, or no
director proposal).

## Runtime Contract

`sim-service` imports `@delta/runtime-contract` and checks its sandbox `simCtx`
against the contract when each sim session is created.

- `serverSim: "implemented"` APIs must be present in `simCtx`.
- `serverSim: "fallback"` / `"noop"` APIs are filled with safe deterministic
  defaults if the sandbox does not provide a custom implementation.
- `serverSim: "unsupported"` APIs are intentionally not required; generated
  games should be blocked by `claude-game-maker` validation before they reach
  sim-service.

When the SDK adds a new `ctx.*` API, update and publish
`@delta/runtime-contract` first, then deploy sim-service with the updated
dependency. This prevents the server simulator from silently running a game
that depends on an unknown runtime lane.

The build runs `scripts/check-runtime-contract-locks.mjs` before TypeScript.
It fails if `package.json`, `package-lock.json`, and `pnpm-lock.yaml` point to
different runtime-contract tarballs.

## Platform Bot

`server_sim` games can request a platform-managed AI player with:

```js
const botId = ctx.spawnBot({ name: 'sharky' })
```

The default bot id is `ai-agent-sharky`. It is included in `state.players` and
`ctx.getPlayers()`, while `ctx.isBot(botId)` returns `true`. Game code still owns
the gameplay decisions for the bot, typically by updating the bot player's state
deterministically in `onTick`.

For broad game coverage, generated games can describe a bot decision as a
blackboard instead of relying on a game-specific bot template:

```js
ctx.setBotBlackboard(botId, {
  kind: 'grid', // or 'target' / 'choice'
  self: { x: bot.x, y: bot.y },
  targets: state.goals,
  hazards: state.walls,
  width: state.gridW,
  height: state.gridH,
  actions: legalActions,
  fallbackAction: { type: 'WAIT' },
})
const action = ctx.getBotAction(botId)
```

`sim-service` deterministically picks from the provided legal actions. The game
still applies the returned action through its own rules, so this supports grid
movement, continuous targeting, turn-based choices, cards, votes, and board-game
move pickers without baking per-game templates into the platform.

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
