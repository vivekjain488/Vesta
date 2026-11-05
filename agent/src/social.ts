/**
 * Agents post themselves. X API v2 (POST /2/tweets) with an OAuth2 user-context token. Without a token the
 * post goes to the console + .perpetua/posts.jsonl (which the Arena feed also reads).
 */
import { appendFileSync, mkdirSync } from "node:fs";

export class XPoster {
  constructor(
    private readonly agentName: string,
    private readonly token: string,
  ) {
    mkdirSync(process.env.PERPETUA_STATE_DIR ?? ".perpetua", { recursive: true });
  }

  async post(text: string, proof: Record<string, string | undefined> = {}) {
    const links = Object.entries(proof)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" | ");
    const body = (links ? `${text}\n${links}` : text).slice(0, 280);
    appendFileSync(`${process.env.PERPETUA_STATE_DIR ?? ".perpetua"}/posts.jsonl`, JSON.stringify({ at: Date.now(), agent: this.agentName, text: body, proof }) + "\n");
    if (!this.token) {
      console.log(`[x:${this.agentName}] ${body.replace(/\n/g, " ⏎ ")}`);
      return null;
    }
    const res = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    if (!res.ok) console.warn(`[x] post failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.ok ? ((await res.json()) as any).data?.id : null;
  }
}
