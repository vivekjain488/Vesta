/** Bounded, analysis-only model comparison using already-published Arkiv snapshots. No live orders. */
import 'dotenv/config';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { marketHistory } from '@perpetua/arkiv';
import { templateConfig } from '@perpetua/core';
import { paperFill, selectReplaySnapshots } from './lib/arkiv-paper';

const root = resolve(process.env.PERPETUA_STATE_DIR ?? '.perpetua');
const id = `arkiv-0g-paper-${Date.now()}`;
const dir = resolve(root, 'competitions', id);
const capUsd = 0.004; const maxOutput = 256; let billedUsd = 0, reservedUsd = 0, calls = 0, completed = 0;
const models = [
  { name: '0GM · momentum', model: '0gm-1.0-35b-a3b', trust: 'verified', thinking: 'off' },
  { name: 'Qwen3.7 Flash · momentum', model: 'qwen3.7-flash', trust: 'standard', thinking: 'off' },
] as const;
if (!process.env.ZG_API_KEY || !process.env.ZG_BASE_URL) throw new Error('Configure ZG_API_KEY and ZG_BASE_URL');
const url = new URL(process.env.ZG_BASE_URL);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid 0G Router HTTPS URL');
const response = await marketHistory('BTCUSDT', Date.now() + 1, 100);
// Published time determines when Arkiv readers could actually have seen the observation.
const snapshots = selectReplaySnapshots(response.rows);
if (snapshots.length < 4) throw new Error('Arkiv has fewer than four valid, time-separated BTCUSDT snapshots');
const bid = (i: number) => Number(snapshots[i].data.book.bids[0][0]);
const ask = (i: number) => Number(snapshots[i].data.book.asks[0][0]);
const mid = (i: number) => (bid(i) + ask(i)) / 2;
const strategy = templateConfig('spot-momentum');
const maxOrderUsd = Math.min(100, strategy.risk.maxNotionalUsd);
const agents = models.map(model => ({ ...model, cash: 500, qty: 500 / mid(0), fees: 0, decisions: [] as any[], fills: [] as any[], failed: false }));
mkdirSync(dir, { recursive: true });
const atomicWrite = (path: string, value: unknown) => { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(tmp, path); };
const save = (phase: string, reason?: string) => {
  const mark = mid(completed);
  const rows = agents.map(a => ({ name: a.name, model: a.model, trust: a.trust, personality: 'Identical momentum prompt and virtual starting portfolio; direct model diagnostic, not the hosted harness.', cash: a.cash, btc: a.qty, fees: a.fees, profit: a.failed ? null : a.cash + a.qty * mark - 1000, fills: a.fills, decisions: a.decisions })).sort((a,b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));
  const passiveProfit = 500 + (500 / mid(0)) * mark - 1000;
  const out = { id, phase, reason, mode: 'historical Arkiv diagnostic paper replay', warning: 'Diagnostic only: 0GM requested verified routing but returned no verification flag; Qwen used standard routing. No actual trades; this is not the hosted execution harness.', historicalStart: new Date(snapshots[0].publishedAtMs).toISOString(), historicalEnd: new Date(snapshots.at(-1)!.publishedAtMs).toISOString(), source: 'Arkiv Rabdi, Binance USD-M futures snapshots, converted to hypothetical spot fills; USDT approximated as USD', writer: response.writer, entityKeys: snapshots.map(s => s.entityKey), completedMinutes: completed, requestedMinutes: snapshots.length - 1, calls, reportedCostUsd: billedUsd, reservedUpperUsd: reservedUsd, maxBudgetUsd: capUsd, initialCapitalUsd: 1000, price: mark, benchmark: { name:'Passive starting allocation', description:'Same 500 USDT and $500 BTC held without trades', profit:passiveProfit }, rows };
  atomicWrite(resolve(dir, 'leaderboard.json'), out); atomicWrite(resolve(root, 'paper-leaderboard.json'), out);
};
let reason = 'Completed three observation intervals';
try {
  for (let i = 0; i < snapshots.length - 1; i++) {
    const pending: Array<{ agent: typeof agents[number]; decision: any; verification: boolean | null; latencyMs: number; requestId: string | null }> = [];
    for (const agent of agents) {
      const input = { simulation: true, strategy: 'spot-momentum', risk: { maxOrderUsd }, observedAt: new Date(snapshots[i].publishedAtMs).toISOString(), bid: bid(i), ask: ask(i), previousMid: i ? mid(i-1) : null, cashUsdt: agent.cash, btc: agent.qty, feePct: 0.1 };
      const messages = [{role:'system',content:`Paper diagnostic only. Use the supplied market data and momentum strategy. Return only JSON: {"decision":"buy"|"sell"|"hold","notionalUsd":number,"rationaleSummary":"short explanation"}. A trade must be between 1 and ${maxOrderUsd} USDT. Hold if evidence is insufficient. No leverage.`},{role:'user',content:JSON.stringify(input)}];
      const body = { model: agent.model, messages, max_tokens: maxOutput, temperature: 0.2, stream: false, ...(agent.model.startsWith('0gm-') ? {chat_template_kwargs:{enable_thinking:false},verify_tee:true} : {enable_thinking:false}) };
      const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
      const upper = ((bytes + 1024) * 0.5 + maxOutput * 1) / 1e6 + 0.000003;
      if (billedUsd + reservedUsd + upper > capUsd) throw new Error('Stopped before exceeding the diagnostic spend reservation');
      reservedUsd += upper; calls++; const started = performance.now();
      let result: any; let http: Response;
      try {
        http = await fetch(`${url.toString().replace(/\/$/,'')}/chat/completions`, { method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${process.env.ZG_API_KEY}`,'X-0G-Provider-Trust-Mode':agent.trust,'X-0G-Provider-Sort':'latency','X-0G-Provider-Max-Price-Usd-Prompt':'0.5','X-0G-Provider-Max-Price-Usd-Completion':'1'}, body:JSON.stringify(body), signal:AbortSignal.timeout(35000) });
        result = await http.json();
      } catch { throw new Error('Inference outcome or billing unknown; stopped without retrying'); }
      const billed = result.x_0g_trace?.billing?.total_cost_usd_micro;
      if (billed == null || !/^\d+$/.test(String(billed)) || !Number.isSafeInteger(Number(billed)) || result.x_0g_trace?.billing?.currency !== 'usd') throw new Error('Inference billing unknown; stopped without retrying');
      billedUsd += Number(billed) / 1e6; reservedUsd -= upper;
      if (Number(billed) / 1e6 > upper) throw new Error('Inference exceeded its cost reservation; stopped');
      if (!http.ok) throw new Error(`0G inference failed: HTTP ${http.status}, ${result.error?.code ?? 'unknown'}`);
      const text = result.choices?.[0]?.message?.content;
      let decision: any;
      try { decision = JSON.parse(text); } catch { throw new Error(`${agent.name} returned invalid JSON`); }
      if (result.choices?.[0]?.finish_reason === 'length' || !['buy','sell','hold'].includes(decision.decision) || typeof decision.notionalUsd !== 'number' || !Number.isFinite(decision.notionalUsd) || decision.notionalUsd < 0 || decision.notionalUsd > maxOrderUsd || typeof decision.rationaleSummary !== 'string') throw new Error(`${agent.name} returned an invalid or truncated decision`);
      const verification = result.x_0g_trace?.tee_verified === true ? true : result.x_0g_trace?.tee_verified === false ? false : null;
      pending.push({ agent, decision, verification, latencyMs: Math.round(performance.now()-started), requestId: result.x_0g_trace?.request_id ?? null });
    }
    // Simulate only after both models finish; the next published observation is the fill price.
    for (const item of pending) {
      const { agent, decision } = item; let fill: any = null;
      const execution = paperFill(decision.decision, decision.notionalUsd, agent.cash, agent.qty, bid(i+1), ask(i+1));
      if (execution) {
        agent.cash = execution.cash; agent.qty = execution.qty;
        agent.fees += execution.fee; fill = { runId:`${id}-${i}-${agent.model}`, side:decision.decision, usd:execution.amount, price:execution.price, fee:execution.fee, at:new Date(snapshots[i+1].publishedAtMs).toISOString() }; agent.fills.push(fill);
      }
      agent.decisions.push({ id:`${id}-${i}-${agent.model}`, status:'completed', decision:{decision:decision.decision,rationaleSummary:decision.rationaleSummary.slice(0,300)}, verification:item.verification, latencyMs:item.latencyMs, requestId:item.requestId });
    }
    completed = i + 1; save('running');
    console.log(JSON.stringify({ completedRounds:completed, calls, billedUsd }));
  }
} catch (error) { reason = (error as Error).message; for (const agent of agents) agent.failed = true; process.exitCode = 1; }
finally { save(process.exitCode ? 'incomplete' : 'complete', reason); }
console.log(JSON.stringify({ id, completedRounds:completed, calls, billedUsd, reservedUsd, reason, artifact:resolve(dir,'leaderboard.json') }));
