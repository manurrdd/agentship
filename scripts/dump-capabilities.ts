/**
 * Prints the coverage table of both store backends.
 *
 * Coverage is data, not code: this is the artefact a reviewer reads to check that every
 * operation is classified, and that nothing Agentship refuses to automate is marked `auto`.
 */
import { APPLE_CAPABILITIES } from '../packages/adapter-apple/src/index.js';
import { GOOGLE_CAPABILITIES } from '../packages/adapter-google/src/index.js';
import { OPERATION_IDS } from '../packages/core/src/index.js';

const width = Math.max(...OPERATION_IDS.map((id) => id.length));
console.log(`${'operation'.padEnd(width)}  ${'apple'.padEnd(14)}  google`);
console.log('-'.repeat(width + 32));
for (const id of OPERATION_IDS) {
  console.log(
    `${id.padEnd(width)}  ${APPLE_CAPABILITIES[id].padEnd(14)}  ${GOOGLE_CAPABILITIES[id]}`,
  );
}
