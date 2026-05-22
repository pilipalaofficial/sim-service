import assert from "node:assert/strict";
import test from "node:test";
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
