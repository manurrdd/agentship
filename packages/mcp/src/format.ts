import { AgentshipError, scrubStrings } from '@agentship/core';
import { ZodError } from 'zod';

/**
 * Shaping tool responses for an agent's context window.
 *
 * Two rules, both from Anthropic's guidance on writing tools for agents. First, answer at
 * the level of detail the next decision needs: `concise` (the default) carries what the
 * agent has to reason about, `full` carries everything, and the agent asks for `full`
 * only when it must. Second, never let a response silently blow up the context: a payload
 * over the ceiling is trimmed and the trimming is *stated*, so the agent knows it is
 * looking at part of the answer rather than believing it saw all of it.
 */
export type Detail = 'concise' | 'full';

/** Characters per token, for the rough budget below. */
const CHARS_PER_TOKEN = 4;
/** Ceiling for a single tool response. */
export const MAX_RESPONSE_TOKENS = 10_000;
export const MAX_RESPONSE_CHARS = MAX_RESPONSE_TOKENS * CHARS_PER_TOKEN;
/** Longest single string kept verbatim when a response has to be trimmed. */
const MAX_STRING_CHARS = 2_000;
/** Array caps tried, in order, until the payload fits. */
const ARRAY_LIMITS = [50, 20, 10, 5, 2, 1] as const;

export interface TrimNote {
  /** Dot path of the trimmed value, e.g. `actions[].diff`. */
  readonly path: string;
  readonly kept: number;
  readonly total: number;
}

function trim(value: unknown, limit: number, path: string, notes: Map<string, TrimNote>): unknown {
  if (typeof value === 'string') {
    if (value.length <= MAX_STRING_CHARS) return value;
    return `${value.slice(0, MAX_STRING_CHARS)}… [${value.length - MAX_STRING_CHARS} more characters]`;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, limit).map((item) => trim(item, limit, `${path}[]`, notes));
    if (value.length > limit) {
      const existing = notes.get(path);
      notes.set(path, {
        path,
        kept: limit,
        total: (existing?.total ?? 0) + value.length,
      });
    }
    return kept;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = trim(item, limit, path === '' ? key : `${path}.${key}`, notes);
    }
    return out;
  }
  return value;
}

export interface Serialized {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Serialises a payload, trimming arrays and long strings until it fits the ceiling.
 *
 * Everything is redacted first. This is the channel that leaves the machine for an agent's
 * context, so — exactly like the logger does for the log file — no string reaches it without
 * passing the redactor. Tool payloads are built from secret-free data by design; redaction
 * here is the defensive net that also covers the one channel that carries untrusted third
 * party output, a build tool's stdout embedded in an error's evidence.
 *
 * The result always carries a `truncated` block when anything was dropped: which paths,
 * how many entries were kept, and how to get the rest.
 */
export function serialize(rawPayload: unknown): Serialized {
  const payload = scrubStrings(rawPayload);
  const full = JSON.stringify(payload, null, 2);
  if (full.length <= MAX_RESPONSE_CHARS) return { text: full, truncated: false };

  for (const limit of ARRAY_LIMITS) {
    const notes = new Map<string, TrimNote>();
    const trimmed = trim(payload, limit, '', notes) as Record<string, unknown>;
    const withNote = {
      ...trimmed,
      truncated: {
        reason: `The full response exceeded the ${MAX_RESPONSE_TOKENS} token ceiling.`,
        arrayLimit: limit,
        paths: [...notes.values()].sort((a, b) => a.path.localeCompare(b.path)),
        advice:
          'Ask for a narrower scope (one store, one action id, one pending id) to see the omitted entries.',
      },
    };
    const text = JSON.stringify(withNote, null, 2);
    if (text.length <= MAX_RESPONSE_CHARS) return { text, truncated: true };
  }

  return {
    text: JSON.stringify(
      {
        truncated: {
          reason: `The response does not fit the ${MAX_RESPONSE_TOKENS} token ceiling even trimmed.`,
          advice: 'Narrow the request: one store, one action id, or one pending operation.',
        },
      },
      null,
      2,
    ),
    truncated: true,
  };
}

/**
 * Raised when a tool call's own arguments fail their schema — and never for anything else.
 *
 * The engine validates the user's manifest with the same library the tools validate their
 * arguments with, so a bare `ZodError` cannot say which of the two it is. This class marks
 * the one case the agent can fix by calling differently.
 */
export class InvalidToolInput extends Error {
  readonly issues: readonly { path: string; message: string }[];

  constructor(issues: readonly { path: string; message: string }[]) {
    super('The tool arguments did not match the expected schema.');
    this.name = 'InvalidToolInput';
    this.issues = issues;
  }
}

export interface ToolResponse {
  readonly content: { type: 'text'; text: string }[];
  readonly isError?: boolean;
  /** The SDK's `CallToolResult` allows extra fields; Agentship does not use any. */
  readonly [key: string]: unknown;
}

export function ok(payload: unknown): ToolResponse {
  return { content: [{ type: 'text', text: serialize(payload).text }] };
}

/**
 * Turns any thrown value into a response an agent can act on without reading a log file.
 *
 * `AgentshipError` already carries the code, whether a retry makes sense, and the
 * remediation; anything else is reported as an internal error with its message only —
 * stack traces belong in `~/.agentship/logs/mcp.log`, not in the model's context.
 */
export function fail(error: unknown): ToolResponse {
  if (AgentshipError.is(error)) {
    return {
      content: [{ type: 'text', text: serialize({ error: error.toJSON() }).text }],
      isError: true,
    };
  }
  // Bad arguments are the caller's to fix, so they are reported as such — but only when the
  // failure really came from parsing arguments. See {@link InvalidToolInput}.
  if (error instanceof InvalidToolInput) {
    return {
      content: [
        {
          type: 'text',
          text: serialize({
            error: {
              code: 'INVALID_INPUT',
              message: 'The tool arguments did not match the expected schema.',
              retryable: false,
              issues: error.issues,
            },
          }).text,
        },
      ],
      isError: true,
    };
  }
  // A schema failure from anywhere else is Agentship validating its own data — most often
  // the user's manifest. Calling that a bad argument sent agents round a loop retrying the
  // tool with different arguments while the real fault sat in a YAML file, so it is reported
  // for what it is, with the offending paths still visible.
  if (error instanceof ZodError) {
    return {
      content: [
        {
          type: 'text',
          text: serialize({
            error: {
              code: 'INTERNAL',
              message:
                'Agentship rejected its own data while handling this call; the tool arguments were accepted. This usually means .agentship/agentship.yaml or a stored state file has a field Agentship cannot read.',
              retryable: false,
              issues: error.issues.map((issue) => ({
                path: issue.path.map((segment) => String(segment)).join('.'),
                message: issue.message,
              })),
            },
          }).text,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: serialize({
          error: {
            code: 'INTERNAL',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        }).text,
      },
    ],
    isError: true,
  };
}
