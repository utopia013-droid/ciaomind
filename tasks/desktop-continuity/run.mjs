import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

// No network APIs, login commands, provider binaries or live adapters are invoked.
const inputBytes = readFileSync(new URL('./input.json', import.meta.url));
const task = JSON.parse(inputBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); };
let processCount = 0;
const checks = [];
let output;
let outputValidated = false;
const report = {task_id:task.task_id, mode:task.mode, status:'blocked', source_commit:task.source_commit, input_sha256:hash(inputBytes), node_version:process.versions.node, platform:process.platform, additional_remote_adapter_invocations:0, remote_vendor_authenticated:false, prior_authentication_retested:false, checks, limitations:['Local demo continuation only; no live director mission or cross-vendor inference was tested.','Fresh process recovery does not establish crash recovery during an in-flight call, host reboot, VM replacement or 24/7 availability.','A prior receipt is an attestation checked for consistency, not independently verified provider proof.']};
try {
  const {values} = parseArgs({options:{source:{type:'string'},receipt:{type:'string'},output:{type:'string'}}});
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
  assert.ok(values.source && values.receipt && values.output);
  const source = realpathSync(resolve(values.source));
  output = resolve(values.output);
  assert.ok(!existsSync(output));
  mkdirSync(dirname(output), {recursive:true, mode:0o700});
  assert.ok(!inside(source, join(realpathSync(dirname(output)), output.split(/[\\/]/).at(-1))));
  outputValidated = true;
  const git = args => {
    const r = spawnSync('git', ['-C',source,...args], {encoding:'utf8', timeout:10000, windowsHide:true});
    assert.equal(r.status,0,'SOURCE_CHECK_FAILED'); return r.stdout.trim();
  };
  assert.equal(git(['rev-parse','HEAD']),task.source_commit);
  git(['diff','--exit-code','HEAD','--']);
  checks.push('pinned_source_clean');
  const receiptBytes = readFileSync(resolve(values.receipt));
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.task_id,task.prior_task_id);
  assert.equal(receipt.input_sha256,task.prior_input_sha256);
  assert.equal(receipt.input_version,1);
  assert.equal(receipt.source_commit,task.source_commit);
  assert.equal(receipt.task_packet_commit,task.prior_task_packet_commit);
  assert.equal(receipt.consumer_type,'desktop_codex');
  assert.equal(receipt.status,'passed');
  assert.equal(receipt.remote_vendor_authenticated,true);
  assert.equal(receipt.actual_adapter_invocations,2);
  assert.equal(receipt.max_adapter_invocations,2);
  assert.equal(receipt.exit_code,0);
  assert.equal(receipt.evidence.producer_sum,17);
  assert.equal(receipt.evidence.review_decision,'accept');
  assert.equal(receipt.evidence.producer_protocol_identity_verified,true);
  assert.equal(receipt.evidence.reviewer_protocol_identity_verified,true);
  report.prior_receipt_sha256 = hash(receiptBytes);
  checks.push('prior_receipt_consistency');
  const state = mkdtempSync(join(dirname(output),'continuity-state-'));
  const config = join(state,'demo-config.json');
  writeFileSync(config,JSON.stringify({workers:[{id:'demo-worker',type:'demo',namespaces:['project'],enabled:true},{id:'demo-reviewer',type:'demo',role:'reviewer',namespaces:['project'],enabled:true}]}));
  const cli = join(source,'apps/alliance-agent/director/cli.mjs');
  const run = args => {
    assert.ok(++processCount <= task.budget.max_local_processes);
    const r = spawnSync(process.execPath,[cli,'--db',join(state,'missions.sqlite'),'--goals-db',join(state,'goals.sqlite'),'--config',config,...args],{encoding:'utf8',timeout:10000,maxBuffer:1000000,windowsHide:true});
    assert.equal(r.status,0,'LOCAL_CLI_FAILED');
    return JSON.parse(r.stdout);
  };
  const mission = JSON.parse(readFileSync(join(source,'apps/alliance-agent/director/examples/demo-mission.json')));
  mission.mission_id = task.task_id;
  const missionFile = join(state,'mission.json');
  writeFileSync(missionFile,JSON.stringify(mission));
  run(['create','--file',missionFile]);
  run(['tick']); run(['tick']);
  const before = run(['show','project',mission.mission_id]);
  run(['pause','project',mission.mission_id]); run(['tick']);
  const paused = run(['show','project',mission.mission_id]);
  assert.equal(paused.status,'paused');
  assert.equal(paused.calls_reserved,before.calls_reserved);
  checks.push('pause_stops_reservations');
  run(['resume','project',mission.mission_id]);
  let final;
  for(let i=0;i<8;i++){
    run(['tick']); final=run(['show','project',mission.mission_id]);
    if(final.status==='completed') break;
    assert.notEqual(final.status,'blocked');
  }
  assert.equal(final.status,'completed');
  assert.equal(final.child_details.status,'completed');
  assert.ok(final.calls_reserved <= final.max_calls);
  checks.push('fresh_process_resume_completed','reservation_budget_respected');
  const callsBefore = run(['calls','project',mission.mission_id]);
  run(['tick']);
  assert.deepEqual(run(['calls','project',mission.mission_id]), callsBefore);
  checks.push('completion_does_not_repeat_work');
  mission.mission_id += '-CANCEL';
  writeFileSync(missionFile,JSON.stringify(mission));
  run(['create','--file',missionFile]); run(['cancel','project',mission.mission_id]); run(['tick']);
  const cancelled = run(['show','project',mission.mission_id]);
  assert.equal(cancelled.status,'cancelled');
  assert.equal(cancelled.calls_reserved,0);
  checks.push('cancel_before_dispatch');
  report.synthetic_mission = {status:final.status, child_status:final.child_details.status,calls_reserved:final.calls_reserved,max_calls:final.max_calls};
  report.status='passed';
} catch {
  // Never echo receipt contents, CLI stderr, environment values or host paths.
  report.safe_diagnostic='CONTINUITY_CHECK_FAILED';
} finally {
  report.local_cli_processes=processCount;
  report.exit_code=report.status==='passed'?0:2;
  if(outputValidated && !existsSync(output)) writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(report));
  process.exitCode=report.exit_code;
}
