/**
 * Compares store text after removing transport-only differences.
 *
 * Store CLIs commonly write listing files with a final newline and return that newline when
 * they read them back. A manifest scalar normally has none. Treating those as different
 * creates a no-op metadata action and, because uploads share the same edit, can put an
 * otherwise valid release behind an approval for text that will not visibly change.
 * Internal whitespace is untouched; only line-ending representation and whitespace after
 * the last visible character are transport noise.
 */
export function equivalentStoreText(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const normalize = (value: string): string => value.replace(/\r\n?/g, '\n').trimEnd();
  return normalize(left) === normalize(right);
}
