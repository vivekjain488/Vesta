import { describe, expect, it } from "vitest";
import { SimSettlement } from "../../../agent/src/simSettlement";
const order = { wallet: "0x01", tokenIn: "0x02", tokenOut: "0x03", amountIn: 10n, amountOut: 8n } as any;
function client(statuses: string[]) {
 const calls: string[] = []; let count = 0;
 return { calls, instance: { account: {}, chain: {}, wallet: { writeContract: async (args: any) => { calls.push(args.functionName); return `0x${++count}`; } }, pub: { waitForTransactionReceipt: async () => ({ status: statuses.shift() }) } } as any };
}
describe("local settlement receipts", () => {
 it("does not credit output when the input transfer reverted", async () => {
  const c = client(["reverted"]);
  await expect(new SimSettlement(c.instance).fillExit(order)).rejects.toThrow("no output was credited");
  expect(c.calls).toEqual(["transferFrom"]);
 });
 it("rejects an unconfirmed output and returns the actual credit receipt on success", async () => {
  const failed = client(["success", "reverted"]);
  await expect(new SimSettlement(failed.instance).fillEntry(order)).rejects.toThrow("reconcile the input transfer");
  const ok = client(["success", "success"]);
  expect(await new SimSettlement(ok.instance).fillExit(order)).toBe("0x2");
  expect(ok.calls).toEqual(["transferFrom", "mint"]);
 });
});
