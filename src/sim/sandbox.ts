import vm from "node:vm";
import { config } from "../config.js";

export interface SimSandboxLogger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
}

export interface LoadedSimRuntime {
  gameConfig: Record<string, any>;
  context: vm.Context;
  globals: Record<string, any>;
  htmlSize: number;
}

export interface PreparedGameSource {
  gameUrl: string;
  sourceUrl?: string;
  htmlSize: number;
  scripts: string[];
  preparedAt: number;
}

export interface SimSandboxSeed {
  context: vm.Context;
  globals: Record<string, any>;
  createdAt: number;
}

function createDeepProxy(): any {
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "toString") return () => "";
      if (prop === "valueOf") return () => 0;
      if (prop === "length") return 0;
      if (prop === "width") return 800;
      if (prop === "height") return 600;
      return createDeepProxy();
    },
    set() {
      return true;
    },
    apply() {
      return createDeepProxy();
    },
    construct() {
      return createDeepProxy();
    },
    has() {
      return true;
    },
  };
  return new Proxy(function () {}, handler);
}

function extractInlineScripts(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script(?:\s[^>]*)?>([^]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const openTag = tag.slice(0, tag.indexOf(">"));
    if (/\bsrc\s*=/i.test(openTag)) continue;
    const body = (m[1] || "").trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

function prepareGameSource(
  gameUrl: string,
  html: string,
  sourceUrl = gameUrl
): PreparedGameSource {
  if (!/__DELTA_GAME_CONFIG__/.test(html)) {
    throw new Error("game html does not define __DELTA_GAME_CONFIG__");
  }
  const scripts = extractInlineScripts(html);
  if (scripts.length === 0) {
    throw new Error("game html has no inline scripts");
  }
  return {
    gameUrl,
    sourceUrl,
    htmlSize: html.length,
    scripts,
    preparedAt: Date.now(),
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMessage =
      cause instanceof Error
        ? cause.message
        : cause !== undefined && cause !== null
          ? String(cause)
          : "";
    return causeMessage ? `${err.message} (${causeMessage})` : err.message;
  }
  return String(err ?? "unknown error");
}

function shouldRetryWithFallback(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || "");
  if (err.name === "AbortError") return true;
  const statusMatch = message.match(/^fetch game html failed: status=(\d+)/i);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return Number.isFinite(status) && status >= 500;
  }
  if (/^fetch failed:?/i.test(message)) return true;
  const haystack = `${message} ${String((err as any).stack || "")} ${String((err as any).cause || "")}`;
  return /(ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|UND_ERR_|network|timed out|aborted)/i.test(
    haystack
  );
}

async function fetchGameHtml(gameUrl: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.sim.fetchTimeoutMs);
  try {
    const resp = await fetch(gameUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    if (!resp.ok) {
      throw new Error(`fetch game html failed: status=${resp.status}`);
    }
    const contentLength = Number(resp.headers.get("content-length") || "0");
    if (contentLength > 0 && contentLength > config.sim.maxHtmlBytes) {
      throw new Error(
        `game html too large by content-length: ${contentLength} > ${config.sim.maxHtmlBytes}`
      );
    }
    const html = await resp.text();
    if (html.length > config.sim.maxHtmlBytes) {
      throw new Error(
        `game html too large: ${html.length} > ${config.sim.maxHtmlBytes}`
      );
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPreparedGameSource(
  gameUrl: string,
  fallbackGameUrl?: string
): Promise<PreparedGameSource> {
  try {
    const html = await fetchGameHtml(gameUrl);
    return prepareGameSource(gameUrl, html, gameUrl);
  } catch (primaryErr) {
    const fallback = String(fallbackGameUrl || "").trim();
    if (!fallback || fallback === gameUrl || !shouldRetryWithFallback(primaryErr)) {
      throw primaryErr;
    }
    try {
      const fallbackHtml = await fetchGameHtml(fallback);
      return prepareGameSource(gameUrl, fallbackHtml, fallback);
    } catch (fallbackErr) {
      const combined = new Error(
        `primary fetch failed (${describeError(primaryErr)}); fallback fetch failed (${describeError(fallbackErr)})`
      );
      (combined as any).cause = fallbackErr;
      throw combined;
    }
  }
}

export function clonePreparedGameSource(
  source: PreparedGameSource
): PreparedGameSource {
  return {
    gameUrl: String(source.gameUrl || ""),
    sourceUrl: source.sourceUrl ? String(source.sourceUrl) : undefined,
    htmlSize: Number(source.htmlSize || 0),
    scripts: Array.isArray(source.scripts)
      ? source.scripts.map((s) => String(s || ""))
      : [],
    preparedAt: Number(source.preparedAt || Date.now()),
  };
}

export function getPreparedGameSourceSize(source: PreparedGameSource): number {
  return source.scripts.reduce(
    (sum, script) => sum + Buffer.byteLength(String(script || ""), "utf8"),
    0
  );
}

function getPreparedSourceForGame(
  gameUrl: string,
  preparedSource?: PreparedGameSource | null
): PreparedGameSource | null {
  if (!preparedSource || typeof preparedSource !== "object") return null;
  if (String(preparedSource.gameUrl || "") !== gameUrl) return null;
  if (!Array.isArray(preparedSource.scripts) || preparedSource.scripts.length === 0) {
    return null;
  }
  return clonePreparedGameSource(preparedSource);
}

function createSandboxGlobals(logger: SimSandboxLogger): Record<string, any> {
  const safeConsole = {
    log: (...a: unknown[]) => logger.debug("[sim-sandbox][log]", ...a),
    warn: (...a: unknown[]) => logger.warn("[sim-sandbox][warn]", ...a),
    error: (...a: unknown[]) => logger.warn("[sim-sandbox][error]", ...a),
    info: (...a: unknown[]) => logger.info("[sim-sandbox][info]", ...a),
    debug: (...a: unknown[]) => logger.debug("[sim-sandbox][debug]", ...a),
  };

  const globals: Record<string, any> = {
    window: { __DELTA_GAME_CONFIG__: null as any },
    document: createDeepProxy(),
    navigator: createDeepProxy(),
    location: createDeepProxy(),
    console: safeConsole,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Date,
    RegExp,
    JSON,
    Error,
    RangeError,
    TypeError,
    ReferenceError,
    SyntaxError,
    URIError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    Proxy,
    Reflect,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    undefined,
    NaN,
    Infinity,
    setTimeout: () => 1,
    setInterval: () => 1,
    clearTimeout: () => {},
    clearInterval: () => {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    Image: function Image() {
      return createDeepProxy();
    },
    Audio: function Audio() {
      return createDeepProxy();
    },
    HTMLElement: function HTMLElement() {},
    Event: function Event() {},
    Matter: createDeepProxy(),
    performance: {
      now: () => Date.now(),
    },
  };

  // window also acts as global scope
  for (const key of Object.keys(globals)) {
    if (key === "window") continue;
    globals.window[key] = globals[key];
  }

  return globals;
}

export function createSandboxSeed(logger: SimSandboxLogger): SimSandboxSeed {
  const globals = createSandboxGlobals(logger);
  const context = vm.createContext(globals);
  return {
    context,
    globals,
    createdAt: Date.now(),
  };
}

export async function loadSimRuntime(
  gameUrl: string,
  logger: SimSandboxLogger,
  opts?: {
    seed?: SimSandboxSeed | null;
    preparedSource?: PreparedGameSource | null;
    fallbackGameUrl?: string;
  }
): Promise<LoadedSimRuntime> {
  const inlinePreparedSource = getPreparedSourceForGame(
    gameUrl,
    opts?.preparedSource
  );
  const preparedSource =
    inlinePreparedSource ||
    (await fetchPreparedGameSource(gameUrl, opts?.fallbackGameUrl));
  const scripts = preparedSource.scripts;

  const seed = opts?.seed || createSandboxSeed(logger);
  const globals = seed.globals;
  const context = seed.context;

  let executed = 0;
  for (const scriptBody of scripts) {
    try {
      const script = new vm.Script(scriptBody, { filename: "game-inline.js" });
      script.runInContext(context, { timeout: 1200 });
      executed++;
    } catch (err) {
      logger.debug("[sim-sandbox] inline script execution error (ignored)", err);
    }
  }

  const gameConfig =
    globals.window?.__DELTA_GAME_CONFIG__ || globals.__DELTA_GAME_CONFIG__;
  if (!gameConfig || typeof gameConfig !== "object") {
    throw new Error("unable to load window.__DELTA_GAME_CONFIG__ from html");
  }
  if (typeof gameConfig.initState !== "function") {
    throw new Error("game config missing initState()");
  }
  if (typeof gameConfig.onAction !== "function") {
    throw new Error("game config missing onAction()");
  }

  const loadedFrom = preparedSource.sourceUrl || gameUrl;
  logger.info(
    `[sim-sandbox] loaded game config from ${gameUrl} via ${loadedFrom} (scripts=${scripts.length}, executed=${executed}, source=${inlinePreparedSource ? "preloaded" : loadedFrom === gameUrl ? "fetched_primary" : "fetched_fallback"})`
  );

  return {
    gameConfig: gameConfig as Record<string, any>,
    context,
    globals,
    htmlSize: preparedSource.htmlSize,
  };
}
