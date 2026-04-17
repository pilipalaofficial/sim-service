import WebSocket from "ws";
import { EventEmitter } from "node:events";

export interface RelayMessage {
  type: string;
  payload?: unknown;
  from?: string;
}

export interface NetworkBootstrap {
  user_id: string;
  role: string;
  room_key: string;
  host_user_id: string;
  game_url?: string;
  sync_mode?: string;
  authority_mode?: string;
  players: Record<
    string,
    { user_id: string; role: string; name: string; online: boolean }
  >;
  resumed: boolean;
}

export interface RelayClientOptions {
  wsUrl: string;
  roomKey: string;
  userId: string;
  role?: string;
  name?: string;
  syncMode?: string;
  extraQuery?: Record<string, string | number | boolean | null | undefined>;
  logger: {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
    debug: (...a: unknown[]) => void;
  };
}

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private opts: RelayClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private _closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RelayClientOptions) {
    super();
    this.opts = opts;
  }

  connect(): void {
    if (this._closed) return;

    const url = new URL(this.opts.wsUrl);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/ws";
    }
    url.searchParams.set("room_key", this.opts.roomKey);
    url.searchParams.set("user_id", this.opts.userId);
    url.searchParams.set("role", this.opts.role ?? "client");
    url.searchParams.set("name", this.opts.name ?? "SimBot");
    if (this.opts.syncMode) {
      url.searchParams.set("sync_mode", String(this.opts.syncMode));
    }
    if (this.opts.extraQuery) {
      for (const [k, v] of Object.entries(this.opts.extraQuery)) {
        if (v === null || v === undefined || String(v).trim() === "") continue;
        url.searchParams.set(k, String(v));
      }
    }

    this.opts.logger.info(`[relay] connecting to ${url.toString()}`);
    const ws = new WebSocket(url.toString());

    ws.on("open", () => {
      this.opts.logger.info(`[relay] connected room=${this.opts.roomKey}`);
      this.reconnectDelay = 1000;
      this.startPing();
      this.emit("connected");
    });

    ws.on("message", (raw: WebSocket.Data) => {
      try {
        const msg: RelayMessage = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch {
        this.opts.logger.warn("[relay] unparseable message");
      }
    });

    ws.on("close", (code) => {
      this.opts.logger.warn(`[relay] disconnected code=${code}`);
      this.ws = null;
      this.stopPing();
      this.emit("disconnected", code);
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.opts.logger.error(`[relay] ws error: ${err.message}`);
    });

    this.ws = ws;
  }

  send(type: string, payload: unknown): boolean {
    return this.sendRaw(JSON.stringify({ type, payload }));
  }

  sendRaw(serializedMessage: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(serializedMessage);
    return true;
  }

  close(): void {
    this._closed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.emit("closed");
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private handleMessage(msg: RelayMessage): void {
    switch (msg.type) {
      case "network_bootstrap":
        this.emit("bootstrap", msg.payload as NetworkBootstrap);
        break;
      case "pong":
        break;
      default:
        this.emit("message", msg);
        break;
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.send("ping", { ts: Date.now() });
    }, 25000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this._closed) return;
    this.opts.logger.info(
      `[relay] reconnecting in ${this.reconnectDelay}ms...`
    );
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay
    );
  }
}
