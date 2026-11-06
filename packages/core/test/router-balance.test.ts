import { describe, expect, it, vi } from "vitest";
import { readRouterBalance } from "../../../agent/src/router-balance";
const address = `0x${"11".repeat(20)}`;
const options = { baseUrl: "https://router-api.0g.ai/v1", managementKey: "mk-test", expectedAddress: address };
const send = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const sample = { address, currency: "usd", total_balance: "5000000", pending_charge: "200000", unsettled_charge: "100000" };
describe("0G Router balance", () => {
  it("deducts pending and unsettled charges without counting the shared payment vault", async () => {
    expect(await readRouterBalance({ ...options, send: send(sample) })).toMatchObject({ currency: "usd", conservativeLedgerBalance: 4700000n });
  });
  it("floors debts at zero", async () => {
    expect((await readRouterBalance({ ...options, send: send({ ...sample, pending_charge: "6000000" }) })).conservativeLedgerBalance).toBe(0n);
  });
  it("rejects unexpected accounts, currencies, data, and insufficient key scope", async () => {
    for (const body of [{ ...sample, address: `0x${"22".repeat(20)}` }, { ...sample, currency: "eur" }, { ...sample, pending_charge: "-1" }]) await expect(readRouterBalance({ ...options, send: send(body) })).rejects.toThrow();
    await expect(readRouterBalance({ ...options, send: send({}, 403) })).rejects.toThrow("HTTP 403");
    await expect(readRouterBalance({ ...options, managementKey: "sk-test", send: send(sample) })).rejects.toThrow("management key");
  });
});
