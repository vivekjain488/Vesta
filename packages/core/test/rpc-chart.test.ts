import { describe, expect, it } from "vitest";
import { hourlyAvailability, samplesForDisplay } from "../../../frontend/lib/rpc-metrics";
describe("RPC chart measurements", () => {
  it("deduplicates cached checks and excludes old and future data", () => {
    const now = 100_000_000, current = { at: now - 1000, ok: true, latencyMs: 24 };
    const result = samplesForDisplay([{ at: now - 90_000_000, ok: false, latencyMs: 2 }, current, { at: now + 1000, ok: true, latencyMs: 1 }], current, now);
    expect(result).toEqual([current]);
  });
  it("uses only measured hourly samples, leaving missing hours absent", () => {
    const samples = [{ at: 1000, ok: true, latencyMs: 50 }, { at: 2000, ok: false, latencyMs: 5 }, { at: 3 * 3600_000, ok: true, latencyMs: 20 }];
    expect(hourlyAvailability(samples)).toEqual([{ at: 2000, value: 50, count: 2 }, { at: 3 * 3600_000, value: 100, count: 1 }]);
  });
});

describe("live chart updates", () => {
  it("updates rolling availability for each real check and drops old observations", async () => {
    const { rollingAvailability } = await import("../../../frontend/lib/rpc-metrics");
    const samples = [{ at: 1000, ok: true, latencyMs: 5 }, { at: 2000, ok: false, latencyMs: 8 }, { at: 3_602_001, ok: true, latencyMs: 7 }];
    expect(rollingAvailability(samples)).toEqual([{ at: 1000, value: 100, count: 1 }, { at: 2000, value: 50, count: 2 }, { at: 3_602_001, value: 100, count: 1 }]);
  });
});
