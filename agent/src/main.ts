/**
 * Agent entrypoint.
 *   pnpm agent              # run forever (TICK_SECONDS)
 *   pnpm agent --once       # one tick, then exit
 *   pnpm agent --think      # force a thinking cycle on the first tick
 */
import { loadConfig } from "./config";
import { PerpetuaAgent } from "./agent";

const args = new Set(process.argv.slice(2));
const cfg = loadConfig();
const agent = await PerpetuaAgent.create(cfg);
agent.writer.start();
console.log(`[${cfg.agentName}] proposer ${agent.vc.account.address} | wallet ${cfg.wallet} | riskGate ${cfg.riskGate} | flash=${cfg.flash.mode} 0g=${agent.brain.mode} arkiv=${agent.writer.dryRun ? "dry-run" : "rabdi"}`);

let first = true;
const loop = async () => {
  try {
    const r = await agent.tick({ forceThink: first && args.has("--think") });
    first = false;
    console.log(`[tick] tier=${r.tier} runway=${(r.runwayH / 24).toFixed(2)}d ledger=${r.ledgerOg.toFixed(4)} 0G  E=${Number(r.mandate.E) / 1e6} C=${Number(r.mandate.C) / 1e6} woke=${r.woke.wake}(${r.woke.reason})`);
  } catch (e) {
    console.error("[tick] error:", (e as Error).message);
  }
};

await loop();
if (args.has("--once")) {
  await agent.writer.flush();
  process.exit(0);
}
setInterval(loop, cfg.tickSeconds * 1000);
process.on("SIGINT", async () => {
  await agent.writer.flush().catch(() => {});
  process.exit(0);
});
