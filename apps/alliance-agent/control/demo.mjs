// Offline synthetic demonstration only. No authenticated Codex/Dots/model is invoked.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ControlPlane } from './core.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ciaomind-demo-'));
const dbPath = join(dir, 'tasks.sqlite');
let plane = new ControlPlane({ dbPath });
try {
  plane.createTask({ task_id: 'CIAO-OFFLINE-001', kind: 'research', input: { goal: 'Sum synthetic numbers', numbers: [3, 5, 8] } });
  const packet = plane.dispatch('CIAO-OFFLINE-001');
  plane.close();
  plane = new ControlPlane({ dbPath });
  assert.deepEqual(plane.dispatch(packet.task_id), packet);
  const total = packet.input.numbers.reduce((sum, value) => sum + value, 0);
  plane.submitResult({
    task_id: packet.task_id, input_version: packet.input_version, input_sha256: packet.input_sha256,
    attempt_id: packet.attempt_id, producer: packet.worker, output: { total },
    evidence: ['Local synthetic worker computed total from packet.input.numbers'],
  });
  // This local assertion is a protocol demo, not an authenticated independent agent.
  assert.equal(total, 3 + 5 + 8);
  const done = plane.reviewTask({ task_id: packet.task_id, attempt_id: packet.attempt_id, reviewer: 'synthetic-reviewer', decision: 'accept', evidence: 'Local demo assertion independently recomputed 3 + 5 + 8' });
  console.log(JSON.stringify({ demonstration: 'offline-synthetic-protocol', authenticated_worker: false, recovered_after_reopen: true, task: done, events: plane.events(packet.task_id) }, null, 2));
} finally {
  plane.close();
  rmSync(dir, { recursive: true, force: true });
}
