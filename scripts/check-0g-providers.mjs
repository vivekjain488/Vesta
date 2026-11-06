/** Free, read-only catalog check. It does not verify API-key model access or submit inference. */
import 'dotenv/config';

const base = (process.env.ZG_BASE_URL || 'https://router-api.0g.ai/v1').replace(/\/$/, '');
const url = new URL(base);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('ZG_BASE_URL must be an HTTPS URL');
const args = process.argv.slice(2).filter(arg => arg !== '--');
const models = [...new Set(args.length ? args : [process.env.ZG_MODEL_SMALL, process.env.ZG_MODEL_LARGE].filter(Boolean))];
if (!models.length) throw new Error('Set ZG_MODEL_SMALL or provide model IDs as arguments');
let failed = false;
const results = await Promise.all(models.map(async model => {
  try {
    const started = performance.now();
    const response = await fetch(`${base}/providers?model=${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.data)) throw new Error('Invalid provider catalog response');
    const rows = payload.data.filter(p => String(p.canonical_id ?? p.model_id).toLowerCase() === model.toLowerCase());
    const verified = rows.filter(p => p.is_healthy === true && (p.trust_mode === 'verified' || p.trust_mode === 'private'));
    return { model, lookupMs: Math.round(performance.now() - started), providers: rows.length, healthyVerifiedProviders: verified.length, healthyStandardOnly: rows.filter(p => p.is_healthy === true && p.trust_mode === 'standard').length, verifiedProviderLatencyMs: verified.map(p => p.latency ?? null), keyPermissionsChecked: false };
  } catch (error) { failed = true; return { model, error: error.message }; }
}));
console.log(JSON.stringify({ endpoint: base, paidInference: false, results }, null, 2));
if (failed || results.some(result => 'healthyVerifiedProviders' in result && result.healthyVerifiedProviders === 0)) process.exitCode = 1;
