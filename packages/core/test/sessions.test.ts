import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { WalletSessions } from "../../../api/src/sessions";
const alice = privateKeyToAccount(`0x${"11".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"22".repeat(32)}`);

describe("wallet sign-in", () => {
  it("requires a signature, consumes its nonce and expires or logs out the session", async () => {
    const sessions = new WalletSessions("http://localhost:3000");
    const now = Date.now();
    const c = sessions.challenge(alice.address, 31337, now);
    expect(c.message).toContain("localhost:3000 wants you to sign in");
    const signature = await alice.signMessage({ message: c.message });
    const s = await sessions.verify(c.nonce, signature, now);
    const cookie = sessions.cookie(s.token);
    expect(cookie).toContain("HttpOnly; SameSite=Strict");
    expect(sessions.read(cookie, now)?.address).toBe(alice.address);
    expect(sessions.read(cookie, s.expires)).toBeNull();
    await expect(sessions.verify(c.nonce, signature, now)).rejects.toThrow();
    const c2 = sessions.challenge(alice.address, 31337, now);
    const s2 = await sessions.verify(c2.nonce, await alice.signMessage({ message: c2.message }), now);
    sessions.logout(sessions.cookie(s2.token));
    expect(sessions.read(sessions.cookie(s2.token), now)).toBeNull();
  });
  it("rejects another wallet, expired challenges and concurrent replay", async () => {
    const sessions = new WalletSessions("http://localhost:3000"); const now = Date.now();
    const wrong = sessions.challenge(alice.address, 31337, now);
    await expect(sessions.verify(wrong.nonce, await bob.signMessage({ message: wrong.message }), now)).rejects.toThrow();
    const old = sessions.challenge(alice.address, 31337, now);
    await expect(sessions.verify(old.nonce, await alice.signMessage({ message: old.message }), now + 300000)).rejects.toThrow();
    const c = sessions.challenge(alice.address, 31337, now); const sig = await alice.signMessage({ message: c.message });
    const results = await Promise.allSettled([sessions.verify(c.nonce, sig, now), sessions.verify(c.nonce, sig, now)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
