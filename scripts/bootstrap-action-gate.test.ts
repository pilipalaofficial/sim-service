import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { SimSession } from "../src/sim/session.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeSession() {
  const session = new SimSession({
    roomKey: "app:test:instance",
    gameUrl: "https://example.com/game",
    relayWsUrl: "ws://127.0.0.1:9/ws",
    logger,
  }) as any;

  session.gameConfig = {
    initPlayer() {
      return { answered: false };
    },
    onAction(state: any, action: any, userId: string) {
      if (action.type === "SUBMIT_ANSWER") {
        if (!state.players[userId]) return state;
        state.answers[userId] = action.answer;
        state.players[userId].answered = true;
      }
      return state;
    },
  };
  session.state = { players: {}, answers: {}, _phase: "playing" };
  session.phase = "playing";
  session.lifecycle = "active";
  session._activatedAt = Date.now();
  return session;
}

test("server sim keeps runtime AI resolve and flavor URLs separate", () => {
  const session = new SimSession({
    roomKey: "app:test:ai-urls",
    gameUrl: "https://example.com/game",
    relayWsUrl: "ws://127.0.0.1:9/ws",
    runtimeAiUrl: "https://api.example/internal/runtime-ai/resolve",
    runtimeAiFlavorUrl: "https://api.example/internal/runtime-ai/flavor",
    logger,
  }) as any;

  assert.equal(
    session.runtimeAiUrl(),
    "https://api.example/internal/runtime-ai/resolve"
  );
  assert.equal(
    session.runtimeAiFlavorUrl,
    "https://api.example/internal/runtime-ai/flavor"
  );
});

test("queued player actions wait until bootstrap has populated players", () => {
  const session = makeSession();

  session.enqueueAction(
    { type: "SUBMIT_ANSWER", answer: "first" },
    "player-1",
    null
  );

  assert.equal(session.drainActionQueue(), 0);
  assert.deepEqual(session.state.answers, {});

  session.handleBootstrap({
    user_id: session.userId,
    role: "client",
    room_key: "app:test:instance",
    players: {
      "player-1": { user_id: "player-1", role: "client", online: true },
    },
  });

  assert.equal(session.state.answers["player-1"], "first");
  assert.equal(session.state.players["player-1"].answered, true);
  assert.equal(session.actionQueue.length, 0);
});

test("bootstrap gate fails open but still synthesizes action player state", () => {
  const session = makeSession();
  session._activatedAt = Date.now() - 2000;

  session.enqueueAction(
    { type: "SUBMIT_ANSWER", answer: "fallback" },
    "player-2",
    null
  );

  assert.equal(session.drainActionQueue(), 1);
  assert.equal(session.state.answers["player-2"], "fallback");
  assert.equal(session.state.players["player-2"].answered, true);
  assert.equal(session.actionQueue.length, 0);
});

test("generic runtime AI uses content lane in server sim context", () => {
  const session = makeSession();
  const ctx = session.simCtx;

  ctx.requestAI("story-summary", {
    prompt: "Summarize the story",
    fallback: { summary: "fallback summary", twist: "fallback twist" },
    timeoutMs: 1000,
  });

  const ai = ctx.getAIResult("story-summary");
  assert.equal(ai.status, "ready");
  assert.equal(ai.source, "fallback");
  assert.deepEqual(ai.result, {
    summary: "fallback summary",
    twist: "fallback twist",
  });
  assert.equal(session.contentSlots.has("story-summary"), true);
  assert.equal(session.flavorSlots.has("story-summary"), false);
});

test("server sim exposes AI event logging as a safe capability", () => {
  const session = makeSession();

  assert.doesNotThrow(() => {
    session.simCtx.logAIEvent("opening requested");
  });
});

test("runtime AI content fallback is consumable after timeout", async () => {
  const originalEnabled = (config.ai as any).enabled;
  const originalTimeoutMs = (config.ai as any).timeoutMs;
  const originalFetch = globalThis.fetch;

  (config.ai as any).enabled = true;
  (config.ai as any).timeoutMs = 1000;
  globalThis.fetch = (() => new Promise(() => {})) as any;

  try {
    const session = new SimSession({
      roomKey: "app:test:ai-timeout",
      gameUrl: "https://example.com/game",
      relayWsUrl: "ws://127.0.0.1:9/ws",
      runtimeAiUrl: "http://127.0.0.1:9/runtime-ai/resolve",
      logger,
    }) as any;

    session.simCtx.requestAI("opening", {
      prompt: "Write an opening.",
      fallback: { opening: "fallback opening" },
      timeoutMs: 1000,
    });

    assert.equal(session.simCtx.getAIResult("opening").status, "pending");
    await new Promise((resolve) => setTimeout(resolve, 1300));

    const result = session.simCtx.getAIResult("opening");
    assert.equal(result.status, "ready");
    assert.equal(result.source, "fallback");
    assert.deepEqual(result.result, { opening: "fallback opening" });
  } finally {
    (config.ai as any).enabled = originalEnabled;
    (config.ai as any).timeoutMs = originalTimeoutMs;
    globalThis.fetch = originalFetch;
  }
});

test("runtime AI content fallback is consumable after HTTP failure", async () => {
  const originalEnabled = (config.ai as any).enabled;
  const originalTimeoutMs = (config.ai as any).timeoutMs;
  const originalFetch = globalThis.fetch;

  (config.ai as any).enabled = true;
  (config.ai as any).timeoutMs = 1000;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: "forbidden" }),
  })) as any;

  try {
    const session = new SimSession({
      roomKey: "app:test:ai-http-error",
      gameUrl: "https://example.com/game",
      relayWsUrl: "ws://127.0.0.1:9/ws",
      runtimeAiUrl: "http://127.0.0.1:9/runtime-ai/resolve",
      logger,
    }) as any;

    session.simCtx.requestAI("opening", {
      prompt: "Write an opening.",
      fallback: { opening: "fallback opening" },
      timeoutMs: 1000,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = session.simCtx.getAIResult("opening");
    assert.equal(result.status, "ready");
    assert.equal(result.source, "fallback");
    assert.deepEqual(result.result, { opening: "fallback opening" });
  } finally {
    (config.ai as any).enabled = originalEnabled;
    (config.ai as any).timeoutMs = originalTimeoutMs;
    globalThis.fetch = originalFetch;
  }
});
