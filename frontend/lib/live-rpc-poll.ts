/** Schedule the next cycle only after the previous one finishes; hidden tabs do not probe. */
export const LIVE_RPC_INTERVAL_MS = 65_000;
export function startLiveRpcPolling(run: () => Promise<void>, isVisible: () => boolean) {
  let stopped = false, running = false, timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { if (!stopped) timer = setTimeout(() => void cycle(), LIVE_RPC_INTERVAL_MS); };
  const cycle = async () => {
    if (stopped || running) return;
    if (!isVisible()) { schedule(); return; }
    running = true;
    try { await run(); } catch { /* A failed cycle is retried on the next schedule. */ } finally { running = false; schedule(); }
  };
  schedule();
  return {
    wake() { if (stopped || running || !isVisible()) return; if (timer) clearTimeout(timer); void cycle(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
}
