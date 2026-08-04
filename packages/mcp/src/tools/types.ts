import { z } from 'zod';
import type { ToolResponse } from '../format.js';
import type { Session } from '../session.js';

/**
 * A tool as Agentship defines it, independent of the MCP SDK's registration API.
 *
 * Keeping the catalog as data has two payoffs: the descriptions — which are prompt
 * engineering, not documentation — can be snapshot-tested, and a script can check that
 * every tool the skills mention actually exists.
 */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** Reports progress to clients that asked for it; a no-op for those that did not. */
export type Progress = (message: string, current?: number, total?: number) => Promise<void>;

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Zod object whose `.shape` is handed to the SDK and whose parse guards the handler. */
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly annotations: ToolAnnotations;
  handler(session: Session, args: unknown, progress: Progress): Promise<ToolResponse>;
}

export const DETAIL_DESCRIPTION =
  'How much to return: "concise" (default) carries what the next decision needs; "full" carries every field. Ask for "full" only when concise left out something you need.';

export const PROJECT_DIR_DESCRIPTION =
  'Absolute path of the app repository. Optional once agentship_analyze has run: the session remembers it.';

/**
 * Bounds on the free-form string inputs, so a pathological argument cannot bloat a log or
 * spend time before the handler rejects it. Generous next to any real value — a filesystem
 * path, an action id, the set of ids a human approved in one conversation.
 */
export const MAX_PATH_CHARS = 4096;
export const MAX_ID_CHARS = 512;
export const MAX_APPROVALS = 1000;

/** The `projectDir` argument, shared by every project-scoped tool. */
export const projectDirArg = z
  .string()
  .max(MAX_PATH_CHARS)
  .optional()
  .describe(PROJECT_DIR_DESCRIPTION);

/** A single action id (an approval, a plan id): a short, bounded identifier. */
export const idArg = z.string().max(MAX_ID_CHARS);

/** The set of action ids a human approved this turn. */
export const approvalsArg = z.array(idArg).max(MAX_APPROVALS);
