import http from 'node:http';
import { getHistoricalBlock, getHistoricalTransaction } from './history.mjs';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'ethers';
import { normalizeHex } from './engine.mjs';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8765), root = new URL('./', import.meta.url);
function runWorker(action, input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { action, input }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timeout = setTimeout(() => { worker.terminate(); reject(Error('Execution timed out after 25 seconds. Try a smaller contract or call.')); }, 25000);
    worker.once('message', msg => { clearTimeout(timeout); worker.terminate(); msg.ok ? resolve(msg.data) : reject(Error(msg.error)); });
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', code => { clearTimeout(timeout); if (code) reject(Error('Contract worker stopped. Try a smaller input.')); });
  });
}
async function fetchCode(input) {
  const address = getAddress(input.address);
  let url; try { url = new URL(input.rpcUrl); } catch { throw Error('Enter a valid Ethereum RPC URL.'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw Error('RPC URL must use HTTP or HTTPS.');
  async function rpc(method, params) {
    let response;
    try { response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) }); } catch { throw Error('Could not reach the RPC endpoint. Check its URL and network connection.'); }
    if (!response.ok) throw Error(`RPC endpoint returned HTTP ${response.status}.`);
    const data = await response.json();
    if (data.error) throw Error(`RPC rejected ${method} (code ${data.error.code}). Check your provider settings.`);
    return data.result;
  }
  const block = await rpc('eth_blockNumber', []), chainId = await rpc('eth_chainId', []);
  if (chainId !== '0x1') throw Error('This loader expects Ethereum mainnet (chain ID 1).');
  const runtimeBytecode = normalizeHex(await rpc('eth_getCode', [address, block]));
  if (runtimeBytecode === '0x') throw Error('No contract bytecode exists at this address at the latest block.');
  return { runtimeBytecode, address, origin: { address, block: String(BigInt(block)), chainId: '1' } };
}
const files = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ['/simplified.html', ['simplified.html', 'text/html']], ['/examples/Counter.sol', ['examples/Counter.sol', 'text/plain']]]);
let busy = false;
const server = http.createServer(async (req, res) => {
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && files.has(path)) { const [file, type] = files.get(path); res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(await readFile(new URL(file, root))); }
    if (req.method !== 'POST' || !['/api/compile', '/api/trace', '/api/code', '/api/block', '/api/transaction'].includes(path)) return json(404, { error: 'Not found' });
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return json(403, { error: 'Local requests only' });
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return json(403, { error: 'Open the page from the local server to load contracts.' });
    if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON required' });
    let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2_000_000) return json(413, { error: 'Input is too large (2 MB maximum).' }); }
    const input = JSON.parse(body);
    if (busy) return json(429, { error: 'Another operation is running. Please wait.' });
    busy = true;
    try { json(200, path === '/api/block' ? await getHistoricalBlock(input) : path === '/api/transaction' ? await getHistoricalTransaction(input) : path === '/api/code' ? await fetchCode(input) : await runWorker(path.slice(5), input)); } finally { busy = false; }
  } catch (error) { json(400, { error: error.message }); }
});
if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(port, host, () => console.log(`EVM animation: http://127.0.0.1:${port}`));
export { server, fetchCode };
