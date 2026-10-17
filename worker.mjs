import { parentPort, workerData } from 'node:worker_threads';
import { compileContracts, traceContract } from './engine.mjs';
try {
  const data = workerData.action === 'compile' ? compileContracts(workerData.input.sources) : await traceContract(workerData.input);
  parentPort.postMessage({ ok: true, data });
} catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
