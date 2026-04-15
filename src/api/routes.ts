import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SimManager } from "../sim/manager.js";
import { config } from "../config.js";
import { simMetrics } from "../metrics.js";

const JoinSimBodySchema = z.object({
  room_key: z.string().min(1),
  relay_ws_url: z.string().url().optional(),
  game_url: z.string().url(),
  tick_rate: z.number().int().positive().optional(),
  start_action: z.string().min(1).max(64).optional(),
  mode: z.enum(["reserve", "active"]).optional(),
});

export function registerRoutes(
  app: FastifyInstance,
  simManager: SimManager
): void {
  function requireSecret(
    req: { headers: Record<string, unknown> },
    reply: {
      status: (code: number) => { send: (p: unknown) => unknown };
    }
  ): boolean {
    const expected = (config.api.internalSecret || "").trim();
    if (!expected) return true;
    const raw = req.headers["x-internal-secret"];
    const got = Array.isArray(raw) ? String(raw[0] || "") : String(raw || "");
    if (got === expected) return true;
    reply.status(403).send({ error: "forbidden" });
    return false;
  }

  app.get("/health", async () => ({
    status: "ok",
    ...simManager.status,
  }));

  app.get("/metrics", async (_req, reply) => {
    reply
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(simMetrics.render(simManager.status));
  });

  app.get("/sims", async (req, reply) => {
    if (!requireSecret(req, reply)) return;
    return { sims: simManager.listSessions() };
  });

  app.post("/sims", async (req, reply) => {
    if (!requireSecret(req, reply)) return;
    const parsed = JoinSimBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const {
      room_key,
      relay_ws_url,
      game_url,
      tick_rate,
      start_action,
      mode,
    } =
      parsed.data;
    try {
      const session = await simManager.join(room_key, {
        relayWsUrl: relay_ws_url,
        gameUrl: game_url,
        tickRate: tick_rate,
        startAction: start_action,
        mode: mode || "active",
      });
      return reply.status(201).send({
        id: session.id,
        room_key: session.roomKey,
        game_url: session.gameUrl,
        user_id: session.userId,
        active: session.active,
        mode: session.mode,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  });

  app.get<{ Params: { roomKey: string } }>(
    "/sims/:roomKey",
    async (req, reply) => {
      if (!requireSecret(req, reply)) return;
      const session = simManager.getSession(req.params.roomKey);
      if (!session) {
        return reply.status(404).send({ error: "No sim session for this room" });
      }
      return session.stats;
    }
  );

  app.delete<{ Params: { roomKey: string } }>(
    "/sims/:roomKey",
    async (req, reply) => {
      if (!requireSecret(req, reply)) return;
      const removed = await simManager.leave(req.params.roomKey);
      if (!removed) {
        return reply.status(404).send({ error: "No sim session for this room" });
      }
      return { removed: true };
    }
  );
}
