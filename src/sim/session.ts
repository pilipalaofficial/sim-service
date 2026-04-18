import { randomUUID } from "node:crypto";
import {
  RelayClient,
  type NetworkBootstrap,
  type RelayMessage,
} from "../relay/client.js";
import { config } from "../config.js";
import {
  loadSimRuntime,
  type LoadedSimRuntime,
  type PreparedGameSource,
  type SimSandboxLogger,
} from "./sandbox.js";
import type { SandboxWarmPool } from "./warm-pool.js";

export interface SimSessionOptions {
  roomKey: string;
  gameUrl: string;
  relayWsUrl?: string;
  tickRate?: number;
  startAction?: string;
  logger: SimSandboxLogger;
  warmPool?: SandboxWarmPool;
  preparedSource?: PreparedGameSource | null;
}

export type SimSessionMode = "reserve" | "active";
type SimLifecycle =
  | "new"
  | "reserving"
  | "reserved"
  | "activating"
  | "active"
  | "stopped";

export interface SimSessionStats {
  id: string;
  roomKey: string;
  gameUrl: string;
  userId: string;
  active: boolean;
  mode: SimSessionMode | "stopped";
  lifecycle: SimLifecycle;
  tickRate: number;
  snapshotRateHz: number;
  phase: "lobby" | "playing" | "result";
  relay: boolean;
  relayDisconnects: number;
  queuedActions: number;
  players: number;
  stateBytes: number;
  startedAt: number;
  reservedAt: number;
  activatedAt: number;
  uptimeMs: number;
  idleMs: number;
  htmlSize: number;
  observedAt: number;
  workerIsolation?: boolean;
  workerThreadId?: number;
}

interface SimPlayerInfo {
  user_id: string;
  role?: string;
  name?: string;
  display_name?: string;
  online?: boolean;
  spectator?: boolean;
}

interface QueuedAction {
  action: Record<string, any>;
  userId: string;
  inputId: number | null;
}

const BOT_PREFIXES = ["ai-agent-", "stream-bot-", "sim-bot-"];

function isBotUser(userId: string): boolean {
  return BOT_PREFIXES.some((p) => userId.startsWith(p));
}

// Default PHASE_MACHINE matches assembled game-sdk.js (lobby / playing / result).
const PHASE_MACHINE = ["lobby", "playing", "result"] as const;

/**
 * Same rules as game-sdk.js `mapToSdkPhase` + `PHASE_ALIASES` for the default machine.
 * Returns null if the string is not a known phase or alias (SDK also skips phase change then).
 */
function mapToSdkPhase(p: string | undefined): "lobby" | "playing" | "result" | null {
  if (!p || typeof p !== "string") return null;
  const lp = p.toLowerCase().trim();
  if ((PHASE_MACHINE as readonly string[]).includes(lp)) {
    return lp as "lobby" | "playing" | "result";
  }
  const PHASE_LOBBY = PHASE_MACHINE[0];
  const PHASE_PLAYING = PHASE_MACHINE[1];
  const PHASE_RESULT = PHASE_MACHINE[2];
  const PHASE_ALIASES: Record<string, (typeof PHASE_MACHINE)[number]> = {
    waiting: PHASE_LOBBY,
    wait: PHASE_LOBBY,
    idle: PHASE_LOBBY,
    play: PHASE_PLAYING,
    active: PHASE_PLAYING,
    running: PHASE_PLAYING,
    started: PHASE_PLAYING,
    ended: PHASE_RESULT,
    end: PHASE_RESULT,
    finished: PHASE_RESULT,
    gameover: PHASE_RESULT,
    game_over: PHASE_RESULT,
    done: PHASE_RESULT,
  };
  const mapped = PHASE_ALIASES[lp];
  return mapped !== undefined ? mapped : null;
}

function clampTickRate(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return config.sim.defaultTickRate;
  return Math.min(Math.max(Math.round(v), 1), config.sim.maxTickRate);
}

function clampSnapshotRate(v: number, tickRate: number): number {
  const maxRate = Math.max(1, Math.min(config.sim.maxSnapshotRate, tickRate));
  if (!Number.isFinite(v) || v <= 0) {
    return Math.max(1, Math.min(config.sim.defaultSnapshotRate, maxRate));
  }
  return Math.min(Math.max(Math.round(v), 1), maxRate);
}

// Predict+reconcile games need the authoritative snapshot rate to keep up with
// the tick rate, otherwise every intermediate tick is silently dropped and
// clients see a visible snap on each correction (common symptom: discrete grid
// movers like snake feel extremely judder-y on every turn). These floors are
// independent of whatever the game HTML shipped as `snapshotRateHz`, so we can
// salvage games already published with a too-low value without republishing
// them.
const PREDICT_RECONCILE_SNAPSHOT_FLOOR_HZ = 15;
const PREDICT_RECONCILE_HIGH_TICK_THRESHOLD_HZ = 20;

function applyPredictReconcileSnapshotFloor(
  requested: number,
  gameConfig: Record<string, any> | null,
  tickRate: number
): number {
  const profileClass = gameConfig?.networkProfile?.class;
  const usesContinuousTick =
    !!(gameConfig && typeof gameConfig.onTick === "function") ||
    gameConfig?.networkProfile?.usesContinuousTick === true;
  if (profileClass !== "predict_reconcile" || !usesContinuousTick) {
    return requested;
  }
  // High-tick games (>= 20Hz) need snapshotRate == tickRate to stay smooth —
  // anything less drops intermediate ticks before they ever reach the client.
  const floor =
    tickRate >= PREDICT_RECONCILE_HIGH_TICK_THRESHOLD_HZ
      ? tickRate
      : Math.min(tickRate, PREDICT_RECONCILE_SNAPSHOT_FLOOR_HZ);
  if (requested < floor) return floor;
  return requested;
}

function deriveSnapshotRateHz(
  gameConfig: Record<string, any> | null,
  tickRate: number
): number {
  const explicit = Number(gameConfig?.snapshotRateHz);
  let requested: number;
  if (Number.isFinite(explicit) && explicit > 0) {
    requested = explicit;
  } else {
    const usesContinuousTick =
      !!(gameConfig && typeof gameConfig.onTick === "function") ||
      gameConfig?.networkProfile?.usesContinuousTick === true;
    if (usesContinuousTick && tickRate > config.sim.defaultSnapshotRate) {
      requested = config.sim.defaultSnapshotRate;
    } else {
      requested = tickRate;
    }
  }
  const raised = applyPredictReconcileSnapshotFloor(
    requested,
    gameConfig,
    tickRate
  );
  return clampSnapshotRate(raised, tickRate);
}

function safeClone<T>(v: T): T {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

function shallowCloneRecord(
  value: Record<string, any> | null | undefined
): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function fingerprintJson(json: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${json.length}:${(hash >>> 0).toString(16)}`;
}

function normalizeInputId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

export class SimSession {
  readonly id: string;
  readonly roomKey: string;
  readonly gameUrl: string;
  readonly userId: string;

  private relayClient: RelayClient;
  private runtime: LoadedSimRuntime | null = null;
  private gameConfig: Record<string, any> | null = null;
  private preparedSource: PreparedGameSource | null;
  private logger: SimSandboxLogger;
  private warmPool: SandboxWarmPool | null;
  private lifecycle: SimLifecycle = "new";
  private _startedAt = 0;
  private _reservedAt = 0;
  private _activatedAt = 0;
  private _lastEventAt = 0;
  private _relayDisconnectCount = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickRate: number;
  private snapshotRateHz: number;
  private startAction: string;
  private phase: "lobby" | "playing" | "result" = "lobby";
  private state: Record<string, any> = { players: {}, _phase: "lobby" };
  private players: Record<string, SimPlayerInfo> = {};
  private actionQueue: QueuedAction[] = [];
  private lastProcessedInputs: Record<string, number> = {};
  private lastProcessedInputsSnapshot: Record<string, number> = {};
  private lastProcessedInputsDirty = false;
  private lastStateFingerprint = "";
  private lastStateBytes = 0;
  private pendingSync = false;
  private lastStateSyncAt = 0;
  private lastSyncedPhase: "lobby" | "playing" | "result" | "" = "";
  private simCtx: Record<string, any>;
  private relayHandlersBound = false;
  private _onDeadCallbacks: Array<(session: SimSession) => void> = [];
  private _runtimeConsecutiveOverruns = 0;

  static readonly MAX_RELAY_DISCONNECTS = 6;

  constructor(opts: SimSessionOptions) {
    this.id = randomUUID();
    this.roomKey = opts.roomKey;
    this.gameUrl = opts.gameUrl;
    this.userId = `sim-bot-${this.id.slice(0, 8)}`;
    this.logger = opts.logger;
    this.warmPool = opts.warmPool || null;
    this.preparedSource = opts.preparedSource || null;
    this.tickRate = clampTickRate(opts.tickRate ?? config.sim.defaultTickRate);
    this.snapshotRateHz = clampSnapshotRate(this.tickRate, this.tickRate);
    this.startAction =
      String(opts.startAction || config.sim.defaultStartAction || "START") ||
      "START";

    const wsUrl = opts.relayWsUrl || config.relay.wsUrl;
    this.relayClient = new RelayClient({
      wsUrl,
      roomKey: opts.roomKey,
      userId: this.userId,
      role: "client",
      name: `${config.sim.botNamePrefix}-${this.id.slice(0, 6)}`,
      syncMode: "server_sim",
      extraQuery: { game_url: this.gameUrl },
      logger: opts.logger,
    });

    this.simCtx = this.buildSimContext();
  }

  onDead(cb: (session: SimSession) => void): void {
    this._onDeadCallbacks.push(cb);
  }

  async start(): Promise<void> {
    await this.ensureActive();
  }

  async ensureReserved(): Promise<void> {
    if (this.lifecycle === "reserved" || this.lifecycle === "active") {
      this._lastEventAt = Date.now();
      return;
    }
    if (this.lifecycle === "reserving" || this.lifecycle === "activating") {
      return;
    }
    if (this.lifecycle === "stopped") {
      throw new Error(`sim session already stopped room=${this.roomKey}`);
    }

    const now = Date.now();
    if (!this._startedAt) {
      this._startedAt = now;
    }
    this._reservedAt = now;
    this._lastEventAt = now;
    this.lifecycle = "reserving";

    const seed = this.warmPool?.acquire() || null;
    const preparedSource = this.preparedSource;
    this.preparedSource = null;
    try {
      this.runtime = await loadSimRuntime(this.gameUrl, this.logger, {
        seed,
        preparedSource,
      });
      if (this.isStopped()) {
        throw new Error(`sim session stopped during reserve room=${this.roomKey}`);
      }
      this.gameConfig = this.runtime.gameConfig;
      if (
        this.gameConfig &&
        typeof this.gameConfig.tickRate === "number" &&
        this.gameConfig.tickRate > 0
      ) {
        this.tickRate = clampTickRate(this.gameConfig.tickRate);
      }
      this.snapshotRateHz = deriveSnapshotRateHz(this.gameConfig, this.tickRate);

      this.callInitState();
      this.pendingSync = true;
      this.lifecycle = "reserved";
      this.logger.info(
        `[sim] reserved id=${this.id} room=${this.roomKey} tick_rate=${this.tickRate} snapshot_rate=${this.snapshotRateHz} game_url=${this.gameUrl}`
      );
    } catch (err) {
      if (!this.isStopped()) {
        this.lifecycle = "new";
      }
      throw err;
    }
  }

  async ensureActive(): Promise<void> {
    if (this.isFullyActive()) {
      this._lastEventAt = Date.now();
      return;
    }
    await this.ensureReserved();
    if (this.isFullyActive()) {
      return;
    }
    if (this.isStopped()) {
      throw new Error(`sim session already stopped room=${this.roomKey}`);
    }

    this.bindRelayHandlers();
    this.lifecycle = "activating";
    this._activatedAt = Date.now();
    this._lastEventAt = this._activatedAt;
    this.relayClient.connect();
    if (!this.tickTimer) {
      this.tickTimer = setInterval(
        () => this.stepTick(),
        Math.max(16, Math.floor(1000 / this.tickRate))
      );
    }
    this.lifecycle = "active";
    this.logger.info(
      `[sim] activated id=${this.id} room=${this.roomKey} tick_rate=${this.tickRate} snapshot_rate=${this.snapshotRateHz}`
    );
  }

  async stop(): Promise<void> {
    if (this.lifecycle === "stopped") return;
    this.lifecycle = "stopped";
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.relayClient.close();
    this.logger.info(`[sim] stopped id=${this.id} room=${this.roomKey}`);
  }

  get active(): boolean {
    return this.lifecycle !== "new" && this.lifecycle !== "stopped";
  }

  get mode(): SimSessionMode | "stopped" {
    if (this.lifecycle === "active" || this.lifecycle === "activating") {
      return "active";
    }
    if (
      this.lifecycle === "reserved" ||
      this.lifecycle === "reserving" ||
      this.lifecycle === "new"
    ) {
      return "reserve";
    }
    return "stopped";
  }

  isExpired(): boolean {
    if (!this.active) return false;
    const now = Date.now();
    if (this.mode === "reserve") {
      if (this._reservedAt > 0 && now - this._reservedAt > config.sim.reserveMaxTtlMs) {
        return true;
      }
      if (now - this._lastEventAt > config.sim.reserveIdleTimeoutMs) {
        return true;
      }
      return false;
    }
    if (now - this._startedAt > config.sim.maxTtlMs) return true;
    if (now - this._lastEventAt > config.sim.idleTimeoutMs) return true;
    return false;
  }

  get stats(): SimSessionStats {
    return {
      id: this.id,
      roomKey: this.roomKey,
      gameUrl: this.gameUrl,
      userId: this.userId,
      active: this.active,
      mode: this.mode,
      lifecycle: this.lifecycle,
      tickRate: this.tickRate,
      snapshotRateHz: this.snapshotRateHz,
      phase: this.phase,
      relay: this.relayClient.connected,
      relayDisconnects: this._relayDisconnectCount,
      queuedActions: this.actionQueue.length,
      players: Object.keys(this.players).length,
      stateBytes: this.lastStateBytes,
      startedAt: this._startedAt,
      reservedAt: this._reservedAt,
      activatedAt: this._activatedAt,
      uptimeMs: this.active ? Date.now() - this._startedAt : 0,
      idleMs: Date.now() - this._lastEventAt,
      htmlSize: this.runtime?.htmlSize ?? 0,
      observedAt: Date.now(),
    };
  }

  private markDead(reason = "unknown"): void {
    this.logger.error(`[sim] marking session dead room=${this.roomKey} reason=${reason}`);
    this.stop().catch(() => {});
    for (const cb of this._onDeadCallbacks) {
      try {
        cb(this);
      } catch {
        // ignore callback errors
      }
    }
  }

  private isStopped(): boolean {
    return this.lifecycle === "stopped";
  }

  private isFullyActive(): boolean {
    return this.lifecycle === "active";
  }

  private observeRuntimeBudget(
    kind: "onAction" | "onTick",
    startedAtMs: number,
    details: Record<string, any> = {}
  ): void {
    const durationMs = Date.now() - startedAtMs;
    const warnMs = Math.max(1, config.sim.runtimeStepWarnMs || 1);
    const hardMs = Math.max(warnMs, config.sim.runtimeStepHardMs || warnMs);
    const maxOverruns = Math.max(1, config.sim.runtimeMaxOverruns || 1);

    if (durationMs >= hardMs) {
      this._runtimeConsecutiveOverruns += 1;
      this.logger.error(
        `[sim] runtime step over budget room=${this.roomKey} kind=${kind} duration_ms=${durationMs} consecutive=${this._runtimeConsecutiveOverruns} details=${JSON.stringify(details)}`
      );
      if (
        durationMs >= hardMs * 4 ||
        this._runtimeConsecutiveOverruns >= maxOverruns
      ) {
        this.markDead("runtime_step_over_budget");
      }
      return;
    }

    this._runtimeConsecutiveOverruns = 0;
    if (durationMs >= warnMs) {
      this.logger.warn(
        `[sim] runtime step slow room=${this.roomKey} kind=${kind} duration_ms=${durationMs} details=${JSON.stringify(details)}`
      );
    }
  }

  private bindRelayHandlers(): void {
    if (this.relayHandlersBound) {
      return;
    }
    this.relayHandlersBound = true;

    this.relayClient.on("bootstrap", (bs: NetworkBootstrap) => {
      this.handleBootstrap(bs);
    });
    this.relayClient.on("message", (msg: RelayMessage) => {
      this.handleRelayMessage(msg);
    });
    this.relayClient.on("connected", () => {
      this._relayDisconnectCount = 0;
      this.flushPendingStateSync("relay_connected");
    });
    this.relayClient.on("disconnected", () => {
      if (this.lifecycle === "stopped") {
        return;
      }
      this._relayDisconnectCount++;
      this.logger.warn(
        `[sim] relay disconnect #${this._relayDisconnectCount} room=${this.roomKey}`
      );
      if (this._relayDisconnectCount >= SimSession.MAX_RELAY_DISCONNECTS) {
        this.logger.error(
          `[sim] relay disconnected too many times room=${this.roomKey}, marking dead`
        );
        this.markDead("relay_disconnect_threshold");
      }
    });
  }

  private buildSimContext(): Record<string, any> {
    const self = this;
    return {
      W: () => 800,
      H: () => 600,
      PHASE_LOBBY: "lobby",
      PHASE_PLAYING: "playing",
      PHASE_RESULT: "result",
      START_ACTION: this.startAction,
      getPhase: () => self.phase,
      setPhase: (next: string) => self.setPhase(next),
      getState: () => self.state,
      isHost: () => true,
      getLocalUserId: () => self.userId,
      getRoomInfo: () => ({
        room_key: self.roomKey,
        sync_mode: "server_sim",
        authority_mode: "server_sim",
      }),
      getPlayers: () => safeClone(self.players),
      getPlayer: (userId: string) => self.players[String(userId)] || null,
      getLocalPlayer: () => null,
      getGamePlayer: (userId: string) =>
        self.state?.players?.[String(userId)] || null,
      canStartGame: () => Object.keys(self.state?.players || {}).length > 0,
      requestStartGame: () => {
        self.enqueueAction({ type: self.startAction }, self.userId, null);
        return true;
      },
      sendAction: (action: unknown) => {
        if (!action || typeof action !== "object") return false;
        self.enqueueAction(action as Record<string, any>, self.userId, null);
        return true;
      },
      hasWorldSpace: () => false,
      getWorldWidth: () => 800,
      getWorldHeight: () => 600,
      toWorldX: (x: number) => Number(x || 0),
      toWorldY: (y: number) => Number(y || 0),
      toScreenX: (x: number) => Number(x || 0),
      toScreenY: (y: number) => Number(y || 0),
      getScaleX: () => 1,
      getScaleY: () => 1,
      showToast: () => {},
      showModal: () => {},
      showTextInput: () => {},
      playSound: () => {},
      setBgm: () => {},
      stopSound: () => {},
      stopBgm: () => {},
      bindStream: () => false,
      onStreamEvent: () => {},
      unbindStream: () => {},
      settleMatch: () => {},
      askAI: async () => ({
        status: "error",
        error: "askAI is unavailable in sim runtime",
      }),
      input: {
        up: false,
        down: false,
        left: false,
        right: false,
        shoot: false,
        aimX: 0,
        aimY: 0,
        aimWorldX: 0,
        aimWorldY: 0,
        keys: {},
        keysJustPressed: {},
        touch: {
          active: false,
          justPressed: false,
          x: 0,
          y: 0,
          worldX: 0,
          worldY: 0,
        },
      },
    };
  }

  private setPhase(next: string): void {
    const mapped = mapToSdkPhase(String(next));
    if (mapped === null) return;
    this.phase = mapped;
    if (!this.state || typeof this.state !== "object") {
      this.state = { players: {} };
    }
    this.state._phase = mapped;
  }

  private callInitState(): void {
    if (!this.gameConfig) {
      this.state = { players: {}, _phase: this.phase };
      return;
    }
    try {
      const next = this.gameConfig.initState?.(this.simCtx);
      if (next && typeof next === "object") {
        this.state = next as Record<string, any>;
      }
    } catch (err) {
      this.logger.warn(`[sim] initState error room=${this.roomKey}`, err);
    }
    this.ensureStateShape();
    this.syncPlayersToState();
  }

  private ensureStateShape(): void {
    if (
      !this.state ||
      typeof this.state !== "object" ||
      Array.isArray(this.state)
    ) {
      this.state = {};
    }
    if (
      !this.state.players ||
      typeof this.state.players !== "object" ||
      Array.isArray(this.state.players)
    ) {
      this.state.players = {};
    }
    const raw = this.state._phase ?? this.state.phase;
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      const mapped = mapToSdkPhase(String(raw));
      if (mapped !== null) {
        this.phase = mapped;
      }
    }
    // server_sim 根治闪烁：与 game-sdk 的 _phase 规则并行，识别「对局已结束」的常用布尔/状态字段。
    // 多数 AI 游戏在结算时只设 gameOver / winner，不写 _phase（本地模式靠全量渲染，不依赖高频网络快照）。
    // 这里一旦进入 result，stepTick 早退，不再推送 tick 级 state_sync。
    this.applyTerminalPhaseFromGameplayFlags();
    this.state._phase = this.phase;
  }

  /** 与 mapToSdkPhase 互补：仅接受明确「已结束」信号，避免猜测业务字段。 */
  private applyTerminalPhaseFromGameplayFlags(): void {
    if (this.phase !== "playing") return;
    const s = this.state;
    if (!s || typeof s !== "object") return;
    if (s.gameOver === true || s.game_over === true || s.ended === true) {
      this.phase = "result";
      return;
    }
    const st = s.status;
    if (typeof st === "string") {
      const u = st.toLowerCase().trim();
      if (u === "finished" || u === "gameover" || u === "ended") {
        this.phase = "result";
      }
    }
  }

  private handleBootstrap(bootstrap: NetworkBootstrap): void {
    if (!bootstrap || typeof bootstrap !== "object") return;
    const rawPlayers = bootstrap.players || {};
    for (const [uid, p] of Object.entries(rawPlayers)) {
      const userId = String((p as any)?.user_id || uid || "");
      if (!userId) continue;
      this.players[userId] = {
        user_id: userId,
        role: String((p as any)?.role || "client"),
        name: String((p as any)?.name || ""),
        online: (p as any)?.online !== false,
        spectator:
          (p as any)?.role === "spectator" ||
          (p as any)?.spectator === true,
      };
    }
    this._lastEventAt = Date.now();
    this.syncPlayersToState();
    this.pushStateSyncIfChanged("bootstrap");
  }

  private handleRelayMessage(msg: RelayMessage): void {
    if (!msg || !msg.type) return;
    this._lastEventAt = Date.now();

    const raw = msg as any;
    switch (msg.type) {
      case "player_action": {
        const relayPayload = raw.payload || raw.action_data || raw.data || {};
        const sourceUserId = String(
          raw.source_user_id ||
            raw.from_user_id ||
            raw.user_id ||
            relayPayload.user_id ||
            raw.from ||
            ""
        );
        const action = relayPayload.action || relayPayload;
        const inputId = normalizeInputId(
          action?.input_id ?? relayPayload?.input_id ?? raw.input_id
        );
        if (!sourceUserId) return;
        this.enqueueAction(action, sourceUserId, inputId);
        this.drainActionQueue();
        this.pushStateSyncIfChanged("player_action");
        return;
      }
      case "player_joined":
      case "player_reconnected": {
        const p = (raw.payload || {}) as SimPlayerInfo;
        const userId = String(p.user_id || "");
        if (!userId) return;
        this.players[userId] = {
          user_id: userId,
          role: p.role || "client",
          name: p.name || p.display_name || "",
          online: true,
          spectator: p.role === "spectator" || p.spectator === true,
        };
        this.syncPlayersToState();
        this.pushStateSyncIfChanged(msg.type);
        return;
      }
      case "player_left":
      case "player_disconnected": {
        const p = (raw.payload || {}) as SimPlayerInfo;
        const userId = String(p.user_id || "");
        if (!userId) return;
        delete this.players[userId];
        if (this.lastProcessedInputs[userId] !== undefined) {
          delete this.lastProcessedInputs[userId];
          this.lastProcessedInputsDirty = true;
        }
        if (this.state?.players && this.state.players[userId]) {
          delete this.state.players[userId];
        }
        this.pushStateSyncIfChanged(msg.type);
        return;
      }
      default:
        return;
    }
  }

  private enqueueAction(
    action: Record<string, any>,
    userId: string,
    inputId: number | null
  ): void {
    const packed =
      action && typeof action === "object"
        ? ({ ...action } as Record<string, any>)
        : { type: String(action || "") };
    this.actionQueue.push({ action: packed, userId, inputId });
    this._lastEventAt = Date.now();
  }

  private ackProcessedInput(userId: string, inputId: number | null): void {
    if (!userId || inputId === null) return;
    const prev = this.lastProcessedInputs[userId] || 0;
    if (inputId > prev) {
      this.lastProcessedInputs[userId] = inputId;
      this.lastProcessedInputsDirty = true;
    }
  }

  private getLastProcessedInputsSnapshot(): Record<string, number> | null {
    if (this.lastProcessedInputsDirty) {
      if (Object.keys(this.lastProcessedInputs).length > 0) {
        this.lastProcessedInputsSnapshot = { ...this.lastProcessedInputs };
      } else {
        this.lastProcessedInputsSnapshot = {};
      }
      this.lastProcessedInputsDirty = false;
    }
    return Object.keys(this.lastProcessedInputsSnapshot).length > 0
      ? this.lastProcessedInputsSnapshot
      : null;
  }

  private drainActionQueue(): void {
    if (!this.gameConfig || typeof this.gameConfig.onAction !== "function") {
      while (this.actionQueue.length > 0) {
        const item = this.actionQueue.shift();
        if (!item) continue;
        this.ackProcessedInput(item.userId, item.inputId);
      }
      this.actionQueue.length = 0;
      return;
    }
    while (this.actionQueue.length > 0) {
      const item = this.actionQueue.shift();
      if (!item) continue;
      const action = item.action || {};
      const kind = String(action.type || "");
      const safeAction = { ...action, type: kind };

      // Mirror game-sdk auto-handling: START → lobby→playing, RESTART → re-init
      if (kind === this.startAction && this.phase === "lobby") {
        this.setPhase("playing");
      }
      if (kind === "RESTART") {
        this.callInitState();
        this.setPhase("lobby");
      }

      const startedAtMs = Date.now();
      try {
        const next = this.gameConfig.onAction(
          this.state,
          safeAction,
          item.userId,
          this.simCtx
        );
        if (next && typeof next === "object" && next !== this.state) {
          this.state = next as Record<string, any>;
        }
      } catch (err) {
        this.logger.warn(
          `[sim] onAction error room=${this.roomKey} action=${kind} user=${item.userId}`,
          err
        );
      } finally {
        this.ackProcessedInput(item.userId, item.inputId);
        this.observeRuntimeBudget("onAction", startedAtMs, {
          action: kind,
          userId: item.userId,
        });
      }
      this.ensureStateShape();
      if (this.isStopped()) {
        return;
      }
    }
  }

  private stepTick(): void {
    if (this.lifecycle !== "active") return;
    this.drainActionQueue();
    if (this.phase === "result") {
      // Result phase: only sync once (handled by drainActionQueue/setPhase),
      // then stop ticking to avoid redundant state_sync that causes flickering.
      return;
    }
    if (
      this.phase === "playing" &&
      this.gameConfig &&
      typeof this.gameConfig.onTick === "function"
    ) {
      const dtSec = 1 / this.tickRate;
      const startedAtMs = Date.now();
      try {
        const next = this.gameConfig.onTick(this.state, dtSec, this.simCtx);
        if (next && typeof next === "object" && next !== this.state) {
          this.state = next as Record<string, any>;
        }
      } catch (err) {
        this.logger.warn(`[sim] onTick error room=${this.roomKey}`, err);
      } finally {
        this.observeRuntimeBudget("onTick", startedAtMs, {
          phase: this.phase,
          dt_ms: Math.round(dtSec * 1000),
        });
      }
    }
    if (this.isStopped()) {
      return;
    }
    this.ensureStateShape();
    if (
      this.shouldRefreshIdleOnTick() &&
      Date.now() - this._lastEventAt >= 1000
    ) {
      this._lastEventAt = Date.now();
    }
    this.pushStateSyncIfChanged("tick");
  }

  private shouldIncludeInGameState(userId: string, p: SimPlayerInfo): boolean {
    if (!userId || isBotUser(userId)) return false;
    if (p.role === "spectator" || p.spectator) return false;
    return p.online !== false;
  }

  private shouldRefreshIdleOnTick(): boolean {
    if (this.phase !== "playing") return false;
    // Only trust that humans are present if the relay is actually connected;
    // `players[uid].online` may lag behind real disconnect events.
    if (!this.relayClient.connected) return false;
    const hasHumanParticipants = Object.entries(this.players).some(
      ([userId, info]) => this.shouldIncludeInGameState(userId, info)
    );
    if (!hasHumanParticipants) return false;
    return (
      !!(this.gameConfig && typeof this.gameConfig.onTick === "function") ||
      this.gameConfig?.networkProfile?.usesContinuousTick === true
    );
  }

  private syncPlayersToState(): void {
    this.ensureStateShape();
    const existing = this.state.players || {};
    for (const uid of Object.keys(existing)) {
      const info = this.players[uid];
      if (!info || !this.shouldIncludeInGameState(uid, info)) {
        delete this.state.players[uid];
      }
    }
    for (const [uid, info] of Object.entries(this.players)) {
      if (!this.shouldIncludeInGameState(uid, info)) continue;
      if (this.state.players[uid]) continue;

      let playerState: Record<string, any> = { user_id: uid };
      if (this.gameConfig && typeof this.gameConfig.initPlayer === "function") {
        try {
          const next = this.gameConfig.initPlayer(uid, safeClone(info), this.simCtx);
          if (next && typeof next === "object") {
            playerState = next as Record<string, any>;
          }
        } catch (err) {
          this.logger.warn(
            `[sim] initPlayer error room=${this.roomKey} user=${uid}`,
            err
          );
        }
      }
      this.state.players[uid] = playerState;
    }
  }

  private buildStateSnapshot(): Record<string, any> {
    this.ensureStateShape();
    this.syncPlayersToState();
    const processedInputsSnapshot = this.getLastProcessedInputsSnapshot();
    let projectedState: Record<string, any> = this.state;
    if (
      this.gameConfig &&
      typeof this.gameConfig.buildSyncState === "function"
    ) {
      try {
        const next = this.gameConfig.buildSyncState(this.state, this.simCtx);
        if (next && typeof next === "object" && !Array.isArray(next)) {
          projectedState = next as Record<string, any>;
        }
      } catch (err) {
        this.logger.warn(
          `[sim] buildSyncState error room=${this.roomKey}, falling back to full state`,
          err
        );
      }
    }
    if (!projectedState || typeof projectedState !== "object" || Array.isArray(projectedState)) {
      const fallbackSnapshot: Record<string, any> = {
        players: {},
        _phase: this.phase,
      };
      if (processedInputsSnapshot) {
        fallbackSnapshot._last_processed_inputs = processedInputsSnapshot;
      }
      return fallbackSnapshot;
    }
    const snapshot = shallowCloneRecord(projectedState);
    if (
      !snapshot.players ||
      typeof snapshot.players !== "object" ||
      Array.isArray(snapshot.players)
    ) {
      snapshot.players = {};
    } else {
      snapshot.players = shallowCloneRecord(snapshot.players as Record<string, any>);
    }
    snapshot._phase = this.phase;
    if (processedInputsSnapshot) {
      snapshot._last_processed_inputs = processedInputsSnapshot;
    } else if ("_last_processed_inputs" in snapshot) {
      delete snapshot._last_processed_inputs;
    }
    return snapshot;
  }

  private getSnapshotIntervalMs(): number {
    return Math.max(16, Math.floor(1000 / Math.max(1, this.snapshotRateHz)));
  }

  private shouldForceStateSync(
    reason: string,
    snapshotPhase: "lobby" | "playing" | "result"
  ): boolean {
    if (
      reason === "bootstrap" ||
      reason === "relay_connected" ||
      reason === "player_joined" ||
      reason === "player_reconnected" ||
      reason === "player_left" ||
      reason === "player_disconnected"
    ) {
      return true;
    }
    if (snapshotPhase !== "playing") {
      return true;
    }
    return snapshotPhase !== this.lastSyncedPhase;
  }

  private pushStateSyncIfChanged(reason: string): void {
    const snapshot = this.buildStateSnapshot();
    const snapshotPhase = mapToSdkPhase(String(snapshot._phase || this.phase)) || this.phase;
    const forceSend = this.shouldForceStateSync(reason, snapshotPhase);
    if (!forceSend && this.mode === "active" && this.lastStateSyncAt > 0) {
      const elapsedMs = Date.now() - this.lastStateSyncAt;
      if (elapsedMs < this.getSnapshotIntervalMs()) {
        this.pendingSync = true;
        return;
      }
    }
    let snapshotJson = "";
    try {
      snapshotJson = JSON.stringify(snapshot);
    } catch {
      snapshotJson = "";
    }
    if (!snapshotJson) return;
    const fingerprint = fingerprintJson(snapshotJson);
    if (fingerprint === this.lastStateFingerprint && !this.pendingSync) return;
    this.lastStateFingerprint = fingerprint;
    this.lastStateBytes = snapshotJson.length;
    const payload = `{"type":"state_sync","payload":{"state":${snapshotJson}}}`;
    const sent = this.mode === "active" && this.relayClient.sendRaw(payload);
    if (!sent) {
      this.pendingSync = true;
      return;
    }
    this.pendingSync = false;
    this.lastStateSyncAt = Date.now();
    this.lastSyncedPhase = snapshotPhase;
    if (reason !== "tick") {
      this.logger.debug(
        `[sim] state_sync room=${this.roomKey} reason=${reason} bytes=${snapshotJson.length}`
      );
    }
  }

  private flushPendingStateSync(reason: string): void {
    if (!this.pendingSync) return;
    this.pushStateSyncIfChanged(reason);
  }
}
