import { rankSources } from './ranking.js';
import { writeFileSync } from 'node:fs';

// Static inspection must observe imports/exports without executing this target.
writeFileSync('/output/TARGET_EXECUTED', 'CIAO-REA-EXECUTION-MUST-NOT-HAPPEN');
throw new Error('CIAO-REA-STATIC-ONLY: the analyzed program must never execute');

export function summarizeSources(sources) {
  return rankSources(sources).map((source) => source.title).join('\n');
}
