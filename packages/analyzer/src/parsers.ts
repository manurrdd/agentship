import plist from 'plist';
import { parse as parseYamlText } from 'yaml';

/**
 * Parsers for the formats the analyzer reads.
 *
 * Two established libraries do the heavy lifting where the format warrants it (`plist` for
 * Info.plist, `yaml` for pubspec). Gradle build scripts and `project.pbxproj` get *targeted
 * extraction* instead: both are programming-language-adjacent formats whose full semantics
 * can only be resolved by running them, which the analyzer never does. Extracting the
 * handful of literal settings Agentship needs — and reporting `unknown` whenever the value is
 * a variable, a function call or otherwise not literal — is both safer and more honest than
 * pretending to evaluate them.
 *
 * Every function here is total: malformed input yields `undefined` or an empty result, never
 * an exception. A hostile repository must not be able to abort an analysis.
 */

/**
 * Runs `fn` with console output suppressed.
 *
 * The XML parser underneath `plist` reports malformed documents by writing to the console
 * instead of only throwing. A malformed Info.plist is a normal finding here — it becomes a
 * warning in the result — so its diagnostics must not leak into the process output, which
 * for the MCP server is a protocol channel.
 */
const SILENCED_METHODS = ['error', 'warn', 'log'] as const;

function silenced<T>(fn: () => T): T {
  // Swapping the console methods out is the point of this function; the third-party parser
  // offers no other way to suppress its diagnostics.
  const target = console as unknown as Record<string, unknown>;
  const original: Record<string, unknown> = {};
  const noop = (): void => undefined;
  for (const method of SILENCED_METHODS) {
    original[method] = target[method];
    target[method] = noop;
  }
  try {
    return fn();
  } finally {
    for (const method of SILENCED_METHODS) target[method] = original[method];
  }
}

/** Parses an XML property list. Binary plists and malformed XML yield `undefined`. */
export function parsePlist(text: string): Record<string, unknown> | undefined {
  if (text.startsWith('bplist00')) return undefined;
  try {
    const value = silenced(() => plist.parse(text));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses YAML in recovery mode.
 *
 * `logLevel: 'silent'` makes the parser salvage what it can from a document with syntax
 * errors instead of rejecting the whole file — the right trade for an analyzer, where a
 * pubspec with one bad line should still yield the app's name and version. Input it cannot
 * recover from, or that is not a mapping, yields `undefined` and the caller warns.
 */
export function parseYaml(text: string): unknown {
  try {
    return parseYamlText(text, { logLevel: 'silent' });
  } catch {
    return undefined;
  }
}

/** Removes `//`, `#` and `/* *​/` comments so extraction never matches commented-out code. */
export function stripComments(source: string): string {
  let out = '';
  let index = 0;
  let inString: string | undefined;

  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (inString !== undefined) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index += 2;
        continue;
      }
      if (char === inString) inString = undefined;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Returns the body of the first `name { … }` block, matching braces so nested blocks do not
 * end it early. Returns `undefined` when the block is absent or unbalanced.
 */
export function extractBlock(source: string, name: string): string | undefined {
  const opener = new RegExp(`(^|[^\\w.])${name}\\s*(\\([^)]*\\)\\s*)?\\{`, 'm');
  const match = opener.exec(source);
  if (match === null) return undefined;
  const start = match.index + match[0].length;
  let depth = 1;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index);
    }
  }
  return undefined;
}

/** Names of the direct children blocks of a block body, e.g. flavour or build-type names. */
export function blockChildNames(body: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index] as string;
    if (char === '{') {
      if (depth === 0) {
        // Groovy: `free {`. Kotlin DSL: `create("free") {` or `register("free") {`.
        const kotlin = /(?:create|register|named|getByName)\s*\(\s*["']([^"']+)["']\s*\)\s*$/.exec(
          current.trim(),
        );
        const groovy = /([A-Za-z_][\w]*)\s*$/.exec(current.trim());
        const name = kotlin?.[1] ?? groovy?.[1];
        if (name !== undefined && !RESERVED_BLOCK_WORDS.has(name)) names.push(name);
        current = '';
      }
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      continue;
    }
    if (depth === 0) current += char;
  }
  return [...new Set(names)];
}

const RESERVED_BLOCK_WORDS = new Set(['all', 'each', 'forEach', 'if', 'else', 'it']);

/**
 * Reads a literal assignment from a Gradle script, in either DSL:
 * `applicationId "com.x"`, `applicationId = "com.x"`, `versionCode 12`, `versionCode = 12`.
 * A non-literal value (a variable, `project.property(...)`, a version catalog reference)
 * returns `undefined`, because guessing it would mean evaluating the build script.
 */
export function gradleValue(source: string, key: string): string | undefined {
  // Every whitespace run is bounded (`\s{0,40}`). Real Gradle scripts never separate a key
  // from its value by more than a few characters, and an unbounded run of overlapping `\s*`
  // quantifiers backtracks catastrophically against a hostile `build.gradle` (a key padded
  // with kilobytes of spaces and no closing literal), freezing the single-threaded analyzer.
  // `key` is always an Agentship-supplied constant, never repository input, so it is not escaped.
  const pattern = new RegExp(
    `(?:^|[^\\w.])${key}(?:\\.set)?\\s{0,40}(?:=\\s{0,40})?\\(?\\s{0,40}(?:"([^"]*)"|'([^']*)'|([0-9]+))`,
    'm',
  );
  const match = pattern.exec(source);
  if (match === null) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

export function gradleNumber(source: string, key: string): number | undefined {
  const value = gradleValue(source, key);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Maven coordinates declared in a Gradle script, e.g. `com.google.firebase:firebase-analytics`.
 * The version, when literal, is kept; catalog aliases (`libs.firebase.analytics`) are not
 * resolved and simply do not appear.
 */
export function gradleDependencies(source: string): { coordinate: string; version?: string }[] {
  const results: { coordinate: string; version?: string }[] = [];
  const pattern = /["']([a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+)(?::([^"']+))?["']/g;
  for (const match of source.matchAll(pattern)) {
    const coordinate = match[1];
    if (coordinate === undefined || !coordinate.includes(':')) continue;
    results.push({ coordinate, ...(match[2] === undefined ? {} : { version: match[2] }) });
  }
  return results;
}

/**
 * Build settings from an Xcode `project.pbxproj`.
 *
 * The file is a NeXTSTEP property list of the whole project graph; Agentship only needs a few
 * settings, and only their literal values. When a setting differs between configurations,
 * the first literal value wins and the caller reports it as `inferred`.
 */
export function pbxprojSettings(source: string): Map<string, string[]> {
  const settings = new Map<string, string[]>();
  const pattern = /^\s*([A-Z][A-Z0-9_]{2,})\s*=\s*(?:"([^"]*)"|([^;\n]+));/gm;
  for (const match of source.matchAll(pattern)) {
    const key = match[1];
    const value = (match[2] ?? match[3] ?? '').trim();
    if (key === undefined || value === '') continue;
    const existing = settings.get(key);
    if (existing === undefined) settings.set(key, [value]);
    else if (!existing.includes(value)) existing.push(value);
  }
  return settings;
}

/** Build configuration names declared in a `project.pbxproj`. */
export function pbxprojConfigurations(source: string): string[] {
  const names = new Set<string>();
  const section =
    /\/\* Begin XCBuildConfiguration section \*\/([\s\S]*?)\/\* End XCBuildConfiguration section \*\//.exec(
      source,
    );
  const body = section?.[1] ?? source;
  for (const match of body.matchAll(/^\s*name = (?:"([^"]+)"|([\w.-]+));/gm)) {
    const name = match[1] ?? match[2];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

export interface XmlElement {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * Extracts elements and their attributes from an XML document.
 *
 * Targeted rather than a full parse: AndroidManifest.xml and `.entitlements` are read for a
 * flat list of attributes, and a tolerant scan degrades gracefully on the malformed files a
 * real repository contains, where a strict parser would abort the whole analysis.
 */
export function xmlElements(source: string, tag: string): XmlElement[] {
  const elements: XmlElement[] = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)>`, 'g');
  for (const match of source.matchAll(pattern)) {
    const attributes: Record<string, string> = {};
    for (const attribute of (match[1] ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
      const name = attribute[1];
      if (name !== undefined) attributes[name] = attribute[2] ?? '';
    }
    elements.push({ tag, attributes });
  }
  return elements;
}

/** Keys of an Apple `.entitlements` plist, with their scalar values when simple. */
export function entitlementKeys(source: string): { key: string; value?: string }[] {
  const parsed = parsePlist(source);
  if (parsed === undefined) return [];
  return Object.entries(parsed).map(([key, value]) => ({
    key,
    ...(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? { value: String(value) }
      : {}),
  }));
}
