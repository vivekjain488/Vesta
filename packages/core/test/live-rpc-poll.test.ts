import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RPC_INTERVAL_MS, startLiveRpcPolling } from "../../../frontend/lib/live-rpc-poll";
afterEach(() => vi.useRealTimers());
describe("live RPC polling", () => {
  it("waits between completed cycles and stops after cancellation", async () => {
    vi.useFakeTimers(); let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const poll = startLiveRpcPolling(run, () => true);
    await vi.advanceTimersByTimeAsync(LIVE_RPC_INTERVAL_MS); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * LIVE_RPC_INTERVAL_MS); expect(run).toHaveBeenCalledTimes(1);
    finish(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(LIVE_RPC_INTERVAL_MS); expect(run).toHaveBeenCalledTimes(2);
    poll.stop(); finish(); await vi.advanceTimersByTimeAsync(3 * LIVE_RPC_INTERVAL_MS); expect(run).toHaveBeenCalledTimes(2);
  });
  it("pauses hidden tabs and refreshes on visibility wake", async () => {
    vi.useFakeTimers(); let visible = false; const run = vi.fn(async () => {});
    const poll = startLiveRpcPolling(run, () => visible);
    await vi.advanceTimersByTimeAsync(LIVE_RPC_INTERVAL_MS); expect(run).not.toHaveBeenCalled();
    visible = true; poll.wake(); await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
    poll.wake(); await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(2);
    poll.stop(); await vi.advanceTimersByTimeAsync(2 * LIVE_RPC_INTERVAL_MS); expect(run).toHaveBeenCalledTimes(2);
  });
});
