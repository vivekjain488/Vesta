import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { investments, saveExitRequest } from "../../../api/src/investments";
import { AgentSupervisor } from "../../../agent/src/supervisor";
import { PaperHarness } from "../../../agent/src/harness";
import { AgentDefinitions } from "../../../api/src/agent-definitions";
import { configHash, templateConfig, type AgentDefinition, type Bar } from "../src";
import type { Brain } from "../../../agent/src/zerog";
import type { Address } from "viem";

const owner = `0x${"11".repeat(20)}` as Address;
const token = `0x${"22".repeat(20)}` as Address;
const stable = `0x${"33".repeat(20)}` as Address;
const temporary: string[] = [];
const dir = () => { const path = mkdtempSync(join(tmpdir(), "perpetua-withdraw-")); temporary.push(path); return path; };
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const definition = (): AgentDefinition => { const config = templateConfig("perp-trend"); config.symbols = ["BTC"]; return { id: "agent-1", owner, name: "A", revision: 1, status: "paper", config, configHash: configHash(config), createdAt: 0, updatedAt: 0 }; };

describe("investment dashboard and exit intent", () => {
  it("reads actual holdings and reports a losing position without blocking it", async () => {
    const read = async (address: Address, _abi: any, name: string) => {
      switch (name) {
        case "agentOwner": return owner;
        case "idle": return 50_000_000n;
        case "safeValue": return 800_000_000n;
        case "balanceOf": return address === token ? 10n * 10n ** 18n : address === stable ? 20_000_000n : 1000n;
        case "maxWithdraw": return 870_000_000n;
        case "maxRedeem": return 900n;
        case "withdrawalPaused": return false;
        case "minimumOperatingCapital": return 25_000_000n;
        case "assetCount": return 1n;
        case "assetList": return token;
        case "assets": return [true, 18, 500];
        case "symbol": return "LINK";
        default: throw new Error(name);
      }
    };
    const p = await investments(read, { usdc: stable }, { vault: owner, riskGate: owner, wallet: owner }, [{ status: "open", asset: "LINK", qty: "10", sizeUsd: 150 }], async () => 100);
    expect(p.investments[0].valueUsd).toBe(70);
    expect(p.investments[2].amount).toBe("10");
    expect(p.investments[2].unrealizedPnlUsd).toBe(-50);
    expect(p.exitExecutionAvailable).toBe(false);
    const request = saveExitRequest(dir(), owner, { agent: "Atlas", token, amount: "10000000000000000000", minProceedsUsdc: "99000000", allowLoss: true, owner: stable, receiver: stable });
    expect(request.owner).toBe(owner);
    expect(request.receiver).toBe(owner);
    expect(request.status).toBe("blocked_adapter_unavailable");
  });
  it("rejects zero exits and missing loss consent", () => {
    const p = { agent: "Atlas", token, amount: "1", minProceedsUsdc: "1", allowLoss: true };
    expect(() => saveExitRequest(dir(), owner, { ...p, amount: "0" })).toThrow();
    expect(() => saveExitRequest(dir(), owner, { ...p, allowLoss: false })).toThrow();
    expect(() => saveExitRequest(dir(), owner, { ...p, minProceedsUsdc: "0" })).toThrow();
  });
  it("persists signed-config sleep without changing the strategy or another owner's agent", () => {
    const store = new AgentDefinitions(dir(), "http://localhost");
    const initial = store.save(owner, { name: "A", status: "paper", config: definition().config });
    const sleeping = store.save(owner, { name: "A", status: "sleeping", config: initial.config, revision: initial.revision }, initial.id);
    expect(sleeping.status).toBe("sleeping"); expect(sleeping.configHash).toBe(initial.configHash);
    expect(() => store.save(stable, { name: "A", status: "paper", config: sleeping.config, revision: sleeping.revision }, initial.id)).toThrow("does not own");
  });
});

describe("sleep while a hosted cycle is in flight", () => {
  it("disables scheduling immediately and signals the current worker", async () => {
    let release!: () => void; let calls = 0; let slept = false;
    const supervisor = new AgentSupervisor(async () => ({ tick: async () => { calls++; await new Promise<void>((r) => { release = r; }); }, sleep: () => { slept = true; } }), () => {});
    const d = definition(); await supervisor.reconcile([d]);
    const pending = supervisor.step(0);
    await supervisor.reconcile([{ ...d, status: "sleeping", revision: 2 }]);
    expect(slept).toBe(true); await supervisor.step(100000); expect(calls).toBe(1);
    release(); await pending;
    await supervisor.reconcile([{ ...d, status: "sleeping", revision: 2 }]);
    expect(supervisor.status()).toHaveLength(0);
    await supervisor.stop();
  });
  it("does not evaluate or fetch an execution quote after sleep during inference", async () => {
    const now = 4_000_000;
    const bars: Bar[] = Array.from({ length: 240 }, (_, i) => { const c = 50 + i * 0.2 + (i === 239 ? 2 : 0); return { t: now - (240 - i) * 14400, o: c - 0.1, h: c + 0.1, l: c - 0.2, c, v: 1000 }; });
    let resolveBrain!: (value: any) => void;
    let started!: () => void;
    const thinking = new Promise<void>((r) => { started = r; });
    let quoted = false;
    const brain = { mode: "live", ledgerOg: async () => 100, think: async () => { started(); return new Promise((r) => { resolveBrain = r; }); } } as unknown as Brain;
    const harness = new PaperHarness(definition(), { market: async () => ({ bars, source: "fixture", fetchedAt: now }), account: async () => ({ equityUsd: 1000 } as any), execution: async () => { quoted = true; return {} as any; } }, () => {}, brain, () => now);
    const pending = harness.tick(); await thinking; harness.sleep();
    resolveBrain({ verified: true, costOg: 0.01, content: '{"actions":[{"tool":"evaluate"}]}' });
    await pending; expect(quoted).toBe(false); expect(await harness.tick()).toEqual({ skipped: true });
  });
});
