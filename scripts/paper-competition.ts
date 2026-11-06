import '../agent/src/config';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {applyRiskProfile, configHash, RISK_PROFILES, templateConfig, type RiskProfile} from '@perpetua/core';
import {createInference, InferenceServiceError} from '../agent/src/inference';
import {defaultPorts} from '../agent/src/runtime/ports';
import {MinuteHarness} from '../agent/src/runtime/run';
import {RuntimeStore} from '../agent/src/runtime/store';
import {observation} from '../agent/src/runtime/tools';

const root=process.env.PERPETUA_STATE_DIR!, runId=`paper-${Date.now()}`;
const dir=resolve(root,'competitions',runId); mkdirSync(dir,{recursive:true});
const store=new RuntimeStore(resolve(dir,'runtime.sqlite'));
const owner=`0x${'11'.repeat(20)}`, portfolioId='paper-competition';
store.bindPortfolio({id:portfolioId,owner,chainId:31337,rpc:'http://127.0.0.1:8545',vault:owner,wallet:owner,riskGate:owner,stable:owner});
const defaults=defaultPorts();
const initialQuote:any=(await defaults.live('BTC','spot',AbortSignal.timeout(10000))).data;
const initialMid=(Number(initialQuote.bid)+Number(initialQuote.ask))/2;
let candleCache: {until:number; promise:Promise<any>} | undefined;
const minuteCandles=()=>{if(!candleCache||Date.now()>candleCache.until){const promise=fetch('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=16',{signal:AbortSignal.timeout(8000)}).then(async r=>{if(!r.ok)throw Error(`Minute data HTTP ${r.status}`);const rows:any=await r.json();if(!Array.isArray(rows))throw Error('Invalid minute candles');return rows.map((x:any)=>({openTime:x[0],open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5]),closed:x[6]<Date.now()}));});candleCache={until:Date.now()+5000,promise};}return candleCache.promise;};
const accounts=new Map<string,{cash:number;qty:number;fees:number;fills:any[];validations:any[]}>();
let reserved=0, spent=0, calls=0, unknown=0;
const send:typeof fetch=async(url,init)=>{
 const b=JSON.parse(String(init!.body)); if(b.model!=='qwen/qwen3.7-flash') throw Error('unexpected model');
 const bytes=Buffer.byteLength(JSON.stringify(b.messages))+512; b.max_tokens=Math.min(b.max_tokens,768);
 const upper=(bytes*.05/1e6+b.max_tokens*.2/1e6)*1.25;
 if(bytes>18000||reserved+upper>.03||calls>=70) throw new InferenceServiceError(429,'paper_budget_exhausted','Competition inference reservation limit reached before submission.');
 reserved+=upper; calls++; b.reasoning={enabled:false}; b.provider={allow_fallbacks:false,max_price:{prompt:.05,completion:.2,request:0}};
 const response=await fetch(url,{...init,body:JSON.stringify(b)}); const data:any=await response.clone().json().catch(()=>({}));
 if(typeof data.usage?.cost==='number') spent+=data.usage.cost; else unknown++;
 return response;
};
const names=['Momentum','Range','Accumulator','Cautious','Breakout','Mean Reversion','Patient'];
const personalities=['Follow sustained minute-to-minute momentum, and reduce exposure if momentum reverses.', 'Look for short-term overextension and reversions within the minute price range.', 'Accumulate gradually when price and spread make the purchase reasonable, and reduce risk when conditions deteriorate.', 'Prioritize capital preservation, demand stronger evidence, and sell if risk rises.', 'Watch recent minute highs and lows for credible breakouts and failed breakouts.', 'Look for short-term moves away from the recent minute average followed by reversion.', 'Be selective and patient; compare the latest price to prior minutes before deciding.'];
const profiles:RiskProfile[]=['aggressive','balanced','cautious','cautious','aggressive','balanced','cautious'];
const templates=['spot-momentum','spot-bollinger','spot-dca','spot-rsi-recovery','spot-breakout','spot-range','spot-dca'] as const;
const agents=names.map((name,i)=>{const config=applyRiskProfile(templateConfig(templates[i]),profiles[i]); config.symbols=['BTC']; accounts.set(name,{cash:400,qty:600/initialMid,fees:0,fills:[],validations:[]}); return store.activate({id:`competition-${i}`,owner,name,revision:1,config,configHash:configHash(config),instructions:`Your distinct personality: ${personalities[i]} ${RISK_PROFILES[profiles[i]].instructions} This is an experimental one-minute paper strategy: use the live one-minute BTC candle sequence, quote, your personality and portfolio as primary evidence. The supplied 4h template and its deterministic score describe a different, longer horizon and are background context rather than mandatory entry gates for this experimental paper contest. Evaluate both possible increasing and reducing exposure, relative to spread, 0.1% transaction fee and your actual simulated holdings. You already own BTC, so selling to reduce risk does not require a new long-entry signal. Independently choose buy, sell or hold; do not trade merely to satisfy the test. Explain the specific prices, upside/downside, fees and risk that led to your choice. Maximum $${config.risk.maxNotionalUsd} per virtual order.`,portfolioId,mode:'analysis',status:'active'});});
const providers=new Map();
const ports={...defaults,live:async(symbol:string,market:any,signal:AbortSignal)=>{const [q,candles]=await Promise.all([defaults.live(symbol,market,signal),minuteCandles()]);signal.throwIfAborted();return observation('live_feed',q.source,{...(q.data as object),minuteCandles:candles,minuteDataSource:'Binance spot 1m klines; last candle may be open'},q.sourceAtMs,Date.now(),symbol);},inference:async(a:any)=>{if(!providers.has(a.id)) providers.set(a.id,createInference({args:['--openrouter'],env:{...process.env,OPENROUTER_MODEL:'qwen/qwen3.7-flash'},send}));return providers.get(a.id);},portfolio:async()=>({portfolioId,owner,sourceAtMs:Date.now(),cashMicros:'1000000000',capacityMicros:'100000000',positions:[],source:'paper fixture; individual simulated balances supplied in agent instructions'}),executor:undefined};
const harness=new MinuteHarness(store,ports), started=Date.now(), end=started+300000;
const datasheets:any[]=[];
const save=(phase:string,price:number|null)=>{const rows=agents.map((a,i)=>{const x=accounts.get(a.name)!; const value=x.cash+x.qty*(price??0);return {name:a.name,personality:personalities[i],template:a.config.template,riskProfile:profiles[i],maxOrderUsd:a.config.risk.maxNotionalUsd,riskPerTradePct:a.config.risk.riskPerTradePct,profit:price===null?null:value-1000,equity:price===null?null:value,cash:x.cash,btc:x.qty,fees:x.fees,fills:x.fills,validations:x.validations,decisions:store.runs(a.id).map(({snapshot,...r})=>r)};}).sort((a,b)=>(b.profit??-Infinity)-(a.profit??-Infinity)); const result={id:runId,mode:'paper',strategyHorizon:'experimental one-minute paper strategies; four-hour templates are background context',initialMid,datasheets,phase,startedAt:started,endsAt:end,updatedAt:Date.now(),price,model:'qwen/qwen3.7-flash',reportedCostUsd:spent,reservedUpperUsd:reserved,calls,unknownCostCalls:unknown,rows};writeFileSync(resolve(dir,'leaderboard.json'),JSON.stringify(result,null,2));writeFileSync(resolve(root,'paper-leaderboard.json'),JSON.stringify(result,null,2));};
let lastPrice:number|null=null;
try {for(let round=0;round<5;round++) {const due=started+round*60000; if(Date.now()<due) await new Promise(r=>setTimeout(r,due-Date.now())); 
// Bind account context into each run's own observations without modifying signed agent definitions.
await Promise.all(agents.map(async(a,i)=>{const now=Date.now(),run=store.claim(a,Math.floor(now/60000),now,now+55000);if(!run)return; const perAgent={...ports,portfolio:async()=>{const x=accounts.get(a.name)!;return {portfolioId,owner,sourceAtMs:Date.now(),cashMicros:String(Math.floor(x.cash*1e6)),capacityMicros:'100000000',positions:[{symbol:'BTC',quantity:x.qty,paper:true}]};}}; await new MinuteHarness(store,perAgent).run(a,run); }));
const quote=await defaults.live('BTC','spot',AbortSignal.timeout(10000)); const q:any=quote.data; const bid=Number(q.bid),ask=Number(q.ask); lastPrice=(bid+ask)/2; datasheets.push({round:round+1,at:Date.now(),bid,ask,mid:lastPrice,source:quote.source,sourceAtMs:quote.sourceAtMs,candles:await minuteCandles()});
for(const a of agents){
 const run=store.runs(a.id,1)[0], x=accounts.get(a.name)!;
 if(!run || run.startedAtMs<due-1000) continue;
 const d=run.decision!;
 const log=(outcome:string,reason:string)=>{x.validations.push({runId:run.id,decision:d?.decision,outcome,reason});store.recordPaperOutcome(a,run.id,{decision:d?.decision??'error',outcome,reason,cash:x.cash,btc:x.qty});};
 if(run.status!=='completed'){log('rejected',run.error??'run failed');continue;}
 if(store.events(a.id,100).some(e=>e.runId===run.id&&e.kind==='tool_failed')){log('rejected','required market input unavailable');continue;}
 if(d.decision==='hold'){log('hold','no trade proposed');continue;}
 if(d.symbol!=='BTC'){log('rejected','unsupported symbol');continue;}
 const requested=Number(d.notionalMicros)/1e6;
 if(!Number.isFinite(requested)||requested<=0){log('rejected','invalid order size');continue;}
 if(Date.now()-quote.sourceAtMs>10000){log('rejected','execution quote stale');continue;}
 const available=d.decision==='buy'?x.cash/1.001:x.qty*bid;
 const usd=Math.min(requested,a.config.risk.maxNotionalUsd,available);
 if(usd<1){log('rejected','insufficient virtual cash or BTC');continue;}
 const fee=usd*.001;
 if(d.decision==='buy'&&x.cash>=usd+fee){x.cash-=usd+fee;x.qty+=usd/ask;}
 else if(d.decision==='sell'&&x.qty>=usd/bid){x.cash+=usd-fee;x.qty-=usd/bid;}
 else {log('rejected','insufficient virtual cash or BTC');continue;}
 x.fees+=fee;x.fills.push({at:Date.now(),side:d.decision,requestedUsd:requested,notionalUsd:usd,price:d.decision==='buy'?ask:bid,fee,source:quote.source,sourceAtMs:quote.sourceAtMs,runId:run.id});log('filled',`simulated at fresh bid/ask with 0.1% fee; requested $${requested.toFixed(2)}, filled $${usd.toFixed(2)}${usd+0.000001<requested?' (partial due to order cap or available balance)':''}`);
}
save('running',lastPrice); console.log(JSON.stringify({round:round+1,elapsedMs:Date.now()-started,calls,spent}));}
if(Date.now()<end)await new Promise(r=>setTimeout(r,end-Date.now()));try {const q:any=(await defaults.live('BTC','spot',AbortSignal.timeout(10000))).data;lastPrice=(Number(q.bid)+Number(q.ask))/2;}catch{lastPrice=null;}save('complete',lastPrice);console.log(JSON.stringify({complete:true,runId,calls,spent,artifact:resolve(dir,'leaderboard.json')}));} finally {store.close();}
