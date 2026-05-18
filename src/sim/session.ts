import { randomUUID } from "node:crypto";
import { CTX_RUNTIME_CONTRACT } from "@delta/runtime-contract";
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
  fallbackGameUrl?: string;
  runtimeAiFlavorUrl?: string;
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
  bot?: boolean;
}

interface QueuedAction {
  action: Record<string, any>;
  userId: string;
  inputId: number | null;
}

interface SimFlavorSlot {
  status: "pending" | "ready" | "failed" | "expired";
  text?: string | null;
  url?: string | null;
  result?: unknown;
  source: "ai" | "fallback";
  error?: string;
}

interface SimJudgeSlot {
  status: "pending" | "ready" | "failed" | "expired";
  verdict: string;
  confidence?: number;
  reason?: string;
  source: "ai" | "fallback";
  error?: string;
}

interface SimDirectorSlot {
  status: "pending" | "ready" | "failed" | "expired";
  proposalType?: string;
  payload?: Record<string, any>;
  rationale?: string;
  source: "ai" | "fallback";
  error?: string;
}

interface SimContentSlot {
  status: "pending" | "ready" | "failed" | "expired";
  data?: any;
  text?: string | null;
  source: "ai" | "fallback";
  error?: string;
}

interface BotPoint {
  x: number;
  y: number;
}

interface BotActionCandidate {
  action: Record<string, any>;
  index: number;
  score: number;
}

type ServerSimRuntimeSupport =
  | "implemented"
  | "supported"
  | "fallback"
  | "noop"
  | "unsupported";

interface ServerSimRuntimeContractEntry {
  serverSim?: ServerSimRuntimeSupport;
  lane?: string;
  capability?: string;
}

const BOT_PREFIXES = ["ai-agent-", "stream-bot-", "sim-bot-"];
const PLATFORM_BOT_PREFIX = "ai-agent-";
const DEFAULT_PLATFORM_BOT_NAME = "sharky";
const COALESCIBLE_CONTINUOUS_ACTIONS = new Set([
  "MOVE",
  "THRUST",
  "TURN",
  "STEER",
  "AIM",
  "LOOK",
  "INPUT",
  "WALK",
  "RUN",
]);
const BOOTSTRAP_ACTION_GATE_TIMEOUT_MS = 1500;

function isBotUser(userId: string): boolean {
  return BOT_PREFIXES.some((p) => userId.startsWith(p));
}

function isPlatformBotInfo(userId: string, info: SimPlayerInfo | undefined): boolean {
  if (!userId || !info) return false;
  return info.bot === true || info.role === "bot";
}

function isGameManagedPlayerState(userId: string, value: unknown): boolean {
  const id = String(userId || "").toLowerCase();
  if (
    id.startsWith("__ai") ||
    id.startsWith("__bot") ||
    id.startsWith("__npc") ||
    id.startsWith("ai_") ||
    id.startsWith("bot_") ||
    id.startsWith("npc_")
  ) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, any>;
  if (
    record.isAI === true ||
    record.isAi === true ||
    record.ai === true ||
    record.isBot === true ||
    record.bot === true ||
    record.isNPC === true ||
    record.npc === true ||
    record.cpu === true ||
    record.isCpu === true
  ) {
    return true;
  }
  const role = String(record.role || record.kind || record.type || "").toLowerCase();
  return role === "ai" || role === "bot" || role === "npc" || role === "cpu";
}

function ensureRngState(state: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const raw = Number(state.rngSeed);
  state.rngSeed = (Number.isFinite(raw) ? raw : 123456789) >>> 0;
  return state;
}

function nextDeterministicRandom(state: Record<string, any> | null | undefined): number {
  const target = ensureRngState(state);
  if (!target) return 0.5;
  const seed = (((target.rngSeed >>> 0) || 123456789) + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  target.rngSeed = seed >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
const HEAVY_CONTINUOUS_MULTIPLAYER_SNAPSHOT_SOFT_LIMIT_BYTES = 16 * 1024;
const HEAVY_CONTINUOUS_MULTIPLAYER_SNAPSHOT_HARD_LIMIT_BYTES = 24 * 1024;
const HEAVY_CONTINUOUS_MULTIPLAYER_SOFT_CAP_HZ = 12;
const HEAVY_CONTINUOUS_MULTIPLAYER_HARD_CAP_HZ = 10;
const HEAVY_CONTINUOUS_LOW_RTT_SOFT_CAP_HZ = 18;
const HEAVY_CONTINUOUS_LOW_RTT_HARD_CAP_HZ = 16;
const HEAVY_CONTINUOUS_MID_RTT_SOFT_CAP_HZ = 14;
const HEAVY_CONTINUOUS_MID_RTT_HARD_CAP_HZ = 12;

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
  readonly fallbackGameUrl?: string;
  readonly runtimeAiFlavorUrl?: string;
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
  private bootstrapReady = false;
  private bootstrapGateWarned = false;
  private roomAvgClientRTTMs = 0;
  private roomMaxClientRTTMs = 0;
  private roomRTTSamples = 0;
  private simCtx: Record<string, any>;
  private relayHandlersBound = false;
  private _onDeadCallbacks: Array<(session: SimSession) => void> = [];
  private _runtimeConsecutiveOverruns = 0;
  private flavorSlots = new Map<string, SimFlavorSlot>();
  private judgeSlots = new Map<string, SimJudgeSlot>();
  private directorSlots = new Map<string, SimDirectorSlot>();
  private contentSlots = new Map<string, SimContentSlot>();
  private botBlackboards = new Map<string, Record<string, any>>();

  static readonly MAX_RELAY_DISCONNECTS = 6;

  constructor(opts: SimSessionOptions) {
    this.id = randomUUID();
    this.roomKey = opts.roomKey;
    this.gameUrl = opts.gameUrl;
    this.fallbackGameUrl = opts.fallbackGameUrl;
    this.runtimeAiFlavorUrl = opts.runtimeAiFlavorUrl;
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
    this.assertRuntimeContractCoverage();
  }

  private setFallbackFlavor(
    key: string,
    fallbackText: string | null,
    fallbackUrl: string | null = null,
    status: "failed" | "expired" = "failed",
    error?: string,
    fallbackResult?: unknown
  ): void {
    const hasFallback = typeof fallbackText === "string" && fallbackText.trim().length > 0;
    const hasUrlFallback = typeof fallbackUrl === "string" && fallbackUrl.trim().length > 0;
    this.flavorSlots.set(key, {
      status: hasFallback || hasUrlFallback ? "ready" : status,
      text: fallbackText,
      url: fallbackUrl,
      result: fallbackResult,
      source: "fallback",
      error,
    });
  }

  private requestRuntimeFlavor(key: string, opts: Record<string, any>): void {
    const flavorType = String(opts.type || "text");
    const fallbackText =
      opts.fallbackText == null ? null : String(opts.fallbackText);
    const fallbackUrl =
      opts.fallbackUrl == null ? null : String(opts.fallbackUrl);
    const fallbackResult =
      Object.prototype.hasOwnProperty.call(opts, "fallbackResult")
        ? opts.fallbackResult
        : undefined;
    const prompt = String(opts.prompt || "").trim();
    const flavorUrl = this.runtimeAiFlavorUrl || config.ai.flavorUrl;
    if (!config.ai.enabled || !flavorUrl || !prompt) {
      this.setFallbackFlavor(
        key,
        fallbackText,
        fallbackUrl,
        "failed",
        prompt ? "runtime ai disabled" : "empty prompt",
        fallbackResult
      );
      return;
    }

    this.flavorSlots.set(key, {
      status: "pending",
      text: fallbackText,
      url: fallbackUrl,
      result: fallbackResult,
      source: "fallback",
    });

    void this.resolveRuntimeFlavor(key, opts, fallbackText, fallbackUrl, flavorType);
  }

  private async resolveRuntimeFlavor(
    key: string,
    opts: Record<string, any>,
    fallbackText: string | null,
    fallbackUrl: string | null,
    flavorType: string
  ): Promise<void> {
    const defaultCap = flavorType === "video" ? 180000 : flavorType === "image" ? 60000 : 12000;
    const configuredCap = config.ai.timeoutMs || defaultCap;
    const timeoutMs = Math.max(
      1000,
      Math.min(
        Number(opts.timeoutMs || configuredCap),
        Math.max(configuredCap, defaultCap)
      )
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const flavorUrl = this.runtimeAiFlavorUrl || config.ai.flavorUrl;
      if (!flavorUrl) {
        this.setFallbackFlavor(
          key,
          fallbackText,
          fallbackUrl,
          "failed",
          "runtime ai url missing",
          opts.fallbackResult
        );
        return;
      }

      const resp = await fetch(flavorUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": config.ai.secret,
        },
        body: JSON.stringify({
          room_key: this.roomKey,
          game_id: this.gameUrl,
          request_id: key,
          type: flavorType,
          prompt: String(opts.prompt || ""),
          fallback_text: fallbackText || "",
          fallback_url: fallbackUrl || "",
          duration: Number(opts.duration || 5),
          max_tokens: Number(opts.maxTokens || config.ai.maxTokens || 180),
          timeout_ms: timeoutMs,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        this.setFallbackFlavor(
          key,
          fallbackText,
          fallbackUrl,
          "expired",
          `ai http ${resp.status}`,
          opts.fallbackResult
        );
        return;
      }

      const body = (await resp.json()) as any;
      if (body?.error_code && Number(body.error_code) !== 0) {
        this.setFallbackFlavor(
          key,
          fallbackText,
          fallbackUrl,
          "failed",
          body?.error_message ? String(body.error_message) : "ai broker error",
          opts.fallbackResult
        );
        return;
      }
      const data = body?.data || body;
      const status = String(data?.status || "");
      const text = data?.text == null ? "" : String(data.text);
      const url = data?.url == null ? "" : String(data.url);
      const source = data?.source === "ai" ? "ai" : "fallback";
      const result =
        data?.result !== undefined
          ? data.result
          : data?.json !== undefined
            ? data.json
            : opts.fallbackResult !== undefined
              ? opts.fallbackResult
              : text;

      if (status === "ready" && (text.trim() || url.trim())) {
        this.flavorSlots.set(key, {
          status: "ready",
          text: text || fallbackText,
          url: url || fallbackUrl,
          result,
          source,
        });
        return;
      }

      this.setFallbackFlavor(
        key,
        text.trim() ? text : fallbackText,
        url.trim() ? url : fallbackUrl,
        status === "expired" ? "expired" : "failed",
        data?.error ? String(data.error) : "ai returned no ready flavor",
        opts.fallbackResult
      );
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      this.setFallbackFlavor(key, fallbackText, fallbackUrl, "expired", message, opts.fallbackResult);
      this.logger.warn(`[sim] runtime ai flavor failed room=${this.roomKey} id=${key}`, err);
    }
  }

  private runtimeAiUrl(): string {
    return this.runtimeAiFlavorUrl || config.ai.runtimeUrl || config.ai.flavorUrl;
  }

  private pickFallbackVerdict(allowedVerdicts: string[]): string {
    const preferred = ["unresolved", "reject", "incorrect", "invalid", "no", "false"];
    for (const verdict of preferred) {
      if (allowedVerdicts.includes(verdict)) return verdict;
    }
    return allowedVerdicts[0] || "unresolved";
  }

  private setFallbackJudge(
    key: string,
    opts: Record<string, any>,
    status: "ready" | "failed" | "expired" = "ready",
    error?: string
  ): void {
    const allowed = Array.isArray(opts.allowedVerdicts)
      ? opts.allowedVerdicts.filter((v: unknown): v is string => typeof v === "string")
      : [];
    this.judgeSlots.set(key, {
      status,
      verdict: this.pickFallbackVerdict(allowed),
      confidence: 0,
      reason: "Runtime AI unavailable; deterministic fallback verdict used.",
      source: "fallback",
      error,
    });
  }

  private setFallbackDirector(
    key: string,
    status: "failed" | "expired" = "failed",
    error?: string
  ): void {
    this.directorSlots.set(key, {
      status,
      source: "fallback",
      rationale: "Runtime AI unavailable; no gameplay adjustment proposal.",
      error,
    });
  }

  private setFallbackContent(
    key: string,
    opts: Record<string, any>,
    status: "ready" | "failed" | "expired" = "ready",
    error?: string
  ): void {
    const hasFallback =
      opts.fallbackData !== undefined ||
      (typeof opts.fallbackText === "string" && opts.fallbackText.length > 0);
    this.contentSlots.set(key, {
      status: hasFallback ? status : "failed",
      data: opts.fallbackData,
      text: opts.fallbackText == null ? null : String(opts.fallbackText),
      source: "fallback",
      error,
    });
  }

  private requestRuntimeJudge(key: string, opts: Record<string, any>): void {
    const url = this.runtimeAiUrl();
    if (!config.ai.enabled || !url) {
      this.setFallbackJudge(key, opts, "ready", "runtime ai disabled");
      return;
    }
    this.judgeSlots.set(key, {
      status: "pending",
      verdict: this.pickFallbackVerdict(
        Array.isArray(opts.allowedVerdicts) ? opts.allowedVerdicts : []
      ),
      source: "fallback",
    });
    void this.resolveRuntimeLane(key, "judge", opts);
  }

  private requestRuntimeDirector(key: string, opts: Record<string, any>): void {
    const url = this.runtimeAiUrl();
    if (!config.ai.enabled || !url) {
      this.setFallbackDirector(key, "failed", "runtime ai disabled");
      return;
    }
    this.directorSlots.set(key, {
      status: "pending",
      source: "fallback",
    });
    void this.resolveRuntimeLane(key, "director", opts);
  }

  private requestRuntimeContent(key: string, opts: Record<string, any>): void {
    const url = this.runtimeAiUrl();
    if (!config.ai.enabled || !url) {
      this.setFallbackContent(key, opts, "ready", "runtime ai disabled");
      return;
    }
    this.contentSlots.set(key, {
      status: "pending",
      data: opts.fallbackData,
      text: opts.fallbackText == null ? null : String(opts.fallbackText),
      source: "fallback",
    });
    void this.resolveRuntimeLane(key, "content", opts);
  }

  private async resolveRuntimeLane(
    key: string,
    lane: "judge" | "director" | "content",
    opts: Record<string, any>
  ): Promise<void> {
    const timeoutMs = Math.max(
      1000,
      Math.min(
        Number(opts.timeoutMs || config.ai.timeoutMs || 12000),
        config.ai.timeoutMs || 12000
      )
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = this.runtimeAiUrl();
      if (!url) {
        this.applyRuntimeLaneFallback(key, lane, opts, "failed", "runtime ai url missing");
        return;
      }
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": config.ai.secret ? `Bearer ${config.ai.secret}` : "",
          "X-Runtime-AI-Secret": config.ai.secret,
          "x-runtime-ai-secret": config.ai.secret,
          "X-Internal-Secret": config.ai.secret,
        },
        body: JSON.stringify({
          id: key,
          lane,
          roomId: this.roomKey,
          room_key: this.roomKey,
          game_id: this.gameUrl,
          phase: this.phase,
          publicInput: opts,
          runtimeSnapshot: {
            phase: this.phase,
            playerCount: Object.keys(this.players).length,
            recentEvents: [],
          },
          timeoutMs,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        this.applyRuntimeLaneFallback(key, lane, opts, "expired", `ai http ${resp.status}`);
        return;
      }

      const body = (await resp.json()) as any;
      if (body?.error_code && Number(body.error_code) !== 0) {
        this.applyRuntimeLaneFallback(
          key,
          lane,
          opts,
          "failed",
          body?.error_message ? String(body.error_message) : "ai broker error"
        );
        return;
      }

      const data = body?.data || body?.result || body;
      const status = String(body?.status || data?.status || "");
      if (status === "failed" || status === "error" || status === "expired") {
        this.applyRuntimeLaneFallback(key, lane, opts, status === "expired" ? "expired" : "failed", data?.error || status);
        return;
      }

      this.commitRuntimeLaneResult(key, lane, opts, data);
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      this.applyRuntimeLaneFallback(key, lane, opts, "expired", message);
      this.logger.warn(`[sim] runtime ai ${lane} failed room=${this.roomKey} id=${key}`, err);
    }
  }

  private applyRuntimeLaneFallback(
    key: string,
    lane: "judge" | "director" | "content",
    opts: Record<string, any>,
    status: "failed" | "expired",
    error?: string
  ): void {
    if (lane === "judge") {
      this.setFallbackJudge(key, opts, status === "expired" ? "expired" : "ready", error);
    } else if (lane === "director") {
      this.setFallbackDirector(key, status, error);
    } else {
      this.setFallbackContent(key, opts, status === "expired" ? "expired" : "ready", error);
    }
  }

  private commitRuntimeLaneResult(
    key: string,
    lane: "judge" | "director" | "content",
    opts: Record<string, any>,
    raw: Record<string, any>
  ): void {
    const payload = raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data)
      ? raw.data
      : raw;
    if (lane === "judge") {
      const allowed = Array.isArray(opts.allowedVerdicts)
        ? opts.allowedVerdicts.filter((v: unknown): v is string => typeof v === "string")
        : [];
      const verdict = typeof payload.verdict === "string" && allowed.includes(payload.verdict)
        ? payload.verdict
        : this.pickFallbackVerdict(allowed);
      this.judgeSlots.set(key, {
        status: "ready",
        verdict,
        confidence: typeof payload.confidence === "number" ? payload.confidence : undefined,
        reason: payload.reason == null ? undefined : String(payload.reason),
        source: "ai",
        error: verdict === payload.verdict ? undefined : "verdict outside allowed set",
      });
      return;
    }
    if (lane === "director") {
      const allowed = Array.isArray(opts.allowedEffects)
        ? opts.allowedEffects.filter((v: unknown): v is string => typeof v === "string")
        : [];
      const proposalType = payload.proposalType == null ? "" : String(payload.proposalType);
      if (!proposalType || !allowed.includes(proposalType)) {
        this.setFallbackDirector(key, "failed", "proposal outside allowed effects");
        return;
      }
      this.directorSlots.set(key, {
        status: "ready",
        proposalType,
        payload: payload.payload && typeof payload.payload === "object" ? payload.payload : undefined,
        rationale: payload.rationale == null ? undefined : String(payload.rationale),
        source: "ai",
      });
      return;
    }
    this.contentSlots.set(key, {
      status: "ready",
      data: payload.data !== undefined ? payload.data : raw?.data,
      text: payload.text == null ? opts.fallbackText ?? null : String(payload.text),
      source: "ai",
    });
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
        fallbackGameUrl: this.fallbackGameUrl,
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
    this.bootstrapReady = false;
    this.bootstrapGateWarned = false;
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
      if (this.bootstrapReady) {
        this.flushPendingStateSync("relay_connected");
      }
    });
    this.relayClient.on("disconnected", () => {
      this.bootstrapReady = false;
      this.bootstrapGateWarned = false;
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
    const ctx: Record<string, any> = {
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
      getNetworkProfile: () => safeClone(self.gameConfig?.networkProfile || {}),
      getPredictionStats: () => ({
        enabled: false,
        corrections: 0,
        lastCorrectionMs: 0,
      }),
      getRelayRTT: () => self.roomAvgClientRTTMs || 0,
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
      hasCapability: (capability: string) => {
        const caps = self.gameConfig?.capabilities;
        return Array.isArray(caps) ? caps.includes(String(capability)) : false;
      },
      sendAction: (action: unknown) => {
        if (!action || typeof action !== "object") return false;
        self.enqueueAction(action as Record<string, any>, self.userId, null);
        return true;
      },
      sendDecisiveEvent: () => false,
      getPendingDecisiveEvents: () => [],
      random: (stateArg?: Record<string, any>) =>
        nextDeterministicRandom(
          stateArg && typeof stateArg === "object" ? stateArg : self.state
        ),
      randomFloat: (min = 0, max = 1, stateArg?: Record<string, any>) => {
        const lo = Number.isFinite(Number(min)) ? Number(min) : 0;
        const hi = Number.isFinite(Number(max)) ? Number(max) : 1;
        return lo + (hi - lo) * nextDeterministicRandom(
          stateArg && typeof stateArg === "object" ? stateArg : self.state
        );
      },
      randomInt: (min: number, max: number, stateArg?: Record<string, any>) => {
        let lo = Math.ceil(Number(min));
        let hi = Math.floor(Number(max));
        if (!Number.isFinite(lo)) lo = 0;
        if (!Number.isFinite(hi)) hi = lo;
        if (hi < lo) [lo, hi] = [hi, lo];
        return lo + Math.floor(nextDeterministicRandom(
          stateArg && typeof stateArg === "object" ? stateArg : self.state
        ) * (hi - lo + 1));
      },
      pickRandom: (items: unknown[], stateArg?: Record<string, any>) => {
        if (!Array.isArray(items) || items.length === 0) return null;
        let lo = 0;
        let hi = items.length - 1;
        const index = lo + Math.floor(nextDeterministicRandom(
          stateArg && typeof stateArg === "object" ? stateArg : self.state
        ) * (hi - lo + 1));
        return items[index] ?? null;
      },
      hasWorldSpace: () => false,
      getWorldWidth: () => 800,
      getWorldHeight: () => 600,
      worldW: () => 800,
      worldH: () => 600,
      toWorldX: (x: number) => Number(x || 0),
      toWorldY: (y: number) => Number(y || 0),
      toScreenX: (x: number) => Number(x || 0),
      toScreenY: (y: number) => Number(y || 0),
      getScaleX: () => 1,
      getScaleY: () => 1,
      scaleX: () => 1,
      scaleY: () => 1,
      dpr: () => 1,
      showToast: () => {},
      showModal: () => {},
      showTextInput: () => {},
      hideTextInput: () => {},
      setHud: () => {},
      setUiTree: () => {},
      setTextInput: () => {},
      clearHud: () => {},
      playSound: () => {},
      stopSound: () => {},
      setBgm: () => {},
      stopBgm: () => {},
      setVolume: () => {},
      bindStream: () => false,
      onStreamEvent: () => {},
      unbindStream: () => {},
      settleMatch: () => {},
      askAI: async () => ({
        status: "error",
        error: "askAI is unavailable in sim runtime",
      }),
      requestAI: (id: string, opts: Record<string, any> = {}) => {
        const key = String(id || "");
        if (!key) return;
        if (self.flavorSlots.get(key)) return;

        const hasFallback = Object.prototype.hasOwnProperty.call(opts, "fallback");
        const fallbackResult = hasFallback ? opts.fallback : undefined;
        let fallbackText =
          opts.fallbackText == null ? null : String(opts.fallbackText);
        if (fallbackText == null && fallbackResult !== undefined && fallbackResult !== null) {
          fallbackText =
            typeof fallbackResult === "string"
              ? fallbackResult
              : JSON.stringify(fallbackResult);
        }

        self.requestRuntimeFlavor(key, {
          ...opts,
          fallbackText,
          fallbackResult,
        });
      },
      getAIResult: (id: string) => self.flavorSlots.get(String(id || "")) || null,
      requestFlavor: (id: string, opts: Record<string, any> = {}) => {
        const key = String(id || "");
        if (!key) return;

        const existing = self.flavorSlots.get(key);
        if (existing) {
          return;
        }

        self.requestRuntimeFlavor(key, opts);
      },
      getFlavor: (id: string) => self.flavorSlots.get(String(id || "")) || null,
      requestJudge: (id: string, opts: Record<string, any> = {}) => {
        const key = String(id || "");
        if (!key || self.judgeSlots.has(key)) return;
        self.requestRuntimeJudge(key, opts);
      },
      getJudge: (id: string) => self.judgeSlots.get(String(id || "")) || null,
      requestDirector: (id: string, opts: Record<string, any> = {}) => {
        const key = String(id || "");
        if (!key || self.directorSlots.has(key)) return;
        self.requestRuntimeDirector(key, opts);
      },
      getDirectorProposal: (id: string) =>
        self.directorSlots.get(String(id || "")) || null,
      requestContent: (id: string, opts: Record<string, any> = {}) => {
        const key = String(id || "");
        if (!key || self.contentSlots.has(key)) return;
        self.requestRuntimeContent(key, opts);
      },
      getContent: (id: string) => self.contentSlots.get(String(id || "")) || null,
      requestProfiles: () => {},
      // Mirror game-sdk.js's ctx.getGameData (game-sdk.js:4042-4046).
      //
      // Trivia Roulette 286a7348 incident (2026-04-23): without this,
      // any agent code that calls ctx.getGameData(...) — typically to
      // read inline static content like a question bank, sprite list,
      // or seed data attached as window.__DELTA_GAME_DATA__ in the
      // game HTML — throws TypeError on the very first line. The throw
      // is caught silently by drainActionQueue's try/catch, but earlier
      // mutations stick (e.g. state.gameStarted = true), so the game
      // looks "started" but its render data (currentQuestion, etc.) is
      // never populated → blank canvas / stuck phase.
      //
      // Lazy closure: simCtx is built in the constructor before
      // loadSimRuntime returns. We read self.runtime?.globals at call
      // time so the latest loaded sandbox globals are visible.
      //
      // Semantics match game-sdk.js exactly:
      //   no data       → key ? undefined : {}
      //   data present  → key ? data[key] : data
      getGameData: (key?: string) => {
        const data =
          (self.runtime?.globals?.window as Record<string, any> | undefined)
            ?.__DELTA_GAME_DATA__;
        if (!data || typeof data !== "object") {
          return key ? undefined : {};
        }
        return key ? (data as Record<string, any>)[key] : data;
      },
      getPlayerCount: () =>
        Object.entries(self.players).filter(([uid, info]) =>
          self.shouldIncludeInGameState(uid, info)
        ).length,
      spawnBot: (opts: Record<string, any> = {}) => self.spawnPlatformBot(opts),
      despawnBot: (idOrName?: string) => self.despawnPlatformBot(idOrName),
      isBot: (userId: string) =>
        isPlatformBotInfo(String(userId || ""), self.players[String(userId || "")]),
      setBotBlackboard: (idOrName: string, blackboard: Record<string, any>) =>
        self.setBotBlackboard(idOrName, blackboard),
      getBotAction: (idOrName?: string) => self.getBotAction(idOrName),
      clearBotBlackboard: (idOrName?: string) => self.clearBotBlackboard(idOrName),
      getAsset: () => null,
      getAssetUrl: () => null,
      getAssetNames: () => [],
      isRealPlayer: (userId: string) => {
        const id = String(userId || "");
        return !!id && !isBotUser(id);
      },
      isSpectator: (userId: string) => {
        const info = self.players[String(userId || "")];
        return !!(info?.role === "spectator" || info?.spectator);
      },
      getMaxPlayers: () => Number(self.gameConfig?.maxPlayers || 0),
      fillRoundRect: () => {},
      strokeRoundRect: () => {},
      drawCard: () => {},
      drawButton: () => {},
      drawProgressBar: () => {},
      drawText: () => {},
      drawCircle: () => {},
      fillGradient: () => {},
      drawSprite: () => {},
      drawBackground: () => {},
      drawTile: () => {},
      drawVideo: () => {},
      screenShake: () => {},
      setVideo: () => {},
      locale: "en",
      fontStack: "system-ui, sans-serif",
      t: (key: string) => String(key),
      formatNumber: (value: number) => String(value),
      lerp: (a: number, b: number, t: number) => a + (b - a) * t,
      easeOut: (t: number) => 1 - Math.pow(1 - t, 3),
      easeInOut: (t: number) =>
        t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
      lerpColor: (_a: string, b: string) => b,
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
    this.applyRuntimeContractDefaults(ctx);
    return ctx;
  }

  private applyRuntimeContractDefaults(ctx: Record<string, any>): void {
    for (const [apiName, rawContract] of Object.entries(CTX_RUNTIME_CONTRACT)) {
      const contract = rawContract as ServerSimRuntimeContractEntry;
      const support = this.normalizeServerSimSupport(contract.serverSim);
      if (support === "unsupported") continue;
      if (ctx[apiName] !== undefined) continue;
      const fallback = this.defaultRuntimeContractValue(apiName, contract, support);
      if (fallback !== undefined) {
        ctx[apiName] = fallback;
      }
    }
  }

  private normalizeServerSimSupport(
    support: ServerSimRuntimeSupport | undefined
  ): ServerSimRuntimeSupport {
    return support === "supported" ? "implemented" : support || "unsupported";
  }

  private defaultRuntimeContractValue(
    apiName: string,
    contract: ServerSimRuntimeContractEntry,
    support: ServerSimRuntimeSupport
  ): any {
    if (apiName === "locale") return "en";
    if (apiName === "fontStack") return "system-ui, sans-serif";
    if (support === "noop") return () => undefined;
    if (support === "fallback") {
      if (contract.lane === "render_helper") return () => 0;
      return () => null;
    }
    if (contract.lane === "pure_helper") {
      return (...args: any[]) => args[0];
    }
    return undefined;
  }

  private normalizePlatformBotId(idOrName: unknown): string {
    const raw = String(idOrName || DEFAULT_PLATFORM_BOT_NAME)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const name = raw || DEFAULT_PLATFORM_BOT_NAME;
    return name.startsWith(PLATFORM_BOT_PREFIX) ? name : `${PLATFORM_BOT_PREFIX}${name}`;
  }

  private spawnPlatformBot(opts: Record<string, any> = {}): string {
    const requestedName = String(opts.name || opts.displayName || DEFAULT_PLATFORM_BOT_NAME).trim() || DEFAULT_PLATFORM_BOT_NAME;
    const botName = requestedName.toLowerCase() === DEFAULT_PLATFORM_BOT_NAME ? DEFAULT_PLATFORM_BOT_NAME : requestedName;
    const userId = this.normalizePlatformBotId(opts.id || botName);
    const existing = this.players[userId];
    this.players[userId] = {
      ...(existing || {}),
      user_id: userId,
      role: "bot",
      name: botName,
      display_name: botName,
      online: true,
      spectator: false,
      bot: true,
    };
    this.syncPlayersToState();
    return userId;
  }

  private despawnPlatformBot(idOrName?: string): boolean {
    const userId = this.normalizePlatformBotId(idOrName || DEFAULT_PLATFORM_BOT_NAME);
    const info = this.players[userId];
    if (!isPlatformBotInfo(userId, info)) return false;
    delete this.players[userId];
    this.botBlackboards.delete(userId);
    if (this.lastProcessedInputs[userId] !== undefined) {
      delete this.lastProcessedInputs[userId];
      this.lastProcessedInputsDirty = true;
    }
    if (this.state?.players && this.state.players[userId]) {
      delete this.state.players[userId];
    }
    return true;
  }

  private setBotBlackboard(
    idOrName: string | undefined,
    blackboard: Record<string, any> | null | undefined
  ): boolean {
    if (!blackboard || typeof blackboard !== "object" || Array.isArray(blackboard)) {
      return false;
    }
    const userId = this.normalizePlatformBotId(idOrName || DEFAULT_PLATFORM_BOT_NAME);
    if (!isPlatformBotInfo(userId, this.players[userId])) {
      const suffix = userId.startsWith(PLATFORM_BOT_PREFIX)
        ? userId.slice(PLATFORM_BOT_PREFIX.length)
        : DEFAULT_PLATFORM_BOT_NAME;
      this.spawnPlatformBot({ id: userId, name: suffix || DEFAULT_PLATFORM_BOT_NAME });
    }
    this.botBlackboards.set(userId, safeClone(blackboard));
    return true;
  }

  private getBotAction(idOrName?: string): Record<string, any> | null {
    const userId = this.normalizePlatformBotId(idOrName || DEFAULT_PLATFORM_BOT_NAME);
    const blackboard = this.botBlackboards.get(userId);
    if (!blackboard || typeof blackboard !== "object") return null;

    const fallback = this.asAction(blackboard.fallbackAction) || this.asAction(blackboard.fallback);
    const actions = Array.isArray(blackboard.actions)
      ? blackboard.actions
          .map((action) => this.asAction(action))
          .filter((action): action is Record<string, any> => !!action)
      : [];
    if (!actions.length) return fallback ? safeClone(fallback) : null;

    const kind = String(blackboard.kind || blackboard.type || "choice").toLowerCase();
    let selected: Record<string, any> | null = null;
    if (kind === "grid" || kind === "target" || kind === "navigation" || kind === "continuous") {
      selected = this.selectSpatialBotAction(blackboard, actions, kind === "target" || kind === "continuous");
    }
    if (!selected) {
      selected = this.selectChoiceBotAction(actions);
    }
    return selected ? safeClone(selected) : fallback ? safeClone(fallback) : null;
  }

  private clearBotBlackboard(idOrName?: string): boolean {
    const userId = this.normalizePlatformBotId(idOrName || DEFAULT_PLATFORM_BOT_NAME);
    return this.botBlackboards.delete(userId);
  }

  private asAction(value: unknown): Record<string, any> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, any>;
  }

  private selectChoiceBotAction(actions: Record<string, any>[]): Record<string, any> | null {
    let best: BotActionCandidate | null = null;
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i];
      const score = this.numericPreference(action);
      const candidate = { action, index: i, score };
      if (!best || this.compareBotCandidates(candidate, best) < 0) {
        best = candidate;
      }
    }
    return best?.action || actions[0] || null;
  }

  private selectSpatialBotAction(
    blackboard: Record<string, any>,
    actions: Record<string, any>[],
    continuous: boolean
  ): Record<string, any> | null {
    const self = this.extractPoint(blackboard.self) ||
      this.extractPoint(blackboard.actor) ||
      this.extractPoint(blackboard.position);
    if (!self) return null;

    const targets = this.extractPointList(
      blackboard.targets || blackboard.objectives || blackboard.goals || blackboard.food
    );
    const hazards = this.extractPointList(
      blackboard.hazards || blackboard.blocks || blackboard.obstacles || blackboard.enemies
    );
    const width = this.optionalNumber(blackboard.width ?? blackboard.gridW ?? blackboard.cols);
    const height = this.optionalNumber(blackboard.height ?? blackboard.gridH ?? blackboard.rows);

    let best: BotActionCandidate | null = null;
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i];
      const next = this.nextPointForAction(self, action);
      if (!next) continue;
      let score = this.numericPreference(action);

      if (targets.length) {
        let bestTarget = Number.POSITIVE_INFINITY;
        for (const target of targets) {
          const d = continuous
            ? Math.hypot(next.x - target.x, next.y - target.y)
            : Math.abs(next.x - target.x) + Math.abs(next.y - target.y);
          bestTarget = Math.min(bestTarget, d);
        }
        score -= bestTarget * 10;
      }

      for (const hazard of hazards) {
        const d = continuous
          ? Math.hypot(next.x - hazard.x, next.y - hazard.y)
          : Math.abs(next.x - hazard.x) + Math.abs(next.y - hazard.y);
        if (d === 0) score -= 10000;
        else if (d <= 1) score -= 60;
      }

      if (width !== null && (next.x < 0 || next.x >= width)) score -= 10000;
      if (height !== null && (next.y < 0 || next.y >= height)) score -= 10000;

      const candidate = { action, index: i, score };
      if (!best || this.compareBotCandidates(candidate, best) < 0) {
        best = candidate;
      }
    }
    return best?.action || null;
  }

  private compareBotCandidates(a: BotActionCandidate, b: BotActionCandidate): number {
    if (a.score !== b.score) return b.score - a.score;
    const aj = JSON.stringify(a.action);
    const bj = JSON.stringify(b.action);
    if (aj < bj) return -1;
    if (aj > bj) return 1;
    return a.index - b.index;
  }

  private numericPreference(action: Record<string, any>): number {
    const keys = ["score", "utility", "priority", "weight", "value"];
    for (const key of keys) {
      const n = this.optionalNumber(action[key]);
      if (n !== null) return n;
    }
    return 0;
  }

  private optionalNumber(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private extractPoint(value: unknown): BotPoint | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, any>;
    const directX = this.optionalNumber(record.x);
    const directY = this.optionalNumber(record.y);
    if (directX !== null && directY !== null) return { x: directX, y: directY };
    return (
      this.extractPoint(record.position) ||
      this.extractPoint(record.pos) ||
      this.extractPoint(record.head) ||
      this.extractPoint(record.cell)
    );
  }

  private extractPointList(value: unknown): BotPoint[] {
    if (!value) return [];
    const raw = Array.isArray(value) ? value : [value];
    return raw
      .map((item) => this.extractPoint(item))
      .filter((point): point is BotPoint => !!point);
  }

  private nextPointForAction(self: BotPoint, action: Record<string, any>): BotPoint | null {
    const point = this.extractPoint(action.to) || this.extractPoint(action.target) || this.extractPoint(action);
    if (point && (action.x !== undefined || action.y !== undefined || action.to || action.target)) {
      return point;
    }

    const move = this.extractMove(action);
    if (!move) return null;
    return { x: self.x + move.x, y: self.y + move.y };
  }

  private extractMove(action: Record<string, any>): BotPoint | null {
    const directDx = this.optionalNumber(action.dx);
    const directDy = this.optionalNumber(action.dy);
    if (directDx !== null || directDy !== null) {
      return { x: directDx || 0, y: directDy || 0 };
    }
    const move = this.extractPoint(action.move) || this.extractPoint(action.velocity);
    if (move) return move;

    const dir = String(action.dir || action.direction || action.moveDir || "").toLowerCase();
    if (dir === "u" || dir === "up" || dir === "north") return { x: 0, y: -1 };
    if (dir === "d" || dir === "down" || dir === "south") return { x: 0, y: 1 };
    if (dir === "l" || dir === "left" || dir === "west") return { x: -1, y: 0 };
    if (dir === "r" || dir === "right" || dir === "east") return { x: 1, y: 0 };
    return null;
  }

  private assertRuntimeContractCoverage(): void {
    const missing: string[] = [];
    for (const [apiName, rawContract] of Object.entries(CTX_RUNTIME_CONTRACT)) {
      const contract = rawContract as ServerSimRuntimeContractEntry;
      const support = this.normalizeServerSimSupport(contract.serverSim);
      if (support === "unsupported") continue;
      if (this.simCtx[apiName] === undefined) {
        missing.push(apiName);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `simCtx is missing server_sim runtime contract API(s): ${missing.join(", ")}`
      );
    }
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
    this.flavorSlots.clear();
    this.judgeSlots.clear();
    this.directorSlots.clear();
    this.contentSlots.clear();
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

  private restartRound(userId: string, reason: string): void {
    this.callInitState();
    this.setPhase("lobby");

    if (this.gameConfig && typeof this.gameConfig.onAction === "function") {
      const startedAtMs = Date.now();
      try {
        const next = this.gameConfig.onAction(
          this.state,
          { type: this.startAction, user_id: userId },
          userId,
          this.simCtx
        );
        if (next && typeof next === "object" && next !== this.state) {
          this.state = next as Record<string, any>;
        }
      } catch (err) {
        this.logger.warn(
          `[sim] restart start action error room=${this.roomKey} reason=${reason} user=${userId}`,
          err
        );
      } finally {
        this.observeRuntimeBudget("onAction", startedAtMs, {
          action: this.startAction,
          userId,
          reason,
        });
      }
    }

    this.ensureStateShape();
    this.setPhase("playing");
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
    // Keep server_sim lifecycle aligned with game-sdk: generated games may
    // expose terminal state via isGameOver() or durable state flags.
    this.applyTerminalPhaseFromGameplayFlags();
    this.state._phase = this.phase;
  }

  /** Complements mapToSdkPhase: accept only explicit terminal signals. */
  private applyTerminalPhaseFromGameplayFlags(): void {
    if (this.phase !== "playing") return;
    const s = this.state;
    if (!s || typeof s !== "object") return;

    if (this.gameConfig && typeof this.gameConfig.isGameOver === "function") {
      try {
        if (this.gameConfig.isGameOver(s, this.simCtx) === true) {
          this.phase = "result";
          return;
        }
      } catch (err) {
        this.logger.warn(`[sim] isGameOver error room=${this.roomKey}`, err);
      }
    }

    if (
      s.gameOver === true ||
      s.game_over === true ||
      s.finished === true ||
      s.ended === true ||
      s.done === true ||
      s.complete === true ||
      s.completed === true ||
      s.isGameOver === true
    ) {
      this.phase = "result";
      return;
    }
    const terminalStrings = [s.status, s.gamePhase];
    for (const value of terminalStrings) {
      if (typeof value !== "string") continue;
      const u = value.toLowerCase().trim();
      if (
        u === "result" ||
        u === "finished" ||
        u === "gameover" ||
        u === "game_over" ||
        u === "ended" ||
        u === "done" ||
        u === "complete" ||
        u === "completed"
      ) {
        this.phase = "result";
        return;
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
    this.bootstrapReady = true;
    this.bootstrapGateWarned = false;
    const drained = this.drainActionQueue();
    this.pushStateSyncIfChanged("bootstrap");
    if (drained > 0) {
      this.logger.debug(
        `[sim] pending actions drained after bootstrap room=${this.roomKey} count=${drained}`
      );
    }
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
        const drained = this.drainActionQueue();
        if (drained > 0 && !this.isCoalescibleRealtimeAction(action)) {
          this.pushStateSyncIfChanged("player_action");
        }
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
      case "room_snapshot": {
        const payload = (raw.payload || {}) as Record<string, any>;
        const roomRtt = (payload.rtt || {}) as Record<string, any>;
        const avgMs = Number(roomRtt.avg_ms || 0);
        const maxMs = Number(roomRtt.max_ms || 0);
        const samples = Number(roomRtt.samples || 0);
        this.roomAvgClientRTTMs = Number.isFinite(avgMs) && avgMs > 0 ? avgMs : 0;
        this.roomMaxClientRTTMs = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0;
        this.roomRTTSamples = Number.isFinite(samples) && samples > 0 ? Math.floor(samples) : 0;
        return;
      }
      case "room_reset": {
        const payload = (raw.payload || {}) as Record<string, any>;
        const sourceUserId = String(
          raw.source_user_id ||
            raw.from_user_id ||
            raw.user_id ||
            payload.user_id ||
            raw.from ||
            this.userId ||
            ""
        );
        this.restartRound(sourceUserId, "room_reset");
        this.pushStateSyncIfChanged("room_reset");
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
    if (this.isCoalescibleRealtimeAction(packed)) {
      const kind = String(packed.type || "");
      for (let i = this.actionQueue.length - 1; i >= 0; i -= 1) {
        const pending = this.actionQueue[i];
        if (!pending) continue;
        if (pending.userId !== userId) continue;
        if (String(pending.action?.type || "") !== kind) continue;
        this.actionQueue[i] = { action: packed, userId, inputId };
        this._lastEventAt = Date.now();
        return;
      }
    }
    this.actionQueue.push({ action: packed, userId, inputId });
    this._lastEventAt = Date.now();
  }

  private isCoalescibleRealtimeAction(action: Record<string, any> | null | undefined): boolean {
    if (!action || typeof action !== "object") return false;
    if (this.phase !== "playing") return false;
    const profile = this.gameConfig?.networkProfile;
    if (!profile || profile.usesContinuousTick !== true) return false;
    const kind = String(action.type || "").toUpperCase();
    if (!kind || !COALESCIBLE_CONTINUOUS_ACTIONS.has(kind)) return false;
    return true;
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

  private isActionProcessingReady(): boolean {
    if (this.lifecycle !== "active" || this.bootstrapReady) return true;
    if (this.actionQueue.length === 0) return false;
    const activatedAt = this._activatedAt || Date.now();
    if (Date.now() - activatedAt >= BOOTSTRAP_ACTION_GATE_TIMEOUT_MS) {
      this.bootstrapReady = true;
      if (!this.bootstrapGateWarned) {
        this.bootstrapGateWarned = true;
        this.logger.warn(
          `[sim] bootstrap wait timed out; processing queued actions fail-open room=${this.roomKey} queued_actions=${this.actionQueue.length}`
        );
      }
      return true;
    }
    return false;
  }

  private ensureActionPlayerKnown(userId: string): void {
    const uid = String(userId || "");
    if (!uid || isBotUser(uid)) return;
    const existing = this.players[uid];
    if (existing && this.shouldIncludeInGameState(uid, existing)) return;
    this.players[uid] = {
      ...(existing || {}),
      user_id: uid,
      role: existing?.role || "client",
      name: existing?.name || "",
      online: true,
      spectator: false,
    };
  }

  private drainActionQueue(): number {
    if (!this.isActionProcessingReady()) {
      return 0;
    }
    let processed = 0;
    if (!this.gameConfig || typeof this.gameConfig.onAction !== "function") {
      while (this.actionQueue.length > 0) {
        const item = this.actionQueue.shift();
        if (!item) continue;
        this.ackProcessedInput(item.userId, item.inputId);
        processed++;
      }
      this.actionQueue.length = 0;
      return processed;
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
        this.restartRound(item.userId, "restart_action");
        this.ackProcessedInput(item.userId, item.inputId);
        processed++;
        continue;
      }

      const startedAtMs = Date.now();
      try {
        this.ensureActionPlayerKnown(item.userId);
        this.syncPlayersToState();
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
        processed++;
        this.observeRuntimeBudget("onAction", startedAtMs, {
          action: kind,
          userId: item.userId,
        });
      }
      this.ensureStateShape();
      if (this.isStopped()) {
        return processed;
      }
    }
    return processed;
  }

  private stepTick(): void {
    if (this.lifecycle !== "active") return;
    this.drainActionQueue();
    if (!this.bootstrapReady) return;
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
    if (!userId) return false;
    if (isBotUser(userId) && !isPlatformBotInfo(userId, p)) return false;
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
        if (isGameManagedPlayerState(uid, existing[uid])) continue;
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

  private getHumanParticipantCount(): number {
    return Object.entries(this.players).filter(([userId, info]) =>
      this.shouldIncludeInGameState(userId, info)
    ).length;
  }

  private shouldApplyHeavySnapshotCap(snapshotBytes: number): boolean {
    if (this.mode !== "active" || this.phase !== "playing") return false;
    const profile = this.gameConfig?.networkProfile;
    const usesContinuousTick =
      !!(this.gameConfig && typeof this.gameConfig.onTick === "function") ||
      profile?.usesContinuousTick === true;
    if (profile?.class !== "predict_reconcile" || !usesContinuousTick) return false;
    return (
      this.getHumanParticipantCount() >= 2 &&
      snapshotBytes >= HEAVY_CONTINUOUS_MULTIPLAYER_SNAPSHOT_SOFT_LIMIT_BYTES
    );
  }

  private getHeavySnapshotCapHz(snapshotBytes: number): number | null {
    if (!this.shouldApplyHeavySnapshotCap(snapshotBytes)) return null;
    const hasRoomRTT = this.roomRTTSamples > 0 && this.roomAvgClientRTTMs > 0;
    const lowRTT =
      hasRoomRTT &&
      this.roomAvgClientRTTMs <= 90 &&
      (this.roomMaxClientRTTMs <= 0 || this.roomMaxClientRTTMs <= 130);
    const midRTT =
      hasRoomRTT &&
      this.roomAvgClientRTTMs <= 160 &&
      (this.roomMaxClientRTTMs <= 0 || this.roomMaxClientRTTMs <= 240);
    if (snapshotBytes >= HEAVY_CONTINUOUS_MULTIPLAYER_SNAPSHOT_HARD_LIMIT_BYTES) {
      if (lowRTT) return HEAVY_CONTINUOUS_LOW_RTT_HARD_CAP_HZ;
      if (midRTT) return HEAVY_CONTINUOUS_MID_RTT_HARD_CAP_HZ;
      return HEAVY_CONTINUOUS_MULTIPLAYER_HARD_CAP_HZ;
    }
    if (lowRTT) return HEAVY_CONTINUOUS_LOW_RTT_SOFT_CAP_HZ;
    if (midRTT) return HEAVY_CONTINUOUS_MID_RTT_SOFT_CAP_HZ;
    return HEAVY_CONTINUOUS_MULTIPLAYER_SOFT_CAP_HZ;
  }

  private getSnapshotIntervalMs(snapshotBytes = this.lastStateBytes): number {
    const baseIntervalMs = Math.max(16, Math.floor(1000 / Math.max(1, this.snapshotRateHz)));
    const heavyCapHz = this.getHeavySnapshotCapHz(snapshotBytes);
    if (!heavyCapHz) return baseIntervalMs;
    return Math.max(baseIntervalMs, Math.floor(1000 / heavyCapHz));
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
    let snapshotJson = "";
    try {
      snapshotJson = JSON.stringify(snapshot);
    } catch {
      snapshotJson = "";
    }
    if (!snapshotJson) return;
    const snapshotBytes = snapshotJson.length;
    if (!forceSend && this.mode === "active" && this.lastStateSyncAt > 0) {
      const elapsedMs = Date.now() - this.lastStateSyncAt;
      if (elapsedMs < this.getSnapshotIntervalMs(snapshotBytes)) {
        this.pendingSync = true;
        return;
      }
    }
    const fingerprint = fingerprintJson(snapshotJson);
    if (fingerprint === this.lastStateFingerprint && !this.pendingSync) return;
    this.lastStateFingerprint = fingerprint;
    this.lastStateBytes = snapshotBytes;
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
