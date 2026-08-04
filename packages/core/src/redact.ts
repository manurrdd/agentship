/**
 * Redaction of secret material.
 *
 * Every string that leaves Agentship towards a log file, an error message or an agent goes
 * through {@link redactString}. Redaction is defensive, not a licence to log secrets: code
 * must still avoid putting them anywhere. The rules here cover the concrete shapes Agentship
 * handles — Apple `.p8` PEM keys, JWTs minted from them, Google service-account JSON and
 * `Authorization` headers — plus any literal value registered with
 * {@link registerSecret}.
 */

const MAX_DEPTH = 8;
// Floor for literals registered with {@link registerSecret}. Kept above the length of common
// short tokens so scrubbing never mangles unrelated text, but low enough to cover a keystore
// password (keytool refuses anything under six characters), which credentials register here.
const MIN_LITERAL_LENGTH = 6;

/** Literal secrets registered at runtime (e.g. right after reading them from the keyring). */
const literalSecrets = new Set<string>();

/**
 * Registers a literal value to be scrubbed from any redacted output.
 *
 * Called by `@agentship/credentials` whenever a secret is materialised, so that even an
 * unforeseen leak path (a subprocess echoing it back, a store error quoting it) is caught.
 * Values shorter than 8 characters are ignored: scrubbing them would mangle unrelated text.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_LITERAL_LENGTH) return;
  literalSecrets.add(trimmed);
}

/** Test/teardown helper: forgets every literal registered with {@link registerSecret}. */
export function clearRegisteredSecrets(): void {
  literalSecrets.clear();
}

/**
 * Object keys whose value is always replaced, whatever it looks like.
 *
 * Matched as a substring, not anchored: a key is secret-bearing if a secret word appears
 * anywhere in it, so `storePassword`, `keyPassword`, `privateKeyPem`, `serviceAccountJson`,
 * `clientSecret` and `refreshToken` are all caught — camelCase compounds an anchored pattern
 * would miss. Over-matching a harmless key only over-redacts a log line, which is the safe
 * direction; under-matching leaks a credential.
 */
const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|authorization|cookie|keystore|serviceaccount|sa[_-]?json|p8/i;

interface Rule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const RULES: readonly Rule[] = [
  // Apple .p8 keys and any other PEM-encoded private key, including JSON-escaped ones.
  {
    pattern: /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:PEM]',
  },
  // JSON string members holding key material (service-account JSON).
  {
    pattern:
      /("(?:private_key|private_key_id|client_secret|refresh_token)"\s*:\s*)"(?:\\.|[^"\\])*"/g,
    replacement: '$1"[REDACTED]"',
  },
  // Bearer tokens / Authorization headers.
  {
    pattern: /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/gi,
    replacement: '$1[REDACTED]',
  },
  // JWTs (the tokens Agentship's adapters mint from the Apple key).
  {
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?![A-Za-z0-9_-])/g,
    replacement: '[REDACTED:JWT]',
  },
  // Google API keys.
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: '[REDACTED:GOOGLE_API_KEY]' },
  // `--password=xxx`, `token: xxx`, `apiKey="xxx"` in command lines and free text.
  {
    pattern:
      /((?:password|passwd|secret|token|api[_-]?key|private[_-]?key)["']?\s*[:=]\s*)(["']?)([^\s"',;)]+)\2/gi,
    replacement: '$1$2[REDACTED]$2',
  },
];

/** Replaces every known secret shape in `input`. Always returns a string. */
export function redactString(input: string): string {
  let out = input;
  for (const { pattern, replacement } of RULES) {
    // Patterns are module-level and global; reset lastIndex defensively.
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  for (const secret of literalSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/**
 * True when `value` contains something the redactor would scrub.
 *
 * Used to enforce "no secrets in process arguments": argv is world-readable through `ps`,
 * so a value that looks secret must travel via the environment or stdin instead.
 */
export function looksSecret(value: string): boolean {
  return redactString(value) !== value;
}

/**
 * Deeply redacts an arbitrary value for logging: strings are scrubbed, values under
 * secret-looking keys are replaced wholesale, cycles and excessive depth are cut.
 * The result is always JSON-serialisable.
 */
export function redactValue(value: unknown): unknown {
  return redactInner(value, 0, new WeakSet<object>(), true);
}

/**
 * Deeply scrubs secret-shaped strings, without the key-name rule {@link redactValue} applies.
 *
 * For curated payloads whose *keys* are Agentship's own and whose *values* might carry a leaked
 * secret string — the MCP tool response, where a build tool's stdout can surface in an error's
 * evidence. The key rule is what wholesale-replaces a value under a key like `credentials`, and
 * a status field such as `currentCredentials: "none"` legitimately trips it; here only the
 * string contents are inspected, so shaped or registered secrets are still removed while a
 * non-secret status value survives.
 */
export function scrubStrings(value: unknown): unknown {
  return redactInner(value, 0, new WeakSet<object>(), false);
}

function redactInner(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  applyKeyRule: boolean,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return '[unserialisable]';
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (value instanceof Error) {
    const base: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    if (typeof (value as { code?: unknown }).code === 'string') {
      base['code'] = (value as unknown as { code: string }).code;
    }
    if (value.stack !== undefined) base['stack'] = redactString(value.stack);
    if (value.cause !== undefined) {
      base['cause'] = redactInner(value.cause, depth + 1, seen, applyKeyRule);
    }
    return base;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return redactString(value.toString());
  if (Buffer.isBuffer(value)) return `[buffer ${value.byteLength}B]`;

  if (typeof value === 'object') {
    const obj = value as object;
    if (seen.has(obj)) return '[circular]';
    seen.add(obj);
    if (Array.isArray(value)) {
      return value.map((item) => redactInner(item, depth + 1, seen, applyKeyRule));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        applyKeyRule && SECRET_KEY_PATTERN.test(key)
          ? '[REDACTED]'
          : redactInner(item, depth + 1, seen, applyKeyRule);
    }
    return out;
  }
  return '[unserialisable]';
}
