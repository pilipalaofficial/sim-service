type Labels = Record<string, string | number | boolean>;

interface HistogramState {
  count: number;
  sum: number;
  buckets: number[];
}

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${String(labels[k])}`)
    .join("|");
}

function formatLabels(labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

class CounterVec {
  private values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: string[]
  ) {}

  inc(labels: Labels, by = 1): void {
    const normalized = this.normalize(labels);
    const key = labelKey(normalized);
    const entry = this.values.get(key) || { labels: normalized, value: 0 };
    entry.value += by;
    this.values.set(key, entry);
  }

  render(): string[] {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const entry of this.values.values()) {
      lines.push(`${this.name}${formatLabels(entry.labels)} ${entry.value}`);
    }
    return lines;
  }

  private normalize(labels: Labels): Labels {
    const normalized: Labels = {};
    for (const name of this.labelNames) {
      normalized[name] = labels[name] ?? "";
    }
    return normalized;
  }
}

class HistogramVec {
  private values = new Map<string, { labels: Labels; state: HistogramState }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: string[],
    private readonly bucketBounds: number[]
  ) {}

  observe(labels: Labels, value: number): void {
    const normalized = this.normalize(labels);
    const key = labelKey(normalized);
    const entry =
      this.values.get(key) ||
      {
        labels: normalized,
        state: {
          count: 0,
          sum: 0,
          buckets: this.bucketBounds.map(() => 0),
        },
      };
    entry.state.count += 1;
    entry.state.sum += value;
    this.bucketBounds.forEach((upper, idx) => {
      if (value <= upper) {
        entry.state.buckets[idx] += 1;
      }
    });
    this.values.set(key, entry);
  }

  render(): string[] {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const entry of this.values.values()) {
      entry.state.buckets.forEach((count, idx) => {
        const bucketLabels = {
          ...entry.labels,
          le: this.bucketBounds[idx],
        };
        lines.push(`${this.name}_bucket${formatLabels(bucketLabels)} ${count}`);
      });
      lines.push(
        `${this.name}_bucket${formatLabels({ ...entry.labels, le: "+Inf" })} ${entry.state.count}`
      );
      lines.push(`${this.name}_sum${formatLabels(entry.labels)} ${entry.state.sum}`);
      lines.push(
        `${this.name}_count${formatLabels(entry.labels)} ${entry.state.count}`
      );
    }
    return lines;
  }

  private normalize(labels: Labels): Labels {
    const normalized: Labels = {};
    for (const name of this.labelNames) {
      normalized[name] = labels[name] ?? "";
    }
    return normalized;
  }
}

export interface SimMetricsSnapshot {
  sessions: number;
  reservedSims: number;
  activeSims: number;
  warmingSims: number;
  warmPool: {
    configuredSlots: number;
    warmSlots: number;
  };
}

export class SimMetrics {
  private readonly joinRequests = new CounterVec(
    "sim_join_requests_total",
    "Total sim join requests by requested mode.",
    ["mode"]
  );
  private readonly activationPath = new CounterVec(
    "sim_activation_path_total",
    "Total sim activations by path.",
    ["path"]
  );
  private readonly reservePrepMs = new HistogramVec(
    "sim_reserve_prepare_ms",
    "Time spent preparing reserved sim sessions in milliseconds.",
    [],
    [10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
  );
  private readonly activationMs = new HistogramVec(
    "sim_activation_ms",
    "Time spent making sim sessions active in milliseconds.",
    ["path"],
    [10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
  );
  private readonly reserveToActiveMs = new HistogramVec(
    "sim_reserve_to_active_ms",
    "Elapsed time from reserve completion to activation in milliseconds.",
    [],
    [100, 500, 1000, 5000, 15000, 30000, 60000, 120000, 300000]
  );

  recordJoinRequest(mode: "reserve" | "active"): void {
    this.joinRequests.inc({ mode });
  }

  observeReservePrepareMs(value: number): void {
    this.reservePrepMs.observe({}, value);
  }

  recordActivation(path: "reserve_hit" | "cold_start", durationMs: number): void {
    this.activationPath.inc({ path });
    this.activationMs.observe({ path }, durationMs);
  }

  observeReserveToActiveMs(value: number): void {
    this.reserveToActiveMs.observe({}, value);
  }

  render(snapshot: SimMetricsSnapshot): string {
    const gaugeLines = [
      "# HELP sim_sessions Current sim session counts by mode.",
      "# TYPE sim_sessions gauge",
      `sim_sessions{mode="all"} ${snapshot.sessions}`,
      `sim_sessions{mode="reserved"} ${snapshot.reservedSims}`,
      `sim_sessions{mode="active"} ${snapshot.activeSims}`,
      `sim_sessions{mode="warming"} ${snapshot.warmingSims}`,
      "# HELP sim_warm_pool_slots Current warm sandbox slot counts.",
      "# TYPE sim_warm_pool_slots gauge",
      `sim_warm_pool_slots{state="configured"} ${snapshot.warmPool.configuredSlots}`,
      `sim_warm_pool_slots{state="ready"} ${snapshot.warmPool.warmSlots}`,
    ];

    return [
      ...gaugeLines,
      ...this.joinRequests.render(),
      ...this.activationPath.render(),
      ...this.reservePrepMs.render(),
      ...this.activationMs.render(),
      ...this.reserveToActiveMs.render(),
      "",
    ].join("\n");
  }
}

export const simMetrics = new SimMetrics();
