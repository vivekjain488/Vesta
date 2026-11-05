/**
 * The < 3-minute demo, scripted end to end against real contracts on a local anvil chain (or a testnet).
 *   anvil &  &&  pnpm deploy:local  &&  pnpm demo
 *
 * Beats: hook -> safety proof (reckless trade reverts on-chain, AgentWallet refuses to sign) -> a real
 * bracket trade inside the mandate -> starvation (model ladder walks down, "I'm hungry") -> fed by real
 * income engines -> poke() harvest -> swap -> CCIP -> ComputeTreasury -> 0G ledger -> tier back up.
 * Writes every tx hash / request ID to .perpetua/evidence.json for the README + Arena /proof page.
 *
 * DISCLOSED for the local run: Flash and 0G run in sim mode (same request/response shapes, same digest ->
 * RiskGate -> EIP-1271 pipeline), CCIP is the local simulator, burn is time-accelerated, and the demo
 * "buyers" below are local accounts. On the live run those are a judge's wallet and another team's agent.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { perpetuaVaultAbi, riskGateAbi, mockERC20Abi, type Signal } from "@perpetua/core";
import { erc20Abi, parseUnits, stringToHex, type Hex } from "viem";
import { PerpetuaAgent } from "../agent/src/agent";
import { clients } from "../agent/src/chain";
import { loadConfig } from "../agent/src/config";
import { SimBrain } from "../agent/src/zerog";

const ANVIL = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  proposer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  judge: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  otherTeamAgent: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
} as const;

process.env.PROPOSER_PRIVATE_KEY ??= ANVIL.proposer;
process.env.FLASH_SPENDER_PRIVATE_KEY ??= ANVIL.deployer;
process.env.DEPLOYMENT_FILE ??= "contracts/deployments/local-31337.json";
process.env.CANDLE_SOURCE ??= "synthetic";
process.env.TICK_SECONDS ??= "3600";

const evidence: Record<string, unknown> = { network: "local anvil (chainId 31337)", startedAt: new Date().toISOString(), beats: {} };
const beat = (k: string, v: unknown) => {
  (evidence.beats as any)[k] = v;
  console.log(`\n=== ${k} ===\n${JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2)}`);
};
const usd = (x: bigint) => Number(x) / 1e6;

const cfg = loadConfig();
const agent = await PerpetuaAgent.create(cfg);
const pub = agent.vc.pub;
const asset = cfg.assets[0];
const dep = JSON.parse((await import("node:fs")).readFileSync(process.env.DEPLOYMENT_FILE!, "utf8"));

async function anvilWarp(seconds: number) {
  await pub.request({ method: "evm_increaseTime" as any, params: [seconds] as any });
  await pub.request({ method: "evm_mine" as any, params: [] as any });
}

async function poke() {
  const prices = await agent.attestAll(true);
  const rc = await agent.gate.poke(prices);
  return { tx: rc.transactionHash, mandate: await agent.gate.mandate() };
}

// ------------------------------------------------------------------ 0:00 hook
{
  const rows: any[] = [];
  for (const name of ["Atlas", "Halcyon", "Ember"]) {
    const a = typeof dep[name] === "string" ? JSON.parse(dep[name]) : dep[name];
    await clients(cfg.vaultRpc, cfg.vaultChainId, ANVIL.deployer).wallet.writeContract({ address: a.riskGate, abi: riskGateAbi, functionName: "poke", args: [[]], account: clients(cfg.vaultRpc, cfg.vaultChainId, ANVIL.deployer).account, chain: agent.vc.chain }).catch(() => {});
    const m = (await pub.readContract({ address: a.riskGate, abi: riskGateAbi, functionName: "mandate" })) as readonly any[];
    rows.push({ agent: name, V: usd(m[3]), F: usd(m[4]), C: usd(m[5]), E: usd(m[6]) });
  }
  const rw = await agent.runway();
  beat("0:00 hook: three agents, runway + CPPI gauges", { agents: rows, atlasRunwayDays: +(rw.hours / 24).toFixed(2), atlasTier: rw.policy.tier });
}

// a TEE-signed 0G inference call that the proposals below carry as proof
await agent.tick({});
const brain = await agent.brain.think({ ...(await agent.runway()).policy, model: "large" }, [
  { role: "system", content: "Score sentiment. JSON only." },
  { role: "user", content: `Asset: ${asset.symbol}. Headlines:\n- Chainlink CCIP adoption surge\n- partnership launch` },
]);
if (!brain?.tee) throw new Error("no TEE-signed inference available");

// ------------------------------------------------------------------ 0:20 safety proof
{
  const m = await agent.gate.mandate();
  const price = (agent as any).priceCache.get(asset.address.toLowerCase()) as number;
  const reckless: Signal = { asset: asset.symbol, direction: "long", confidence: 0.99, score: 0.9, regime: "uptrend", highVol: false, factors: { trend: 1, sentiment: 1, momentum: 1, relativeStrength: 1, positioning: 1 }, agreeing: 5, entry: price, stop: price * 0.92, target: price * 1.16, atrPct: 0.04, rewardRisk: 2, orderType: "market", sizeMultiplier: 1, reasons: ["YOLO"] };
  const q = await agent.flash.quote({ targetChain: cfg.flash.chain, contraChain: cfg.flash.chain, targetAsset: asset.address, contraAsset: cfg.usdc, side: "buy", qty: "500", orderType: "market", funderAddress: cfg.wallet });
  const verdict = await agent.gate.checkOrder(
    { flashDigest: "0x" + "11".repeat(32) as Hex, bracketDigest: ("0x" + "00".repeat(32)) as Hex, kind: 0, tokenIn: cfg.usdc, tokenOut: asset.address, amountIn: 500_000000n, minAmountOut: parseUnits((500 / price).toFixed(8), 18), stopPriceE8: BigInt(Math.round(reckless.stop * 1e8)), takeProfitPriceE8: BigInt(Math.round(reckless.target * 1e8)), deadline: m.validUntil, recipient: cfg.wallet },
    (await agent.attestAll())[0],
  );
  const r = await agent.gateAndSubmit(asset, q, reckless, 500, brain, "reckless", { unsafe: true });
  const sig = await agent.vc.account.sign!({ hash: ("0x" + "11".repeat(32)) as Hex });
  const walletSays = await agent.gate.isValidSignature(("0x" + "11".repeat(32)) as Hex, sig);
  beat("0:20 safety proof: $500 order vs E = $" + usd(m.E), { floor: usd(m.F), cushion: usd(m.C), E: usd(m.E), riskGateVerdict: verdict, revertedTx: (r as any).txHash, agentWalletIsValidSignature: walletSays });
}

// ------------------------------------------------------------------ 0:50 a real trade inside the mandate
{
  const price = (agent as any).priceCache.get(asset.address.toLowerCase()) as number;
  const s: Signal = { asset: asset.symbol, direction: "long", confidence: 0.62, score: 0.41, regime: "uptrend", highVol: false, factors: { trend: 0.6, sentiment: 0.4, momentum: 0.3, relativeStrength: 0.2, positioning: 0.1 }, agreeing: 5, entry: price, stop: price * 0.92, target: price * 1.16, atrPct: 0.04, rewardRisk: 2, orderType: "market", sizeMultiplier: 1, reasons: ["4h uptrend, breakout, positive sentiment"] };
  const r: any = await agent.proposeEntry(asset, s, 50, brain);
  const linkBal = await pub.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [cfg.wallet] });
  beat("0:50 real trade: LINK bracket (entry + SL -8% + TP +16%)", { approvalTx: r.approvalTx, flashOrderId: r.orderId, flashDigest: r.digest, "0gChatId": brain.chatId, teeSigner: brain.tee.signer, walletLinkBalance: Number(linkBal) / 1e18 });
}

// ------------------------------------------------------------------ 1:30 starvation
{
  const steps: any[] = [];
  const sim = agent.brain as SimBrain;
  for (let i = 0; i < 6; i++) {
    const rw = await agent.runway();
    const target = rw.policy.tier === "thrive" ? 0.8 : rw.policy.tier === "frugal" ? 0.6 : 0.5;
    sim.burn((await sim.ledgerOg()) * target);
    const t = await agent.tick({});
    steps.push({ tier: t.tier, runwayDays: +(t.runwayH / 24).toFixed(2), ledgerOg: +t.ledgerOg.toFixed(4) });
    if (t.tier === "starving") break;
  }
  beat("1:30 starvation: model ladder walks down, nothing crashes", { steps });
}

// ------------------------------------------------------------------ 2:10 a judge feeds it
{
  const judge = clients(cfg.vaultRpc, cfg.vaultChainId, ANVIL.judge as Hex);
  const other = clients(cfg.vaultRpc, cfg.vaultChainId, ANVIL.otherTeamAgent as Hex);
  const deployer = clients(cfg.vaultRpc, cfg.vaultChainId, ANVIL.deployer as Hex);
  // fund the demo payers with mock USDC (local only, disclosed)
  for (const p of [judge, other]) {
    const h = await deployer.wallet.writeContract({ address: cfg.usdc, abi: mockERC20Abi, functionName: "mint", args: [p.account.address, 100_000000n], account: deployer.account, chain: agent.vc.chain });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const pay = async (who: typeof judge, engine: string, amount: bigint) => {
    await pub.waitForTransactionReceipt({ hash: await who.wallet.writeContract({ address: cfg.usdc, abi: erc20Abi, functionName: "approve", args: [cfg.vault, amount], account: who.account, chain: agent.vc.chain }) });
    const h = await who.wallet.writeContract({ address: cfg.vault, abi: perpetuaVaultAbi, functionName: "recordIncome", args: [stringToHex(engine, { size: 32 }), amount], account: who.account, chain: agent.vc.chain });
    await pub.waitForTransactionReceipt({ hash: h });
    return h;
  };
  // income earned during the hackathon (signals, risk checks) + the judge's copy-trade fee + a signal bought over x402
  const incomeTxs = {
    hackathonSignals: await pay(other, "signals", 6_000000n),
    hackathonRiskChecks: await pay(other, "risk_checks", 4_000000n),
    judgeCopyTradeFee: await pay(judge, "copy_fees", 2_000000n),
    otherAgentSignalX402: await pay(other, "signals", 20_000n),
  };
  // the compute bill this cycle, cost-plus against the live 0G price (feeManager = agent)
  await agent.gate.setFeeParams(0n, 0n, 10_000000n);
  const ledgerBefore = await agent.brain.ledgerOg();
  await anvilWarp(4 * 3600 + 60);
  const p = await poke(); // harvest -> swap -> CCIP (local sim auto-delivers) -> ComputeTreasury
  const harvested = await pub.getContractEvents({ address: cfg.vault, abi: perpetuaVaultAbi, eventName: "Harvested", fromBlock: 0n });
  const fed = await agent.feed();
  const t = await agent.tick({ forceThink: true });
  beat("2:10 a judge feeds it: harvest -> CCIP -> ComputeTreasury -> 0G ledger", {
    incomeTxs,
    pokeTx: p.tx,
    harvested: harvested.map((h: any) => ({ tx: h.transactionHash, ccipMessageId: h.args.ccipMessageId, fromSurplus: usd(h.args.fromSurplus) })),
    treasuryToLedgerOg: fed,
    ledgerBeforeOg: +ledgerBefore.toFixed(4),
    ledgerAfterOg: +t.ledgerOg.toFixed(4),
    tierAfter: t.tier,
    mandateAfter: { F: usd(p.mandate.F), C: usd(p.mandate.C), E: usd(p.mandate.E) },
  });
}

// ------------------------------------------------------------------ 2:40 close
await agent.writer.flush();
evidence.finishedAt = new Date().toISOString();
evidence.disclosure = "Local run: Flash + 0G in sim mode, local CCIP simulator, accelerated burn, local payer accounts. Seed: 1000 USDC per agent vault deposited once at deploy; no human top-up afterwards.";
mkdirSync(".perpetua", { recursive: true });
writeFileSync(".perpetua/evidence.json", JSON.stringify(evidence, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
console.log("\nNo human topped it up. Principal never at risk. Every decision is auditable. -> .perpetua/evidence.json");
process.exit(0);
