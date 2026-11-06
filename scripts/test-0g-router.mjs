/** One small paid 0G Router inference using the wallet-linked key in .env. */
import 'dotenv/config';
import { request } from 'node:https';

const key = process.env.ZG_MAINNET_API_KEY;
if (!key) throw new Error('Set ZG_MAINNET_API_KEY in the root .env first.');
const body = JSON.stringify({ model: 'qwen3.7-flash', messages: [{ role: 'user', content: 'Reply exactly: OK' }], max_tokens: 64, temperature: 0, enable_thinking: false, stream: false });
const result = await new Promise((resolve, reject) => {
  const req = request('https://router-api.0g.ai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'content-length': Buffer.byteLength(body) }, signal: AbortSignal.timeout(120_000) }, (res) => {
    let text = ''; res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; if (text.length > 1024 * 1024) req.destroy(new Error('Response too large')); });
    res.on('end', () => { try { resolve({ status: res.statusCode, requestId: res.headers['x-request-id'], data: JSON.parse(text) }); } catch { reject(new Error(`Invalid JSON response (HTTP ${res.statusCode})`)); } });
    res.on('error', reject);
  });
  req.on('error', reject); req.end(body);
});
if (result.status !== 200) { console.error(JSON.stringify({ status: result.status, error: result.data.error?.message ?? 'Router request failed', requestId: result.requestId })); process.exitCode = 1; }
else {
  const answer = result.data.choices?.[0]?.message?.content;
  console.log(JSON.stringify({ model: result.data.model, answer, finishReason: result.data.choices?.[0]?.finish_reason, usage: result.data.usage, requestId: result.requestId ?? result.data.id, billing: result.data.x_0g_trace?.billing ?? null }, null, 2));
  if (!answer) { console.error('The API returned no visible answer; check the finish reason and token limit.'); process.exitCode = 1; }
}
