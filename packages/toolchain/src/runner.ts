import {
  getLogger,
  type Logger,
  type RunResult,
  runToolRaw,
  type ToolInvocation,
  type ToolRunner,
} from '@agentship/core';
import { ensureTool, type ToolchainOptions } from './install.js';
import type { ToolName } from './lockfile.js';

export interface ToolRunnerOptions extends ToolchainOptions {
  readonly logger?: Logger;
}

/**
 * Binds a managed tool to a {@link ToolRunner} the store backends can call.
 *
 * The tool is resolved through {@link ensureTool} on every invocation, which is what makes
 * "a backend can only ever run a hash-verified binary" an enforced property rather than a
 * convention: there is no path from a backend to `PATH`, and no way to hand it a binary
 * that was not checked against the embedded lockfile.
 *
 * The first call may install the tool; subsequent calls hit the cheap
 * pointer + size check and cost microseconds.
 */
export function createToolRunner(tool: ToolName, options: ToolRunnerOptions = {}): ToolRunner {
  const logger = (options.logger ?? getLogger()).child({ tool });
  return async (invocation: ToolInvocation): Promise<RunResult> => {
    const binary = await ensureTool(tool, options);
    return runToolRaw(binary, { ...invocation, toolName: tool, logger });
  };
}
