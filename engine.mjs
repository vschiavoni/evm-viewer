import solc from 'solc';
import { createEVM } from '@ethereumjs/evm';
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { Account, createAddressFromString, hexToBytes, bytesToHex, setLengthLeft } from '@ethereumjs/util';
import { Interface, getAddress } from 'ethers';

export const LIMITS = { steps: 6000, gas: 2_000_000n, memory: 256, stack: 8, slots: 8 };
const word = n => '0x' + n.toString(16).padStart(64, '0');
export function normalizeHex(value, label = 'Bytecode') {
  if (typeof value !== 'string') throw Error(`${label} must be hex text.`);
  const hex = value.trim().replace(/^0x/, '');
  if (!/^(?:[a-fA-F0-9]{2})*$/.test(hex)) throw Error(`${label} must contain an even number of hex digits. Unlinked libraries are not supported.`);
  return '0x' + hex;
}
function locations(bytecode, sourceMap, sources, outputSources) {
  const byId = Object.fromEntries(Object.entries(outputSources).map(([name, info]) => [info.id, name]));
  let pc = 0, previous = ['0', '0', '-1']; const result = {};
  for (const item of sourceMap.split(';')) {
    const fields = item.split(':'); for (let i = 0; i < 3; i++) if (fields[i]) previous[i] = fields[i];
    const [start, length, id] = previous.map(Number), file = byId[id];
    if (file && start >= 0) {
      const content = sources[file].content;
      const prefix = Buffer.from(content).subarray(0, start).toString();
      result[pc] = { file, line: prefix.split('\n').length, start, length };
    }
    const op = parseInt(bytecode.slice(pc * 2, pc * 2 + 2), 16);
    pc += 1 + (op >= 0x60 && op <= 0x7f ? op - 0x5f : 0);
  }
  return result;
}
export function compileContracts(sources) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) throw Error('Provide Solidity source files.');
  const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: false }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.sourceMap'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw Error(errors.map(e => e.formattedMessage).join('\n'));
  const contracts = [];
  for (const [file, items] of Object.entries(output.contracts || {})) for (const [name, c] of Object.entries(items)) {
    if (!c.evm.bytecode.object) continue;
    contracts.push({ name, file, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtimeBytecode: '0x' + c.evm.deployedBytecode.object, locations: locations(c.evm.deployedBytecode.object, c.evm.deployedBytecode.sourceMap, sources, output.sources), sources });
  }
  if (!contracts.length) throw Error('No deployable contracts found.');
  return { contracts, compiler: solc.version(), warnings: (output.errors || []).filter(e => e.severity !== 'error').map(e => e.formattedMessage) };
}
export function encodeCall({ abi, signature, args = [], calldata }) {
  if (calldata !== undefined) return { data: normalizeHex(calldata, 'Calldata'), iface: null, fragment: null };
  if (!Array.isArray(args)) throw Error('Arguments must be a JSON array. Use strings for large integers.');
  const iface = new Interface(abi?.length ? abi : ['function ' + signature.replace(/^function\s+/, '')]);
  const fragment = abi?.length ? iface.getFunction(signature) : iface.fragments.find(f => f.type === 'function');
  if (!fragment) throw Error('Choose a function or enter a full function signature.');
  return { data: iface.encodeFunctionData(fragment, args), iface, fragment };
}
export async function traceContract(input) {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
  const evm = await createEVM({ common });
  const state = evm.stateManager;
  const caller = createAddressFromString(getAddress(input.caller || '0x00000000000000000000000000000000000000ee'));
  let to = createAddressFromString(getAddress(input.address || '0x000000000000000000000000000000000000c0de'));
  const value = BigInt(input.value || '0');
  if (value < 0n || value > 10n ** 24n) throw Error('Call value must be between 0 and 10^24 wei.');
  await state.putAccount(caller, new Account(0n, 10n ** 27n));
  let deployment = null;
  if (input.bytecode && input.deploy) {
    const iface = new Interface(input.abi || []);
    const constructorArgs = input.constructorArgs || [];
    if (!Array.isArray(constructorArgs)) throw Error('Constructor arguments must be a JSON array.');
    const init = normalizeHex(input.bytecode) + iface.encodeDeploy(constructorArgs).slice(2);
    const created = await evm.runCall({ caller, data: hexToBytes(init), gasLimit: LIMITS.gas });
    if (created.execResult.exceptionError) throw Error('Constructor failed: ' + created.execResult.exceptionError.error + ' (' + bytesToHex(created.execResult.returnValue) + ')');
    if (!created.createdAddress) throw Error('Constructor did not create a contract.');
    to = created.createdAddress;
    deployment = { address: to.toString(), gasUsed: String(created.execResult.executionGasUsed) };
  } else {
    const code = normalizeHex(input.runtimeBytecode);
    if (code === '0x') throw Error('The contract has no runtime bytecode.');
    await state.putAccount(to, new Account());
    await state.putCode(to, hexToBytes(code));
  }
  // Constructor and animated call are separate message executions.
  await evm.journal.cleanup();
  state.originalStorageCache.clear();
  evm.transientStorage.clear();
  evm.journal.addWarmedAddress(caller.bytes);
  evm.journal.addWarmedAddress(to.bytes);
  const { data, iface, fragment } = encodeCall(input);
  const steps = [], touched = new Map();
  let captureError = null;
  // Capture pre-instruction states. Reading through the state manager also respects call reverts.
  evm.events.on('step', async (s, resolve) => {
    try {
      if (captureError) { resolve?.(); return; }
      const codeAddress = s.codeAddress || s.address;
      if (steps.length >= LIMITS.steps) throw Error(`Trace exceeds ${LIMITS.steps} instructions. Use a smaller call.`);
      const address = s.address.toString();
      const slots = touched.get(address) || new Map(); touched.set(address, slots);
      if ((s.opcode.name === 'SLOAD' || s.opcode.name === 'SSTORE') && s.stack.length) {
        const key = word(s.stack[s.stack.length - 1]);
        slots.set(key, true);
      }
      const storage = [];
      for (const key of [...slots.keys()].slice(-LIMITS.slots)) storage.push({ key, value: bytesToHex(setLengthLeft(await state.getStorage(s.address, hexToBytes(key)), 32)) });
      const memoryBytes = Number(s.memoryWordCount) * 32;
      const code = await state.getCode(codeAddress);
      const pushSize = /^PUSH\d+$/.test(s.opcode.name) ? Number(s.opcode.name.slice(4)) : 0;
      steps.push({ pc: s.pc, op: s.opcode.name, immediate: pushSize ? bytesToHex(code.slice(s.pc + 1, s.pc + 1 + pushSize)) : null, gas: String(s.gasLeft), cost: String(s.opcode.dynamicFee ?? s.opcode.fee), depth: s.depth, address, codeAddress: codeAddress.toString(), stack: s.stack.slice(-LIMITS.stack).map(word), stackSize: s.stack.length, memory: bytesToHex(s.memory.slice(0, Math.min(memoryBytes, LIMITS.memory))), memoryBytes, storage, source: codeAddress.equals(to) ? input.locations?.[s.pc] || null : null });
      resolve?.();
    } catch (error) { captureError = error; resolve?.(); }
  });
  const result = await evm.runCall({ caller, origin: caller, to, data: hexToBytes(data), value, gasLimit: LIMITS.gas });
  if (captureError) throw captureError;
  const exec = result.execResult;
  const finalStorage = [];
  for (const [address, slots] of touched) for (const key of [...slots.keys()].slice(-LIMITS.slots)) finalStorage.push({ address, key, value: bytesToHex(setLengthLeft(await state.getStorage(createAddressFromString(address), hexToBytes(key)), 32)) });
  const returnData = bytesToHex(exec.returnValue);
  let decoded = null;
  if (!exec.exceptionError && iface && fragment) { try { decoded = iface.decodeFunctionResult(fragment, returnData).toArray(true); } catch {} }
  let revertReason = null;
  if (exec.exceptionError && returnData !== '0x') { try { const err = new Interface(['error Error(string)', 'error Panic(uint256)', ...(input.abi || []).filter(x => x.type === 'error')]).parseError(returnData); revertReason = err ? `${err.name}(${err.args.map(String).join(', ')})` : null; } catch {} }
  return JSON.parse(JSON.stringify({ version: 1, title: input.name || 'Contract execution', mode: deployment ? 'Fresh local deployment · constructor initialized storage' : 'Local sandbox · empty initial storage', environment: 'Cancun EVM · chain ID 1 · synthetic block · no other chain accounts loaded', call: { address: to.toString(), caller: caller.toString(), signature: input.signature || 'Raw calldata', calldata: data, value: String(value) }, origin: input.origin || null, deployment, sources: input.sources || {}, steps, outcome: { success: !exec.exceptionError, error: exec.exceptionError?.error || null, revertReason, returnData, decoded, gasUsed: String(exec.executionGasUsed), storage: finalStorage }, limits: { displayedStackWords: LIMITS.stack, displayedMemoryBytes: LIMITS.memory, displayedStorageSlots: LIMITS.slots } }, (_, v) => typeof v === 'bigint' ? v.toString() : v));
}
