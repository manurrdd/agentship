/**
 * Building objects with optional properties under `exactOptionalPropertyTypes`.
 *
 * The project's domain types distinguish "absent" from "present and undefined", which is
 * what lets a snapshot say "the store has no subtitle" instead of "someone forgot to set
 * one". The cost is that spreading a possibly-undefined value into an object literal no
 * longer type-checks, so the omission has to be explicit.
 */

/** `{ key: value }` when the value exists, `{}` when it does not. */
export function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
