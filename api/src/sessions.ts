import { createHash, randomBytes } from "node:crypto";
import { getAddress, verifyMessage, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";

const cookieName = process.env.PERPETUA_SESSION_COOKIE ?? "perpetua_session";
if (!/^[A-Za-z0-9_-]+$/.test(cookieName)) throw new Error("Invalid session cookie name");
export const SESSION_COOKIE = cookieName;
export class WalletSessions {
  private challenges = new Map<string, { address: string; message: string; expires: number }>();
  private sessions = new Map<string, { address: string; expires: number }>();
  constructor(readonly origin: string) {}
  challenge(address: string, chainId: number, now = Date.now()) {
    const owner = getAddress(address);
    if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error("Invalid wallet network");
    for (const [k, c] of this.challenges) if (c.expires <= now) this.challenges.delete(k);
    if (this.challenges.size >= 1000) throw new Error("Too many pending sign-ins");
    const nonce = randomBytes(16).toString("hex"); const expires = now + 300000;
    const message = createSiweMessage({ address: owner, domain: new URL(this.origin).host, uri: this.origin, version: "1", chainId, nonce, issuedAt: new Date(now), expirationTime: new Date(expires), statement: "Sign in to VESTA. This does not authorize a transaction or transfer funds." });
    this.challenges.set(nonce, { address: owner, message, expires }); return { nonce, message };
  }
  async verify(nonce: string, signature: Hex, now = Date.now()) {
    const challenge = this.challenges.get(nonce); this.challenges.delete(nonce);
    if (!challenge || challenge.expires <= now || !await verifyMessage({ address: challenge.address as `0x${string}`, message: challenge.message, signature })) throw new Error("Invalid or expired sign-in signature");
    for (const [k, s] of this.sessions) if (s.expires <= now) this.sessions.delete(k);
    if (this.sessions.size >= 10000) throw new Error("Session limit reached");
    const token = randomBytes(32).toString("hex"); const session = { address: challenge.address, expires: now + 12 * 3600000 };
    this.sessions.set(this.hash(token), session); return { token, ...session };
  }
  private hash(token: string) { return createHash("sha256").update(token).digest("hex"); }
  token(cookie?: string) { return cookie?.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1); }
  read(cookie?: string, now = Date.now()) {
    const token = this.token(cookie); if (!token) return null;
    const hash = this.hash(token); const session = this.sessions.get(hash);
    if (!session || session.expires <= now) { this.sessions.delete(hash); return null; } return { ...session };
  }
  logout(cookie?: string) { const token = this.token(cookie); if (token) this.sessions.delete(this.hash(token)); }
  cookie(token: string) { return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${this.origin.startsWith("https:") ? "; Secure" : ""}`; }
}
