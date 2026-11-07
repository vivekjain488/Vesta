import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayLink, swarmDownloadJson, swarmUploadJson } from "../../../arkiv/src/swarm";

afterEach(() => vi.unstubAllEnvs());

describe("standalone Swarm client", () => {
  it("uploads encrypted JSON and downloads it using the returned reference", async () => {
    vi.stubEnv("SWARM_BEE_URL", "http://bee.test");
    vi.stubEnv("SWARM_POSTAGE_BATCH_ID", "ab".repeat(32));
    const reference = "a".repeat(64) + "b".repeat(64);
    const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST" ? new Response(JSON.stringify({ reference }), { status: 201 }) : new Response('{"text":"✓"}'));
    const uploaded = await swarmUploadJson({ text: "✓" }, { encrypt: true }, send as typeof fetch);
    expect(uploaded).toMatchObject({ address: "a".repeat(64), encrypted: true, size: 14 });
    expect((send.mock.calls[0][1]?.headers as Record<string, string>)["swarm-encrypt"]).toBe("true");
    expect(await swarmDownloadJson(uploaded.reference, send as typeof fetch)).toEqual({ text: "✓" });
  });

  it("rejects encrypted or invalid public references", () => {
    expect(() => gatewayLink("a".repeat(128))).toThrow();
    expect(() => gatewayLink("z".repeat(64))).toThrow();
  });
});
