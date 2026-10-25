#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ControlPlane } from './core.mjs';

const HELP = `CIAOMIND offline control plane (Node 24+)

Usage: node control/cli.mjs --db /private/path/tasks.sqlite COMMAND [TASK_ID] [options]
Commands:
  create --file task.json
  dispatch TASK_ID                Print a JSON task pack; no worker is invoked
  submit --file result.json
  review TASK_ID --attempt UUID --reviewer muse --decision accept --evidence "checked ..."
  show TASK_ID | list | events TASK_ID
  pause TASK_ID | resume TASK_ID
  retry TASK_ID --reason "explicit operator retry"

--file - reads JSON from stdin. All results go to stdout as JSON.
Database path is required; keep it outside a public repository.
Actor names are local audit labels, not authenticated identities.
No model calls, shell execution, repository writes, or external messages occur.
`;

let plane;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string' }, file: { type: 'string' },
      attempt: { type: 'string' }, reviewer: { type: 'string' },
      decision: { type: 'string' }, evidence: { type: 'string' },
      reason: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !positionals.length) {
    process.stdout.write(HELP);
  } else {
    if (!values.db) throw new Error('--db is required');
    const [command, taskId] = positionals;
    const known = new Set(['create', 'dispatch', 'submit', 'review', 'show', 'list', 'events', 'pause', 'resume', 'retry']);
    if (!known.has(command)) throw new Error(`Unknown command ${command}`);
    if (positionals.length > (['create', 'submit', 'list'].includes(command) ? 1 : 2)) throw new Error('Unexpected positional arguments');
    const json = () => {
      if (!values.file) throw new Error('--file is required');
      return JSON.parse(readFileSync(values.file === '-' ? 0 : values.file, 'utf8'));
    };
    plane = new ControlPlane({ dbPath: values.db });
    const actions = {
      create: () => plane.createTask(json()),
      dispatch: () => plane.dispatch(taskId),
      submit: () => plane.submitResult(json()),
      review: () => plane.reviewTask({ task_id: taskId, attempt_id: values.attempt, reviewer: values.reviewer, decision: values.decision, evidence: values.evidence }),
      show: () => plane.getTask(taskId), list: () => plane.listTasks(), events: () => plane.events(taskId),
      pause: () => plane.pauseTask(taskId), resume: () => plane.resumeTask(taskId), retry: () => plane.retryTask(taskId, values.reason),
    };
    process.stdout.write(`${JSON.stringify(actions[command](), null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.code || 'CLI_ERROR', message: error.message })}\n`);
  process.exitCode = 1;
} finally {
  plane?.close();
}
