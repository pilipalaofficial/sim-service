import { config } from "../config.js";
import {
  createSandboxSeed,
  type SimSandboxLogger,
  type SimSandboxSeed,
} from "./sandbox.js";

export class SandboxWarmPool {
  private idleSeeds: SimSandboxSeed[] = [];
  private refillScheduled = false;
  private logger: SimSandboxLogger;
  private size: number;

  constructor(logger: SimSandboxLogger, size = config.sim.warmPoolSize) {
    this.logger = logger;
    this.size = Math.max(0, Number.isFinite(size) ? Math.floor(size) : 0);
    this.refill();
  }

  acquire(): SimSandboxSeed | null {
    if (this.size <= 0) {
      return null;
    }
    const seed = this.idleSeeds.pop() || null;
    if (seed) {
      this.logger.debug(
        `[warm-pool] acquired seed remaining=${this.idleSeeds.length}/${this.size}`
      );
    }
    this.scheduleRefill();
    return seed;
  }

  get status() {
    return {
      configuredSlots: this.size,
      warmSlots: this.idleSeeds.length,
    };
  }

  private scheduleRefill(): void {
    if (this.size <= 0 || this.refillScheduled) {
      return;
    }
    this.refillScheduled = true;
    setTimeout(() => {
      this.refillScheduled = false;
      this.refill();
    }, 0);
  }

  private refill(): void {
    while (this.idleSeeds.length < this.size) {
      this.idleSeeds.push(createSandboxSeed(this.logger));
    }
  }
}
