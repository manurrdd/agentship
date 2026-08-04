/**
 * Core domain vocabulary shared by every Agentship package.
 *
 * Nothing in this file may import from another workspace package: `@agentship/core`
 * is the root of the dependency graph and must stay importable in isolation.
 */

/** A publishing destination Agentship can operate. */
export type Store = 'apple' | 'google';

export const STORES: readonly Store[] = ['apple', 'google'];

/**
 * How a planned action may be executed.
 *
 * - `auto`            — Agentship performs it without asking (reversible, non-public).
 * - `needs_approval`  — Agentship can perform it, but only after the user approves the
 *                       exact content (approval is bound to a content hash by the kernel).
 * - `needs_input`     — Agentship cannot proceed until the user supplies a missing value.
 * - `agent_browser`   — no API exists; the agent may drive its own browser using the
 *                       structured instructions Agentship emits. Agentship never automates
 *                       a browser itself.
 * - `human_only`      — a human must do it in the store console (2FA, legal consent,
 *                       identity, banking...). Agentship emits instructions and verifies later.
 */
export type ActionClass =
  | 'auto'
  | 'needs_approval'
  | 'needs_input'
  | 'agent_browser'
  | 'human_only';

/**
 * How much Agentship trusts a value it extracted or derived.
 *
 * - `certain`  — read verbatim from an authoritative source (e.g. `CFBundleIdentifier`
 *                literal in Info.plist).
 * - `inferred` — derived by a documented rule from authoritative sources (e.g. an
 *                `applicationId` assembled from a Gradle variable defined in the same file).
 * - `guess`    — a heuristic that is frequently right but must never be published without
 *                confirmation (e.g. app name taken from the directory name).
 *
 * A value that cannot be determined is omitted or reported as `unknown`; Agentship never
 * invents store-visible data.
 */
export type Confidence = 'certain' | 'inferred' | 'guess';

/** A value together with where it came from and how much it can be trusted. */
export interface Provenanced<T> {
  readonly value: T;
  readonly confidence: Confidence;
  /** Repo-relative path of the file the value came from, when applicable. */
  readonly source?: string;
  /** Short human/agent readable explanation of how the value was obtained. */
  readonly detail?: string;
}

/** Convenience constructor for {@link Provenanced} values. */
export function provenanced<T>(
  value: T,
  confidence: Confidence,
  source?: string,
  detail?: string,
): Provenanced<T> {
  return {
    value,
    confidence,
    ...(source === undefined ? {} : { source }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Category of a pending (non-automatable) operation, used for grouping and catalogs. */
export type PendingCategory =
  | 'account'
  | 'app_record'
  | 'agreements'
  | 'pricing'
  | 'privacy'
  | 'content_rating'
  | 'availability'
  | 'review'
  | 'monetization'
  | 'credentials'
  | 'other';

/** Lifecycle of a pending operation. */
export type PendingStatus = 'open' | 'in_progress' | 'done' | 'verified' | 'failed' | 'skipped';

/** A single field the human/agent must fill in a store console. */
export interface PendingField {
  /** Stable machine name, e.g. `bundleId`. */
  readonly name: string;
  /** Label as it appears in the console UI, e.g. "Bundle ID". */
  readonly label: string;
  /** Value Agentship proposes; the operator still decides. */
  readonly proposedValue?: string;
  /** Why this value is proposed (evidence), so the operator can judge it. */
  readonly rationale?: string;
  readonly required: boolean;
  /** Allowed values when the console offers a closed list. */
  readonly options?: readonly string[];
  readonly secret?: boolean;
}

/** How Agentship will later confirm the operation actually happened. */
export interface PendingVerification {
  /** Human/agent readable description of the check. */
  readonly summary: string;
  /**
   * Machine hint for the verifier implemented by the store adapter, e.g.
   * `apple:app-exists` or `google:track-exists`. Resolved in later plans.
   */
  readonly check?: string;
  readonly params?: Readonly<Record<string, string>>;
}

/** Where in a store console the operation is performed. */
export interface PendingConsole {
  readonly url: string;
  /** Breadcrumb path inside the console UI, e.g. ["Apps", "My App", "App Information"]. */
  readonly path?: readonly string[];
  /** Console UI version this instruction was verified against (ISO date). */
  readonly lastVerified?: string;
}

/**
 * An operation Agentship cannot perform through an API, emitted as structured data so an
 * agent (or a human) can complete it and Agentship can verify and resume afterwards.
 */
export interface PendingOperation {
  /** Stable identifier, unique within a project. */
  readonly id: string;
  readonly store: Store;
  readonly category: PendingCategory;
  readonly title: string;
  /** Why this cannot be automated — always a factual platform limitation. */
  readonly reason: string;
  /** Whether an agent browser may attempt it, or a human is strictly required. */
  readonly actionClass: Extract<ActionClass, 'agent_browser' | 'human_only' | 'needs_input'>;
  readonly console?: PendingConsole;
  /** Ordered steps to perform in the console, when a breadcrumb path is not enough. */
  readonly steps?: readonly string[];
  readonly fields?: readonly PendingField[];
  readonly verification?: PendingVerification;
  readonly status: PendingStatus;
  /**
   * Ids of planned actions that cannot execute until this operation is `done` or
   * `verified`. Filled in by the kernel when it builds a plan; empty until then.
   */
  readonly blocking?: readonly string[];
  /** ISO timestamp of the last status change. */
  readonly updatedAt?: string;
  readonly notes?: string;
}
