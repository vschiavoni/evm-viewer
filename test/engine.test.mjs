import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileContracts, traceContract, encodeCall, normalizeHex } from '../engine.mjs';
import { fetchCode } from '../server.mjs';
const source = await readFile(new URL('../examples/Counter.sol', import.meta.url), 'utf8');
const artifact = compileContracts({ 'Counter.sol': { content: source } }).contracts[0];
const run = extra => traceContract({ ...artifact, deploy: true, signature: 'increment(uint256)', args: ['1'], ...extra });

test('real Solidity: constructor, function dispatch, source map and final storage', async () => {
  const t = await run();
  assert.equal(t.outcome.success, true);
  assert.deepEqual(t.outcome.decoded, ['42']);
  assert.equal(BigInt(t.outcome.storage[0].value), 42n);
  const load = t.steps.find(s => s.op === 'SLOAD');
  assert.equal(BigInt(load.storage[0].value), 41n);
  assert(t.steps.length > 100);
  assert(t.steps.some(s => s.source?.file === 'Counter.sol'));
  assert.equal(t.steps.at(-1).op, 'RETURN');
  assert.equal(t.steps[0].stackSize, 0);
  assert(t.steps.every(s => s.stack.length <= 8 && s.memory.length <= 514));
});

test('runtime/address code uses empty storage instead of constructor state', async () => {
  const t = await run({ deploy: false, address: '0x000000000000000000000000000000000000c0de' });
  assert.deepEqual(t.outcome.decoded, ['1']);
  assert.equal(BigInt(t.steps.find(s => s.op === 'SLOAD').storage[0].value), 0n);
  assert.equal(t.deployment, null);
});

test('reverted writes are visible provisionally and rolled back at completion', async () => {
  const a = compileContracts({ 'Fail.sol': { content: 'pragma solidity ^0.8.20; contract Fail { uint x = 7; function fail() external { x = 9; revert("No"); } }' } }).contracts[0];
  const t = await traceContract({ ...a, deploy: true, signature: 'fail()', args: [] });
  assert.equal(t.outcome.success, false);
  assert.equal(t.outcome.revertReason, 'Error(No)');
  assert(t.steps.some(s => s.storage.some(x => BigInt(x.value) === 9n)));
  assert.equal(BigInt(t.outcome.storage[0].value), 7n);
});

test('constructor arguments and Solidity imports compile and execute', async () => {
  const a = compileContracts({ 'A.sol': { content: 'pragma solidity ^0.8.20; import "./B.sol"; contract A is B { constructor(uint n) B(n) {} }' }, 'B.sol': { content: 'pragma solidity ^0.8.20; contract B { uint public value; constructor(uint n) {value = n;} }' } }).contracts.find(x => x.name === 'A');
  const t = await traceContract({ ...a, deploy: true, constructorArgs: ['88'], signature: 'value()', args: [] });
  assert.deepEqual(t.outcome.decoded, ['88']);
});

test('manual signature accepts return types and decodes runtime return value', async () => {
  const t = await traceContract({ runtimeBytecode: '0x602a60005260206000f3', signature: 'answer() view returns (uint256)', args: [] });
  assert.equal(t.outcome.success, true);
  assert.deepEqual(t.outcome.decoded, ['42']);
});

test('raw calldata and invalid opcodes report actual VM outcomes', async () => {
  const t = await traceContract({ runtimeBytecode: '0xfe', calldata: '0x' });
  assert.equal(t.outcome.success, false);
  assert.match(t.outcome.error, /invalid opcode/);
});

test('compilation and ABI errors surface instead of yielding fake traces', async () => {
  assert.throws(() => compileContracts({ 'Invalid.sol': { content: 'not Solidity' } }), /ParserError/);
  assert.throws(() => normalizeHex('0xzz'), /hex/);
  assert.throws(() => encodeCall({ abi: artifact.abi, signature: 'increment(uint256)', args: [] }));
  await assert.rejects(run({ signature: 'fail()', args: [], constructorArgs: ['extra'] }));
});

test('long calls fail explicitly rather than silently dropping steps', async () => {
  await assert.rejects(traceContract({ runtimeBytecode: '0x5b600056', calldata: '0x' }), /6000 instructions/);
});

test('address loader pins mainnet bytecode to a block and performs only read RPCs', async () => {
  const original = globalThis.fetch, methods = [];
  globalThis.fetch = async (_url, options) => { const { method, params } = JSON.parse(options.body); methods.push({ method, params }); return { ok: true, json: async () => ({ result: ({ eth_blockNumber: '0x10', eth_chainId: '0x1', eth_getCode: '0x6000' })[method] }) }; };
  try {
    const data = await fetchCode({ address: '0x000000000000000000000000000000000000c0de', rpcUrl: 'https://example.invalid/key' });
    assert.equal(data.runtimeBytecode, '0x6000');
    assert.equal(data.origin.block, '16');
    assert.deepEqual(methods.map(m => m.method), ['eth_blockNumber', 'eth_chainId', 'eth_getCode']);
    assert.equal(methods[2].params[1], '0x10');
    assert(!JSON.stringify(data).includes('example.invalid'));
  } finally { globalThis.fetch = original; }
});
