import { config } from "../config.js";
import { simMetrics } from "../metrics.js";
import {
  clonePreparedGameSource,
  fetchPreparedGameSource,
  getPreparedGameSourceSize,
  type PreparedGameSource,
} from "./sandbox.js";

export interface GameSourceCacheLogger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
}

export interface GameSourceCacheStatus {
  enabled: boolean;
  entries: number;
  inflight: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
}

interface CacheEntry {
  key: string;
  source: PreparedGameSource;
  sizeBytes: number;
  expiresAt: number;
}

export class GameSourceCache {
  private readonly logger: GameSourceCacheLogger;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<PreparedGameSource>>();
  private totalBytes = 0;

  constructor(logger: GameSourceCacheLogger) {
    this.logger = logger;
  }

  get status(): GameSourceCacheStatus {
    this.pruneExpired();
    return {
      enabled: config.sim.sourceCacheEnabled,
      entries: this.entries.size,
      inflight: this.inflight.size,
      bytes: this.totalBytes,
      maxEntries: config.sim.sourceCacheMaxEntries,
      maxBytes: config.sim.sourceCacheMaxBytes,
      ttlMs: config.sim.sourceCacheTtlMs,
    };
  }

  async getOrLoad(gameUrl: string): Promise<PreparedGameSource> {
    if (!config.sim.sourceCacheEnabled) {
      const startedAt = Date.now();
      const source = await fetchPreparedGameSource(gameUrl);
      simMetrics.recordSourceCacheLookup("bypass");
      simMetrics.observeSourceCacheLoadMs(Date.now() - startedAt);
      return clonePreparedGameSource(source);
    }

    const existing = this.getFreshEntry(gameUrl);
    if (existing) {
      simMetrics.recordSourceCacheLookup("hit");
      return clonePreparedGameSource(existing.source);
    }

    const inflight = this.inflight.get(gameUrl);
    if (inflight) {
      simMetrics.recordSourceCacheLookup("wait");
      const source = await inflight;
      return clonePreparedGameSource(source);
    }

    simMetrics.recordSourceCacheLookup("miss");
    const startedAt = Date.now();
    const loadPromise = fetchPreparedGameSource(gameUrl)
      .then((source) => {
        simMetrics.observeSourceCacheLoadMs(Date.now() - startedAt);
        this.put(source);
        return clonePreparedGameSource(source);
      })
      .finally(() => {
        this.inflight.delete(gameUrl);
      });
    this.inflight.set(gameUrl, loadPromise);
    return loadPromise;
  }

  private getFreshEntry(gameUrl: string): CacheEntry | null {
    const entry = this.entries.get(gameUrl);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.deleteEntry(gameUrl, "expired");
      return null;
    }
    this.entries.delete(gameUrl);
    this.entries.set(gameUrl, entry);
    return entry;
  }

  private put(source: PreparedGameSource): void {
    const key = source.gameUrl;
    if (this.entries.has(key)) {
      this.deleteEntry(key, "replace");
    }

    const now = Date.now();
    const entry: CacheEntry = {
      key,
      source: clonePreparedGameSource(source),
      sizeBytes: getPreparedGameSourceSize(source),
      expiresAt: now + config.sim.sourceCacheTtlMs,
    };
    this.entries.set(key, entry);
    this.totalBytes += entry.sizeBytes;
    this.evictToCapacity();
    this.logger.debug(
      `[sim-source-cache] cached game_url=${key} entries=${this.entries.size} bytes=${this.totalBytes}`
    );
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.deleteEntry(key, "expired");
    }
  }

  private evictToCapacity(): void {
    this.pruneExpired();
    while (
      this.entries.size > config.sim.sourceCacheMaxEntries ||
      this.totalBytes > config.sim.sourceCacheMaxBytes
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      this.deleteEntry(oldestKey, "capacity");
    }
  }

  private deleteEntry(
    key: string,
    reason: "expired" | "capacity" | "replace"
  ): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - entry.sizeBytes);
    if (reason !== "replace") {
      simMetrics.recordSourceCacheEviction(reason);
    }
  }
}
