import { getAddress, getCreateAddress } from 'ethers';
const MAX_STEPS = 6000;
export function rpcClient(endpoint) {
  let url; try { url = new URL(endpoint); } catch { throw Error('Enter a valid Ethereum RPC URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('RPC URL must use HTTP or HTTPS.');
  return async (method, params) => {
    let response;
    try { response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(method === 'debug_traceTransaction' ? 60000 : 15000) }); }
    catch { throw Error('RPC request failed or timed out. Check the endpoint and tracing support.'); }
    if (!response.ok) throw Error(`RPC returned HTTP ${response.status}.`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 32_000_000) throw Error('RPC response exceeds 32 MB. Choose a smaller block or transaction.'); chunks.push(Buffer.from(chunk)); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('RPC did not return valid JSON.'); }
    if (data.error) {
      if (method === 'debug_traceTransaction') throw Error(`Historical tracing is unavailable (RPC code ${data.error.code}). Use a provider supporting Geth debug_traceTransaction with opcode logs and historical state; an ordinary public RPC may not support it.`);
      throw Error(`RPC rejected ${method} (code ${data.error.code}).`);
    }
    return data.result;
  };
}
async function mainnet(rpc) { if (BigInt(await rpc('eth_chainId', [])) !== 1n) throw Error('Select an Ethereum mainnet endpoint (chain ID 1).'); }
const decimal = n => String(BigInt(n));
const bytes = value => '0x' + String(value || '').replace(/^0x/, '');
const word = value => '0x' + String(value || '').replace(/^0x/, '').padStart(64, '0');
export async function getHistoricalBlock(input) {
  const rpc = rpcClient(input.rpcUrl); await mainnet(rpc);
  const query = String(input.block || 'latest').trim();
  let block;
  if (/^0x[\da-f]{64}$/i.test(query)) block = await rpc('eth_getBlockByHash', [query, true]);
  else { if (!/^(latest|\d+|0x[\da-f]+)$/i.test(query)) throw Error('Enter a block number, block hash, or latest.'); const tag = query === 'latest' ? query : '0x' + BigInt(query).toString(16); block = await rpc('eth_getBlockByNumber', [tag, true]); }
  if (!block?.hash) throw Error('Block not found.');
  return { number: decimal(block.number), hash: block.hash, timestamp: decimal(block.timestamp), gasUsed: decimal(block.gasUsed), transactions: block.transactions.map(tx => ({ hash: tx.hash, from: tx.from, to: tx.to, value: decimal(tx.value), input: tx.input, index: decimal(tx.transactionIndex) })) };
}
export function normalizeHistoricalTrace(tx, receipt, raw) {
  if (!Array.isArray(raw?.structLogs)) throw Error('Provider returned no opcode logs. Use the default Geth opcode tracer.');
  if (raw.structLogs.length > MAX_STEPS) throw Error(`This transaction exceeds the ${MAX_STEPS}-instruction replay limit. Choose a smaller transaction.`);
  if (tx.blockHash !== receipt.blockHash) throw Error('Transaction and receipt disagree on the block. Retry after chain reorganization.');
  const address = getAddress(tx.to || receipt.contractAddress || getCreateAddress({ from: tx.from, nonce: tx.nonce }));
  const steps = raw.structLogs.map(s => {
    const memory = (s.memory || []).join('').replaceAll('0x', '');
    return { pc: s.pc, op: s.op, immediate: null, gas: String(s.gas), cost: String(s.gasCost), depth: Math.max(0, s.depth - 1), address: s.depth === 1 ? address : null, codeAddress: null, stack: (s.stack || []).slice(-8).map(word), stackSize: (s.stack || []).length, memory: '0x' + memory.slice(0, 512), memoryBytes: memory.length / 2, memoryAvailable: Array.isArray(s.memory), storage: Object.entries(s.storage || {}).slice(-8).map(([key, value]) => ({ key: word(key), value: word(value) })), source: null };
  });
  const success = receipt.status === undefined ? !raw.failed : BigInt(receipt.status) === 1n;
  return { version: 1, title: 'Historical transaction', mode: 'Historical replay · provider execution trace', environment: 'Ethereum mainnet · original transaction context', historical: { transactionHash: tx.hash, blockHash: tx.blockHash, blockNumber: decimal(tx.blockNumber), transactionIndex: decimal(tx.transactionIndex), gasUsed: decimal(receipt.gasUsed), from: tx.from, to: tx.to, createdContract: receipt.contractAddress || null, logs: (receipt.logs || []).map(l => ({ address: l.address, topics: l.topics, data: l.data })) }, call: { address, caller: tx.from, signature: tx.input?.slice(0, 10) || '0x', calldata: tx.input || '0x', value: decimal(tx.value) }, origin: { address, block: decimal(tx.blockNumber), chainId: '1' }, deployment: null, sources: {}, steps, outcome: { success, error: success ? null : 'Transaction failed', revertReason: null, returnData: bytes(raw.returnValue), decoded: null, gasUsed: decimal(receipt.gasUsed), storage: [] }, limits: { displayedStackWords: 8, displayedMemoryBytes: 256, displayedStorageSlots: 8 }, notes: 'Opcode stack and memory snapshots are before execution. Storage is the provider-reported per-frame accessed-slot snapshot, not a complete state diff. Final storage is not supplied. Nested addresses and PUSH immediates are not supplied by this tracer. Gas is receipt transaction gas, including intrinsic costs.' };
}
export async function getHistoricalTransaction(input) {
  if (!/^0x[\da-f]{64}$/i.test(input.transactionHash || '')) throw Error('Enter a 32-byte transaction hash (0x plus 64 hex digits).');
  const rpc = rpcClient(input.rpcUrl); await mainnet(rpc);
  const tx = await rpc('eth_getTransactionByHash', [input.transactionHash]);
  if (!tx) throw Error('Transaction not found on Ethereum mainnet.');
  if (!tx.blockHash) throw Error('This transaction is pending. Replay is available after inclusion in a block.');
  const receipt = await rpc('eth_getTransactionReceipt', [input.transactionHash]);
  if (!receipt) throw Error('Transaction receipt is not available yet.');
  const raw = await rpc('debug_traceTransaction', [input.transactionHash, { enableMemory: true, disableStack: false, disableStorage: false, enableReturnData: true, timeout: '45s', reexec: 128, limit: MAX_STEPS + 1 }]);
  return normalizeHistoricalTrace(tx, receipt, raw);
}
