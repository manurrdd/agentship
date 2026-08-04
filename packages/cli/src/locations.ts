import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where this installation lives.
 *
 * Agents are registered with an absolute path to the `agentship` binary, so the value has to
 * be the real one — an `npx` shim, a symlinked global bin or a `pnpm link` all resolve to
 * different files, and a registration pointing at the wrong one fails silently later.
 */
export function packageRoot(): string {
  // `dist/bin.js` in a published install, `src/locations.ts` when run from the repo.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** Directory holding the bundled skills, one subdirectory per skill. */
export function skillsSourceDir(): string {
  return join(packageRoot(), 'skills');
}

/**
 * Absolute path of the running `agentship` executable, with symlinks resolved.
 *
 * Falls back to the package's own `dist/bin.js` when the process was not started from the
 * bin (an embedded call, or a test), which is still a path that runs the CLI.
 */
export function binaryPath(): string {
  const argv = process.argv[1];
  if (argv !== undefined && argv !== '') {
    try {
      return realpathSync(argv);
    } catch {
      return resolve(argv);
    }
  }
  return join(packageRoot(), 'dist', 'bin.js');
}
