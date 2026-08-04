import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AppAnalysis, AppAnalysisSchema } from '../analysis.js';
import { AgentshipError, ERROR_CODES } from '../errors.js';
import { ensureDir, FILE_MODE, stateDir } from '../paths.js';
import { redactValue } from '../redact.js';

/**
 * The last analysis of the repository, kept where the kernel can find it.
 *
 * The kernel plans from the manifest and the store; it has no business scanning source code.
 * But two things it must do — showing the evidence behind a proposed privacy declaration,
 * and noticing that the code changed after the user confirmed one — are questions about the
 * repository, and re-analysing on every plan would make planning slow and non-deterministic.
 *
 * So `agentship_analyze` writes what it found here, and the kernel reads it if it is there.
 * Every consumer treats it as optional and possibly stale: a missing file means fewer
 * warnings, never a wrong plan, and a file from an older schema is ignored rather than
 * migrated.
 */
export function analysisPath(repoRoot: string): string {
  return join(stateDir(repoRoot), 'analysis.json');
}

export async function saveAnalysis(repoRoot: string, analysis: AppAnalysis): Promise<string> {
  await ensureDir(stateDir(repoRoot));
  const path = analysisPath(repoRoot);
  await writeFile(path, `${JSON.stringify(redactValue(analysis), null, 2)}\n`, {
    mode: FILE_MODE,
  });
  return path;
}

/** The stored analysis, or `undefined` when there is none Agentship can use. */
export async function loadAnalysis(repoRoot: string): Promise<AppAnalysis | undefined> {
  let raw: string;
  try {
    raw = await readFile(analysisPath(repoRoot), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_HOME_UNWRITABLE,
      'Could not read the stored analysis.',
      cause,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt analysis is not worth failing a plan over: it only ever adds warnings.
    return undefined;
  }
  // Validate the shape, not just that it parses: a file with the right schemaVersion but a
  // hostile or truncated body (an array where a scalar belongs, or vice versa) must degrade
  // to "no analysis" rather than throw while the kernel iterates it during plan.
  const result = AppAnalysisSchema.safeParse(parsed);
  return result.success ? (parsed as AppAnalysis) : undefined;
}
