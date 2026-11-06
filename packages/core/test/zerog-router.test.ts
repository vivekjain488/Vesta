import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZeroGRouterBrain, ZeroGServiceError, routerCapitalPolicy } from "../../../agent/src/zerog-router";
import { compileStrategy } from "../../../agent/src/strategy-compiler";
import { templateConfig, tierFor } from "../src";
const directories: string[]=[];
afterEach(()=>{for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true});});
const cfg = { apiKey: "test-key", baseUrl: "https://router.example/v1", modelSmall: "small", modelLarge: "large", maxTokensPerHour: 20000, maxTokensPerDay: 50000 };
const policy = {...tierFor(72),maxPromptTokens:4000};
const reply = (trace: any = {tee_verified:true,billing:{currency:"0g",total_cost:"1000000000000000"}}, content='{"sentiment":0.2}') => new Response(JSON.stringify({id:"provider-chat",model:"small",choices:[{message:{content},finish_reason:"stop"}],usage:{total_tokens:20},x_0g_trace:{request_id:"request-1",provider:"provider-1",...trace}}),{headers:{"X-Request-ID":"request-1"}});

describe("0G Router",()=>{
 it("uses backend Bearer auth and requests verification; never invents an on-chain signature",async()=>{
  let sent:any;
  const brain=new ZeroGRouterBrain(cfg,(async(url,init)=>{sent={url,init};return reply();}) as typeof fetch);
  const r=await brain.think(policy,[{role:"user",content:"Test"}],80);
  expect(sent.url).toBe("https://router.example/v1/chat/completions");
  expect(sent.init.headers.authorization).toBe("Bearer test-key");
  expect(sent.init.headers["X-0G-Provider-Trust-Mode"]).toBe("verified");
  expect(sent.init.headers["X-0G-Provider-Sort"]).toBe("latency");
  expect(JSON.parse(sent.init.body)).toMatchObject({model:"small",verify_tee:true,stream:false});
  expect(r).toMatchObject({verified:true,tee:null,costOg:0.001,chatId:"request-1",verificationSource:"0g-router"});
  expect(r?.latencyMs).toBeGreaterThanOrEqual(0);
  await expect(brain.ledgerOg()).rejects.toThrow("management key");
  await expect(brain.depositOg(1)).rejects.toThrow("direct SDK");
 });
 it("supports price routing explicitly and rejects invalid sorting",async()=>{
  let sort="";
  const brain=new ZeroGRouterBrain({...cfg,providerSort:"price"},(async(_url,init)=>{sort=(init?.headers as Record<string,string>)["X-0G-Provider-Sort"];return reply();}) as typeof fetch);
  await brain.think(policy,[{role:"user",content:"Test"}],10);expect(sort).toBe("price");
  expect(()=>new ZeroGRouterBrain({...cfg,providerSort:"fastest"})).toThrow("ZG_PROVIDER_SORT");
 });
 it("applies optional provider price ceilings and rejects invalid values",async()=>{
  let headers:Record<string,string>={};
  const brain=new ZeroGRouterBrain({...cfg,maxPromptUsdPerMillion:"0.5",maxCompletionUsdPerMillion:"2"},(async(_url,init)=>{headers=init?.headers as Record<string,string>;return reply();}) as typeof fetch);
  await brain.think(policy,[{role:"user",content:"Test"}],10);
  expect(headers["X-0G-Provider-Max-Price-Usd-Prompt"]).toBe("0.5");expect(headers["X-0G-Provider-Max-Price-Usd-Completion"]).toBe("2");
  expect(()=>new ZeroGRouterBrain({...cfg,maxPromptUsdPerMillion:"-1"})).toThrow("price caps");
 });
 it("only disables thinking for 0GM when explicitly configured",async()=>{
  let body:any;
  const send=(async(_url:any,init:any)=>{body=JSON.parse(init.body);return reply();}) as typeof fetch;
  await new ZeroGRouterBrain({...cfg,modelSmall:"0gm-1.0-35b-a3b",disable0gmThinking:true},send).think(policy,[{role:"user",content:"Test"}],10);
  expect(body.chat_template_kwargs).toEqual({enable_thinking:false});
  await new ZeroGRouterBrain({...cfg,disable0gmThinking:true},send).think(policy,[{role:"user",content:"Test"}],10);
  expect(body.chat_template_kwargs).toBeUndefined();
 });
 it("explains unavailable verified providers and model access without retries",async()=>{
  for(const [status,code,expected] of [[503,"no_provider_for_trust_mode",/No verified 0G provider/],[403,"model_not_allowed",/not allowed to use model/]] as const){
   let calls=0;const brain=new ZeroGRouterBrain(cfg,(async()=>{calls++;return new Response(JSON.stringify({error:{code}}),{status});}) as typeof fetch);
   await expect(brain.think(policy,[{role:"user",content:"Test"}],10)).rejects.toThrow(expected);expect(calls).toBe(1);
  }
 });
 it("distinguishes insufficient credits from authentication and never retries a billed call",async()=>{
  let calls=0;
  const brain=new ZeroGRouterBrain(cfg,(async()=>{calls++;return new Response(JSON.stringify({error:{code:"insufficient_balance"}}),{status:402});}) as typeof fetch);
  await expect(brain.think(policy,[{role:"user",content:"Hi"}],10)).rejects.toMatchObject({status:402,code:"insufficient_balance"});
  expect(await brain.think(policy,[{role:"user",content:"Hi"}],10)).toBeNull();expect(calls).toBe(1);
 });
 it("preserves unknown cost and verification; rejects unverified strategy output",async()=>{
  const config=templateConfig("spot-dca");
  const content=JSON.stringify({config,assumptions:[],unsupportedRequirements:[]});
  const brain=new ZeroGRouterBrain(cfg,(async()=>reply({billing:{currency:"usd",total_cost:"100"}},content)) as typeof fetch);
  const r=await brain.think(policy,[{role:"user",content:"Hi"}],20);
  expect(r?.verified).toBeNull();expect(Number.isNaN(r?.costOg)).toBe(true);
  await expect(compileStrategy(brain,"Buy BTC with limited exposure")).rejects.toThrow("verified 0G");
 });
 it("compiles a verified Router draft through the same strict schema",async()=>{
  const config=templateConfig("spot-dca");
  const brain=new ZeroGRouterBrain(cfg,(async()=>reply(undefined,JSON.stringify({config,assumptions:["closed 4h candles"],unsupportedRequirements:[]}))) as typeof fetch);
  const draft=await compileStrategy(brain,"Buy BTC with limited exposure");
  expect(draft.config).toEqual(config);expect(draft.proof.verificationSource).toBe("0g-router");expect(draft.status).toBe("draft");
 });
 it("persists conservative token reservations across restarts and treats timeouts as unknown",async()=>{
  const d=mkdtempSync(join(tmpdir(),"0g-cap-"));directories.push(d);
  const budget={...cfg,stateFile:join(d,"budget.json"),maxTokensPerHour:90,maxTokensPerDay:90};
  const failed=new ZeroGRouterBrain(budget,(async()=>{throw Error("network failure test-key");}) as typeof fetch);
  await expect(failed.think(policy,[{role:"user",content:"A"}],40)).rejects.toThrow(ZeroGServiceError);
  let called=false;
  const again=new ZeroGRouterBrain(budget,(async()=>{called=true;return reply();}) as typeof fetch);
  expect(await again.think(policy,[{role:"user",content:"A"}],40)).toBeNull();expect(called).toBe(false);
 });
 it("keeps capital-based model choice separate from an unknown Router balance",()=>{
  const config=templateConfig("spot-dca");
  expect(routerCapitalPolicy(config,10).model).toBeNull();expect(routerCapitalPolicy(config,100).model).toBe("small");expect(routerCapitalPolicy(config,10000).model).toBe("large");
 });
});
