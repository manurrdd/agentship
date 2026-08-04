import { AgentshipError, ERROR_CODES } from '@agentship/core';

/**
 * Filling catalog templates with project data, safely.
 *
 * Three rules, each one a defence rather than a convenience:
 *
 * 1. **Only the allowed roots.** A template may read `manifest.*`, `analysis.*`,
 *    `privacy.*`, `product.*` and `release.*` and nothing else. An unknown root is not an
 *    empty string — it is a malformed catalog entry, and it throws. That is what keeps a
 *    template from ever reaching a credential: there is no path from here to one.
 * 2. **A missing value is stated, never invented.** `{{manifest.app.name}}` with no name
 *    renders as `<needs_input: manifest.app.name>` and the path comes back in `missing`, so
 *    the pending operation shows the operator exactly what to decide instead of a plausible
 *    guess.
 * 3. **Values never enter instructions.** {@link renderInstruction} resolves
 *    `{{field:<name>}}` to the field's *label*, in quotes. Repository-derived text is
 *    untrusted — an app name is written by whoever wrote the repository — so it may appear
 *    as a form value an operator reviews, never as a sentence an agent reads as guidance.
 */
export const ALLOWED_ROOTS: readonly string[] = [
  'manifest',
  'analysis',
  'privacy',
  'product',
  'release',
];

/**
 * Words a path segment must never contain, whatever a catalog file asks for.
 *
 * Deliberately over-broad — the allowed-roots rule already makes a leak hard and this is the
 * second lock on the same door — but matched at word boundaries after splitting camelCase, so
 * a standalone `key`, `apiKey` or `serviceAccount` is refused while a legitimate App Store
 * field like `keywords` (which merely *contains* "key") is not. An anchored substring match
 * would block `keywords`, breaking a real feature; a word-boundary match keeps the protection
 * without the false positive.
 */
const FORBIDDEN_WORDS =
  /\b(?:credentials?|secret|passphrase|password|token|api[ _-]?key|private[ _-]?key|key|keystore|keyfile|service[ _-]?account|p8|p12|pkcs12|pem|jks|mnemonic|seed|certificate|cert)\b/;

/** True when a path segment names secret-bearing material. */
function namesSecret(segment: string): boolean {
  // `apiKey` -> `api key`, `serviceAccountJson` -> `service account json`: word boundaries
  // then separate the tokens a substring match would run together.
  const spaced = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return FORBIDDEN_WORDS.test(spaced);
}

const EXPRESSION = /\{\{\s*([^}]*?)\s*\}\}/g;

/** Values a template may resolve to. Deliberately flat: no objects reach a console field. */
export type ContextValue = string | number | boolean;

/** Dotted paths under the allowed roots, e.g. `manifest.app.name`. */
export type CatalogContext = Readonly<Record<string, ContextValue>>;

export interface Resolved {
  readonly text: string;
  /** Paths the context had no value for, in template order, without duplicates. */
  readonly missing: readonly string[];
}

function reject(expression: string, why: string): never {
  throw new AgentshipError(
    ERROR_CODES.CONFIG_INVALID,
    `Catalog template "{{${expression}}}" is not allowed: ${why}`,
    {
      details: { expression, allowedRoots: ALLOWED_ROOTS },
      remediation: { summary: 'Fix the catalog entry: templates may only read project data.' },
    },
  );
}

/** Validates one template expression and returns its normalised path. */
export function checkPath(expression: string): string {
  const path = expression.trim();
  if (path === '') reject(expression, 'it is empty.');
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_-]+)*$/.test(path)) {
    reject(expression, 'only dotted identifiers are accepted.');
  }
  const segments = path.split('.');
  const root = segments[0] as string;
  if (!ALLOWED_ROOTS.includes(root)) {
    reject(expression, `"${root}" is not one of ${ALLOWED_ROOTS.join(', ')}.`);
  }
  if (segments.some(namesSecret)) {
    reject(expression, 'it names a secret-bearing path.');
  }
  return path;
}

/**
 * Resolves a value template against the context.
 *
 * Used for field values, verification parameters and notes — never for instructions, which
 * go through {@link renderInstruction}.
 */
export function resolveTemplate(template: string, context: CatalogContext): Resolved {
  const missing: string[] = [];
  const text = template.replace(EXPRESSION, (_match, expression: string) => {
    const path = checkPath(expression);
    const value = context[path];
    if (value === undefined) {
      if (!missing.includes(path)) missing.push(path);
      return `<needs_input: ${path}>`;
    }
    return String(value);
  });
  return { text, missing };
}

/**
 * Resolves `{{field:<name>}}` references in an instruction to the field's quoted label.
 *
 * A reference to a field the step does not declare is a catalog bug and throws, so an
 * instruction can never silently point at nothing. Any other `{{…}}` in an instruction is
 * refused outright: that is the rule that keeps untrusted values out of guidance text.
 */
export function renderInstruction(
  instruction: string,
  fields: readonly { readonly name: string; readonly label: string }[],
): string {
  return instruction.replace(EXPRESSION, (_match, expression: string) => {
    const raw = expression.trim();
    if (!raw.startsWith('field:')) {
      reject(
        raw,
        'an instruction may only reference its own fields ({{field:name}}); values never appear in instruction text.',
      );
    }
    const name = raw.slice('field:'.length).trim();
    const field = fields.find((candidate) => candidate.name === name);
    if (field === undefined) {
      reject(raw, `this step declares no field named "${name}".`);
    }
    return `“${field.label}”`;
  });
}
