import { describe, expect, it } from "vitest";
process.env.ARKIV_DATA_KEY = "11".repeat(32);
const { seal, unseal, isSealed } = await import("../../../arkiv/src/sealed");

describe("sealed Arkiv payloads", () => {
  const record = { entry: 101.5, stop: 98, target: 112, reasoning: "breakout with volume", flashOrderId: "abc" };
  it("round-trips and hides the plaintext", () => {
    const bytes = seal("trade-1", record);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("breakout");
    expect(isSealed(bytes)).toBe(true);
    expect(unseal("trade-1", bytes)).toEqual({ sealed: true, value: record });
    // Arkiv returns payloads as hex strings
    expect(unseal("trade-1", `0x${Buffer.from(bytes).toString("hex")}`).value).toEqual(record);
  });
  it("is bound to its record and detects tampering", () => {
    const bytes = seal("trade-1", record);
    expect(() => unseal("trade-2", bytes)).toThrow();
    const env = JSON.parse(new TextDecoder().decode(bytes));
    const ct = Buffer.from(env.ct, "base64"); ct[0] ^= 1; env.ct = ct.toString("base64");
    expect(() => unseal("trade-1", new TextEncoder().encode(JSON.stringify(env)))).toThrow();
  });
  it("passes plain (legacy) payloads through", () => {
    expect(unseal("x", new TextEncoder().encode(JSON.stringify({ a: 1 })))).toEqual({ sealed: false, value: { a: 1 } });
  });
});
