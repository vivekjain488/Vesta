import '../agent/src/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyRiskProfile, configHash, RISK_PROFILES, templateConfig, type RiskProfile } from '@perpetua/core';
import { OpenRouterInference, InferenceServiceError } from '../agent/src/inference';
import { MinuteHarness } from '../agent/src/runtime/run';
import { RuntimeStore } from '../agent/src/runtime/store';
import { observation } from '../agent/src/runtime/tools';
import type { RuntimePorts } from '../agent/src/runtime/types';

const start = Date.parse('2024-11-06T04:00:00Z'), requestedMinutes = 360;
const root = process.env.PERPETUA_STATE_DIR!, id = `harness-20241106-${Date.now()}`, dir = resolve(root, 'competitions', id);
mkdirSync(dir, { recursive: true });
const endpoint = 'https://data-api.binance.vision/api/v3/klines';
async function candles(interval: string, from: number, end: number, limit: number) {
  const url = new URL(endpoint); for (const [k,v] of Object.entries({ symbol:'BTCUSDT', interval, startTime:String(from), endTime:String(end-1), limit:String(limit) })) url.searchParams.set(k,v);
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  const rows: any = await r.json(); if (!Array.isArray(rows)) throw new Error('Invalid candle response');
  return rows.map((x:any) => ({ t:Number(x[0]), o:Number(x[1]), h:Number(x[2]), l:Number(x[3]), c:Number(x[4]), v:Number(x[5]) }));
}
const [minuteData, historical] = await Promise.all([candles('1m', start - 15*60000, start + (requestedMinutes+1)*60000, requestedMinutes+16), candles('4h', start - 240*14400000, start + requestedMinutes*60000, 242)]);
if (minuteData.length !== requestedMinutes+16 || minuteData.some((b:any,i:number) => b.t !== start+(i-15)*60000)) throw new Error('Incomplete historical minute coverage');
const minutes = minuteData.slice(15);
if (historical.length !== 242 || historical.some((b:any,i:number) => b.t !== start-(240-i)*14400000)) throw new Error('Incomplete historical 4h coverage');
const store = new RuntimeStore(resolve(dir, 'runtime.sqlite'));
const owner = `0x${'11'.repeat(20)}`;
const names = ['Momentum','Range','Accumulator','Cautious','Breakout','Mean Reversion','Patient'];
const personas = [
  'Momentum: focus on the direction and persistence of recent returns. Seek sustained price acceleration and reduce exposure on a supported reversal. Consider higher conviction sizing within the aggressive cap.',
  'Range: look for prices near the edges of the recent range and evidence of reversal. Avoid treating an established breakout as an ordinary range.',
  'Accumulator: build exposure in small increments on pullbacks when the longer-term context is suitable. Avoid adding merely because time passed; preserve cash.',
  'Cautious: prioritize preservation, limit order size and require multiple confirming observations. Consider reducing existing exposure when downside conditions materially worsen.',
  'Breakout: focus on a credible move above a prior high, its persistence, and the risk of a failed breakout. Do not treat a move inside the range as a confirmed breakout.',
  'Mean Reversion: measure distance from the recent mean and look for signs of the move reversing. Avoid fading a sustained trend without evidence of exhaustion.',
  'Patient: seek rare, well-supported accumulation entries, retain cash when evidence is weak and avoid frequent turnover.',
];
const templates = ['spot-momentum','spot-bollinger','spot-dca','spot-rsi-recovery','spot-breakout','spot-range','spot-dca'] as const;
const profiles: RiskProfile[] = ['aggressive','balanced','cautious','cautious','aggressive','balanced','cautious'];
const accounts = names.map(() => ({ cash:400, qty:600/minutes[0].o, fees:0, fills:[] as any[], decisions:[] as any[] }));
let simulatedNow = start + 60000, spent = 0, reserved = 0, calls = 0, unknown = 0, budgetLimit = false, completedMinutes = 0, incompleteRound = false;
const budgetArgument = (name: string) => { const raw = process.argv.find((v) => v.startsWith(`--${name}=`))?.split('=')[1]; const value = raw === undefined ? 0 : Number(raw); if (!Number.isFinite(value) || value < 0 || value > 0.0595) throw Error(`Invalid ${name}`); return value; };
const priorReportedCostUsd = budgetArgument('prior-spend-usd'), priorReservedUpperUsd = budgetArgument('prior-reservation-usd');
const max = 0.0595 - priorReportedCostUsd - priorReservedUpperUsd;
if (max <= 0) throw Error('No replay budget remains after prior charges and reservations');
// Reservation is intentionally conservative: bytes are an upper bound on input tokens.
const send: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init!.body));
  if (body.model !== 'qwen/qwen3.7-flash') throw new Error('Unexpected model');
  const bytes = Buffer.byteLength(JSON.stringify(body.messages)) + 1024;
  const upper = (bytes*0.05/1e6 + body.max_tokens*0.2/1e6)*1.25;
  if (spent + reserved + upper > max) { budgetLimit = true; throw new InferenceServiceError(429, 'budget_limit', 'Replay budget exhausted'); }
  reserved += upper; calls++; body.reasoning = { enabled:false }; body.provider = { allow_fallbacks:false, max_price:{ prompt:0.05, completion:0.2, request:0 } };
  try {
    const response = await fetch(url, { ...init, body:JSON.stringify(body) });
    const data:any = await response.clone().json().catch(() => ({}));
    if (typeof data.usage?.cost === 'number' && Number.isFinite(data.usage.cost) && data.usage.cost >= 0) { spent += data.usage.cost; reserved -= upper; }
    else { unknown++; budgetLimit = true; }
    return response;
  } catch (e) { unknown++; budgetLimit = true; throw e; }
};
const agents = names.map((name,i) => {
  const portfolioId = `paper-${i}`;
  store.bindPortfolio({id:portfolioId,owner,chainId:31337,rpc:'http://127.0.0.1:8545',vault:owner,wallet:owner,riskGate:owner,stable:owner});
  const config = applyRiskProfile(templateConfig(templates[i]), profiles[i]); config.symbols=['BTC'];
  return store.activate({id:`historical-${i}`,owner,name,revision:1,config,configHash:configHash(config),instructions:`Personality: ${personas[i]}. ${RISK_PROFILES[profiles[i]].instructions} This is historical paper trading, not live. Consider the supplied recent one-minute BTC candles, 4h trend, portfolio, 0.1% fee and previous decisions. Treat the 4h template as background for this one-minute experiment. Propose at most $${config.risk.maxNotionalUsd} per trade. You may buy, sell existing BTC, or hold; choose independently based on evidence.`,portfolioId,mode:'analysis',status:'active'}, simulatedNow);
});
const providers = agents.map(() => new OpenRouterInference({apiKey:process.env.OPENROUTER_API_KEY!,modelSmall:'qwen/qwen3.7-flash',maxTokensPerHour:100000000,maxTokensPerDay:100000000},send));
const save = (phase:string, reason?:string) => {
  const mark = completedMinutes ? minutes[completedMinutes].o : minutes[0].o;
  const rows = agents.map((a,i) => { const x=accounts[i]; return { name:a.name, personality:personas[i], template:a.config.template, riskProfile:profiles[i], maxOrderUsd:a.config.risk.maxNotionalUsd, riskPerTradePct:a.config.risk.riskPerTradePct, cash:x.cash, btc:x.qty, fees:x.fees, profit:x.cash+x.qty*mark-1000, equity:x.cash+x.qty*mark, fills:x.fills, decisions:x.decisions }; }).sort((a,b)=>b.profit-a.profit);
  const passiveProfit = 400 + (600/minutes[0].o)*mark - 1000;
  const out = { id, mode:'historical paper replay using hosted harness', inferenceMode:'compact paper: one model call per agent per minute, combined research and risk review', phase, reason, model:'qwen/qwen3.7-flash', historicalStart:new Date(start).toISOString(), historicalEnd:new Date(start+requestedMinutes*60000).toISOString(), completedMinutes, requestedMinutes, incompleteRound, calls, reportedCostUsd:spent, reservedUpperUsd:reserved, priorReportedCostUsd, priorReservedUpperUsd, totalReportedCostUsd:priorReportedCostUsd+spent, totalReservedUpperUsd:priorReservedUpperUsd+reserved, unknownCostCalls:unknown, price:mark, source:'Binance BTCUSDT historical candles; replay fixture, not Arkiv', initialCapitalUsd:1000, feePct:0.1, benchmark: { name:'Passive starting allocation', description:'Same starting $400 cash and $600 BTC, held without trades', profit: passiveProfit, equity: 1000 + passiveProfit }, rows };
  writeFileSync(resolve(dir,'leaderboard.json'),JSON.stringify(out,null,2)); writeFileSync(resolve(root,'paper-leaderboard.json'),JSON.stringify(out,null,2));
};
let reason = '6 hours completed';
try {
  for (let minute=0; minute<requestedMinutes; minute++) {
    simulatedNow = start+(minute+1)*60000;
    const bar = minutes[minute], recent = minuteData.slice(minute+1, minute+16);
    const closed = historical.filter((b:any) => b.t+14400000<=simulatedNow).slice(-240).map((b:any)=>({...b,t:b.t/1000}));
    const runs = await Promise.all(agents.map(async (a,i) => {
      const account=accounts[i];
      const ports:RuntimePorts = {
        inference:async()=>providers[i],
        live:async(symbol)=>observation('live_feed','Binance historical replay (closed minute; not live)',{bid:bar.c,ask:bar.c,minuteCandles:recent,simulation:true},simulatedNow,simulatedNow,symbol),
        history:async(symbol,limit)=>observation('arkiv_history','Binance historical replay fixture (not Arkiv)',{bars:closed.slice(-limit),entityKey:'binance-replay-fixture'},simulatedNow-14400000,simulatedNow,symbol),
        portfolio:async()=>({owner,portfolioId:a.portfolioId,sourceAtMs:simulatedNow,cashMicros:String(Math.floor(account.cash*1e6)),capacityMicros:'100000000',positions:[{symbol:'BTC',quantity:account.qty,paper:true}]}),
      };
      const run=store.claim(a,Math.floor(simulatedNow/60000),simulatedNow,simulatedNow+55000)!;
      await new MinuteHarness(store,ports,{now:()=>simulatedNow,compactPaper:true}).run(a,run);
      return store.run(run.id)!;
    }));
    if (budgetLimit) { incompleteRound=true; reason=unknown?'billing unknown; stopped with outstanding reservation':'inference reservation cap reached'; break; }
    if (runs.every((run) => run.status !== 'completed')) { incompleteRound=true; reason='all agents failed in the same round'; break; }
    for (let i=0;i<agents.length;i++) {
      const a=agents[i], account=accounts[i], run=runs[i], d=run.decision; let fill:any=null;
      const rejected = store.events(a.id, 100).some((e) => e.runId === run.id && e.kind === 'action_rejected');
      if (run.status==='completed' && !rejected && d && d.decision!=='hold' && d.symbol==='BTC') {
        const price=minutes[minute+1].o, requested=Number(d.notionalMicros)/1e6;
        const usd=Math.min(requested,a.config.risk.maxNotionalUsd,d.decision==='buy'?account.cash/1.001:account.qty*price);
        if (Number.isFinite(usd) && usd>=1) {
          const fee=usd*.001;
          if (d.decision==='buy') { account.cash-=usd+fee; account.qty+=usd/price; } else { account.cash+=usd-fee; account.qty-=usd/price; }
          account.fees+=fee; fill={at:new Date(simulatedNow).toISOString(),side:d.decision,price,usd,fee,runId:run.id}; account.fills.push(fill);
          store.recordPaperOutcome(a,run.id,{decision:d.decision,outcome:'filled',reason:'historical next-minute open, 0.1% fee',cash:account.cash,btc:account.qty},simulatedNow);
        }
      }
      account.decisions.push({id:run.id, status:run.status, error:run.error, decision:d, fill});
    }
    completedMinutes=minute+1; save('running');
    if (minute%5===0) console.log(JSON.stringify({minutes:completedMinutes,calls,spent,reserved}));
  }
} finally { save('complete',reason); store.close(); }
console.log(JSON.stringify({id,completedMinutes,calls,spent,reserved,unknown,reason,artifact:resolve(dir,'leaderboard.json')}));
