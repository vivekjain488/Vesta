/**
 * Upstream signature sources.
 *  - 4byte.directory: open data, freely available for search and scraping, no licensing restrictions.
 *    Bulk path: paginated REST (/api/v1/signatures, /api/v1/event-signatures), 100 rows/page, ordered by id.
 *  - OpenChain: used ONLY as an independent per-selector cross-check (its bulk /export endpoint now returns
 *    404, see friction.md). Arkiv rule: data must not come from Sourcify, so OpenChain never seeds rows.
 */
import { keccak256, toBytes } from "viem";

export interface RawSignature {
  source: "4byte" | "openchain";
  kind: "function" | "event" | "error";
  selector: string;
  text: string;
  sourceId?: number;
  sourceCreatedAt?: string;
}

const FOURBYTE = process.env.FOURBYTE_BASE ?? "https://www.4byte.directory/api/v1";

async function getJson(url: string, tries = 4): Promise<any> {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "perpetua-signature-atlas/0.1" } });
    if (res.ok) return { body: await res.json(), etag: res.headers.get("etag") };
    if (i >= tries || (res.status < 500 && res.status !== 429)) throw new Error(`${url} -> ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // respect rate limits
  }
}

/** Page through 4byte in ascending id order starting after `afterId` (resumable cursor). */
export async function* fetch4byte(kind: "function" | "event", opts: { startPage?: number; maxPages?: number } = {}) {
  const path = kind === "function" ? "signatures" : "event-signatures";
  let page = opts.startPage ?? 1;
  let url: string | null = `${FOURBYTE}/${path}/?ordering=id&page=${page}`;
  let pages = 0;
  while (url && pages < (opts.maxPages ?? 10)) {
    const { body, etag } = await getJson(url);
    pages++;
    const rows: RawSignature[] = body.results.map((r: any) => ({
      source: "4byte",
      kind,
      selector: r.hex_signature.toLowerCase(),
      text: r.text_signature,
      sourceId: r.id,
      sourceCreatedAt: r.created_at,
    }));
    yield { rows, etag: etag ?? `count:${body.count}`, total: body.count as number, page: page++ };
    url = body.next ? String(body.next).replace(/^http:/, "https:") : null;
  }
}

/** Look up specific selectors on 4byte (the "hot set" seen in live calldata is imported first). */
export async function lookup4byte(selector: string, kind: "function" | "event"): Promise<RawSignature[]> {
  const path = kind === "function" ? "signatures" : "event-signatures";
  const { body } = await getJson(`${FOURBYTE}/${path}/?hex_signature=${selector}`);
  return body.results.map((r: any) => ({ source: "4byte", kind, selector: r.hex_signature.toLowerCase(), text: r.text_signature, sourceId: r.id, sourceCreatedAt: r.created_at }));
}

/** OpenChain cross-check for a batch of selectors. Returns selector -> list of text signatures. */
export async function openchainLookup(selectors: string[], kind: "function" | "event"): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < selectors.length; i += 50) {
    const chunk = selectors.slice(i, i + 50);
    const q = `${kind}=${chunk.join(",")}&filter=false`;
    try {
      const { body } = await getJson(`https://api.openchain.xyz/signature-database/v1/lookup?${q}`, 2);
      const m = body?.result?.[kind] ?? {};
      for (const [sel, list] of Object.entries<any>(m)) out.set(sel.toLowerCase(), (list ?? []).map((x: any) => x.name));
    } catch (e) {
      console.warn("[openchain] lookup failed, continuing without cross-check", (e as Error).message);
    }
  }
  return out;
}

/** Recompute the selector from the text: a row whose hash does not match its text is rejected outright. */
export function selectorOf(text: string, kind: RawSignature["kind"]): string {
  const h = keccak256(toBytes(text));
  return kind === "event" ? h : h.slice(0, 10);
}
