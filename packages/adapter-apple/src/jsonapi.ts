import { AgentshipError, ERROR_CODES, parseToolJson, redactString } from '@agentship/core';
import { z } from 'zod';

/**
 * Reading `asc` output.
 *
 * With `--output json`, `asc` prints the App Store Connect response verbatim: a JSON:API
 * document with `data`, an optional `included`, and `links`. Agentship parses it structurally
 * — identifiers and relationships — and treats `attributes` as an open bag, because Apple
 * adds attributes between API revisions and a strict schema would turn every such addition
 * into an outage.
 *
 * A few `asc` subcommands (`builds upload`, `screenshots upload`) print a result object of
 * their own design rather than an API document. Those are read leniently and always
 * confirmed with a follow-up query against a real API resource, so the snapshot never
 * depends on a shape `asc` may reword.
 */

const resourceSchema = z.object({
  type: z.string(),
  id: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  relationships: z
    .record(
      z.string(),
      z
        .object({
          data: z
            .union([
              z.object({ type: z.string(), id: z.string() }),
              z.array(z.object({ type: z.string(), id: z.string() })),
              z.null(),
            ])
            .optional(),
        })
        .loose(),
    )
    .optional(),
});

export type JsonApiResource = z.infer<typeof resourceSchema>;

const documentSchema = z.object({
  data: z.union([resourceSchema, z.array(resourceSchema), z.null()]).optional(),
  included: z.array(resourceSchema).optional(),
  links: z.object({ next: z.string().optional() }).loose().optional(),
});

/** Parses `asc` stdout as a JSON:API document and returns its resources as a list. */
export function parseResourceList(stdout: string, command: string): JsonApiResource[] {
  const document = parseDocument(stdout, command);
  if (document.data === undefined || document.data === null) return [];
  return Array.isArray(document.data) ? document.data : [document.data];
}

/** Parses `asc` stdout as a JSON:API document and returns its single resource, if any. */
export function parseResource(stdout: string, command: string): JsonApiResource | undefined {
  return parseResourceList(stdout, command)[0];
}

/** Parses `asc` stdout and returns both the primary resources and the sideloaded ones. */
export function parseDocument(
  stdout: string,
  command: string,
): z.infer<typeof documentSchema> & { included: JsonApiResource[] } {
  const raw = parseToolJson<unknown>(stdout, `asc ${command}`);
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_INVALID_OUTPUT,
      `asc ${command} returned JSON that is not an App Store Connect document.`,
      {
        store: 'apple',
        details: {
          command,
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
          sample: redactString(stdout.slice(0, 400)),
        },
      },
    );
  }
  return { ...parsed.data, included: parsed.data.included ?? [] };
}

/**
 * Parses stdout of a subcommand that prints its own result object.
 *
 * Returns `undefined` rather than throwing when the output is not an object: these results
 * are always cross-checked against a real API resource, so an unreadable one costs an extra
 * query, not a failed operation.
 */
export function parseLooseObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function attrString(
  resource: JsonApiResource | undefined,
  name: string,
): string | undefined {
  const value = resource?.attributes?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function attrNumber(
  resource: JsonApiResource | undefined,
  name: string,
): number | undefined {
  const value = resource?.attributes?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function attrBoolean(
  resource: JsonApiResource | undefined,
  name: string,
): boolean | undefined {
  const value = resource?.attributes?.[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** Id of a to-one relationship, e.g. the build attached to a version. */
export function relatedId(resource: JsonApiResource | undefined, name: string): string | undefined {
  const data = resource?.relationships?.[name]?.data;
  return data !== null && data !== undefined && !Array.isArray(data) ? data.id : undefined;
}
