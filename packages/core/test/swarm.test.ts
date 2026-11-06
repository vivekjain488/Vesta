import { describe, expect, it } from "vitest";
process.env.SWARM_POSTAGE_BATCH_ID = "ab".repeat(32);
process.env.SWARM_BEE_URL = "http://bee.test:1633";
process.env.ARKIV_DATA_KEY = "22".repeat(32);
const { gatewayLink, splitReference, swarmDownloadJson, swarmUploadJson } = await import("../../../arkiv/src/swarm");
const { seal, unseal } = await import("../../../arkiv/src/sealed");

const ENC = "a".repeat(64) + "b".repeat(64), PUB = "c".repeat(64);
describe("Swarm storage", () => {
  it("uploads encrypted with the postage batch and returns address + key", async () => {
    let sent: any;
    const up = await swarmUploadJson({ x: 1 }, { encrypt: true, name: "t.json" }, (async (url: string, init: any) => { sent = { url, init }; return new Response(JSON.stringify({ reference: ENC }), { status: 201 }); }) as any);
    expect(sent.url).toBe("http://bee.test:1633/bzz?name=t.json");
    expect(sent.init.headers["swarm-encrypt"]).toBe("true");
    expect(sent.init.headers["swarm-postage-batch-id"]).toBe("ab".repeat(32));
    expect(up).toMatchObject({ encrypted: true, address: "a".repeat(64) });
    expect(splitReference(ENC).key).toBe("b".repeat(64));
  });
  it("rejects a reference type that does not match the request", async () => {
    await expect(swarmUploadJson({}, { encrypt: true }, (async () => new Response(JSON.stringify({ reference: PUB }), { status: 201 })) as any)).rejects.toThrow("unexpected reference");
  });
  it("only links unencrypted references on public gateways", () => {
    expect(gatewayLink(PUB)).toBe(`https://api.gateway.ethswarm.org/bzz/${PUB}/`);
    expect(() => gatewayLink(ENC)).toThrow();
  });
  it("reads back through Bee, and the encrypted reference is only ever stored sealed", async () => {
    const body = await swarmDownloadJson(ENC, (async (url: string) => { expect(url).toBe(`http://bee.test:1633/bzz/${ENC}/`); return new Response(JSON.stringify({ body: { stop: 1 } })); }) as any);
    expect(body).toEqual({ body: { stop: 1 } });
    const onArkiv = new TextDecoder().decode(seal("uid-1", { swarm: { reference: ENC } }));
    expect(onArkiv).not.toContain("b".repeat(16)); // the key half never appears in the public entity
    expect(unseal("uid-1", new TextEncoder().encode(onArkiv)).value).toEqual({ swarm: { reference: ENC } });
  });
});
