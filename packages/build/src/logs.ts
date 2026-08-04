import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, FILE_MODE, logsDir, redactString } from '@agentship/core';
import type { BuildPlatform } from './types.js';

/**
 * Where a build log goes: `~/.agentship/logs/build-<platform>-<timestamp>.log`.
 *
 * Never into a tool response, and never into the repository. A single `xcodebuild archive`
 * produces tens of thousands of lines; an agent handed that would spend its entire context
 * on it and summarise it worse than the classifier in `diagnostics.ts` does. The log stays
 * on disk, complete and unabridged, and the agent gets a path plus a diagnosis.
 *
 * Everything written passes through the redactor. A build log is the most likely place for
 * a secret to appear by accident — an echoed keystore property, a signing identity dumped
 * by a verbose flag — and this file is the last point where that can be caught.
 */
export interface BuildLog {
  readonly path: string;
  /** Appends a section header, so a multi-command build stays readable. */
  section(title: string): Promise<void>;
  write(text: string): Promise<void>;
}

export async function createBuildLog(
  platform: BuildPlatform,
  startedAt: string,
): Promise<BuildLog> {
  const dir = await ensureDir(logsDir());
  const stamp = startedAt.replace(/[:.]/g, '-');
  const path = join(dir, `build-${platform}-${stamp}.log`);

  const write = async (text: string): Promise<void> => {
    await appendFile(path, redactString(text), { mode: FILE_MODE });
  };
  await write(`# Agentship build log — ${platform} — ${startedAt}\n`);
  return {
    path,
    write,
    async section(title) {
      await write(`\n\n===== ${title} =====\n`);
    },
  };
}
