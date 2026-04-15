import Fastify from "fastify";
import { config } from "./config.js";
import { SimManager } from "./sim/manager.js";
import { registerRoutes } from "./api/routes.js";

async function main() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } }
          : undefined,
    },
  });

  const simManager = new SimManager(app.log);
  registerRoutes(app, simManager);

  const shutdown = async () => {
    app.log.info("shutting down...");
    await simManager.shutdown();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`sim-service listening on :${config.port}`);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
