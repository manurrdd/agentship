import type { AppAnalysis } from '../analysis.js';
import type { BatchOp, OperationId, PriceConversion } from '../store-ops.js';
import type { RemoteAppState } from '../store-state.js';
import type { PendingOperation, Store } from '../types.js';
import type { AgentshipManifest } from './manifest.js';

/**
 * The extension point the kernel offers to everything that publishes.
 *
 * A {@link ResourceDiffer} owns one resource of one store — `apple/metadata`,
 * `google/release` — and answers a single question: given the manifest and a fresh
 * snapshot, what has to change? It answers with {@link ActionDraft}s, which are pure
 * descriptions. Everything cross-cutting is the kernel's job, not the differ's:
 * identifiers, classification and its policy overrides, approval binding, dependency
 * resolution, ordering, batching, journaling and resumption.
 *
 * Rules a differ must follow (enforced by convention and by the kernel's tests):
 *
 * - **Gaps are not absence.** An area listed in {@link RemoteAppState.gaps} is unknown,
 *   not empty. A differ must never emit a destructive or overwriting action for an area
 *   it could not read; skip it or emit a pending draft instead.
 * - **Sentinels stop planning.** A manifest value equal to `NEEDS_INPUT` makes the
 *   affected draft `needs_input` (report it via {@link ActionDraft.needsInput}), never a
 *   guessed value.
 * - **Drafts are deterministic.** Same manifest + same state ⇒ same drafts, in any order.
 *   Ids hash the content, so ordering does not matter, but content must not depend on
 *   wall-clock time or randomness.
 */
/**
 * Read-only questions a differ may ask the store while planning.
 *
 * Deliberately not the adapter. A differ that held a {@link import('../adapter.js').StoreAdapter}
 * could write, and "planning" would stop being a pure description of what *would* happen —
 * the property every approval in the system rests on. What a differ genuinely cannot do
 * without asking is propose a regional price: only the store knows what 4.99 USD is worth in
 * Japan, and Agentship must show that table to the user *before* anything is applied. So the
 * one capability handed over is the one that is needed, and it cannot change anything.
 */
export interface DifferProposals {
  /** The store's own conversion of a base price into its other territories. */
  convertPrice(basePrice: string, baseTerritory: string): Promise<PriceConversion>;
}

export interface DifferInput {
  readonly store: Store;
  readonly manifest: AgentshipManifest;
  readonly state: RemoteAppState;
  readonly repoRoot: string;
  /**
   * Present when the kernel could reach the store. Absent in unit tests and in any context
   * without an adapter, so a differ must always have an answer for "no proposal available"
   * — which is `needs_input`, never a made-up price.
   */
  readonly proposals?: DifferProposals;
  /**
   * The analysis of the repository, when one has been captured. Used by the privacy differs
   * to show the evidence behind a declaration and to notice that the code moved since the
   * user confirmed it.
   */
  readonly analysis?: AppAnalysis;
}

/** A readable, field-level difference an agent can show a human before approval. */
export interface DiffEntry {
  /** Dot path of the field, e.g. `metadata.en-US.description`. */
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
  /** Free-text qualifier when before/after do not tell the whole story. */
  readonly note?: string;
}

/**
 * Work an action performs on this machine instead of in a store.
 *
 * Building and signing the app is the only release step whose effect is a local file, so it
 * cannot travel through {@link import('../store-ops.js').BatchOp} — there is no store to
 * send it to — and it must not be smuggled into an adapter either. It gets its own payload
 * and its own runner, and everything else about it (identity, classification, approvals,
 * journaling, resumption) is unchanged: from the plan's point of view it is an action like
 * any other.
 */
export interface LocalOp {
  /** Runner that performs it, e.g. `build`. Registered on the kernel. */
  readonly kind: string;
  /** Payload the runner understands. Must be serialisable: it is part of the action hash. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Reference to another draft by content-free identity, resolved to an id by the kernel.
 *
 * `optional` exists because a store's actions are drafted by several independent differs
 * that cannot see each other's output. "Upload the build after it is built" is an ordering
 * constraint that only applies when a build is also planned — and when it is not, the
 * dependency is simply absent, not broken. A required reference that nothing satisfies is
 * still an error, so a typo cannot silently drop an ordering that matters.
 */
export interface ActionKey {
  readonly kind: string;
  readonly target: string;
  readonly optional?: boolean;
}

/**
 * What a differ proposes. The kernel turns drafts into `PlannedAction`s by assigning
 * hash-based ids, classifying them against the store's capabilities and the safety
 * policy, and resolving `dependsOn` keys into ids.
 */
export interface ActionDraft {
  /** Operation-shaped verb, e.g. `set_metadata`, `upload_build`. */
  readonly kind: string;
  /** Resource path the action touches, unique per kind within a store's plan. */
  readonly target: string;
  /** Contract operation this action maps to; classification starts from its capability. */
  readonly operation: OperationId;
  /** One line an agent can print, e.g. `Update en-US listing text (2 fields)`. */
  readonly summary: string;
  readonly diff: readonly DiffEntry[];
  /** Executable payload, present when the store has an API path for this action. */
  readonly op?: BatchOp;
  /** Executable payload for work performed on this machine. Mutually exclusive with `op`. */
  readonly local?: LocalOp;
  /**
   * Pending operation to emit instead of executing, for `agent_browser` / `human_only`
   * capabilities. When the capability requires one and the draft does not provide it,
   * the kernel synthesises a minimal pending operation from the draft.
   */
  readonly pending?: PendingOperation;
  /** Drafts that must execute before this one, referenced by (kind, target). */
  readonly dependsOn?: readonly ActionKey[];
  /** Ids of pending operations that must be done/verified before this action may run. */
  readonly blockedBy?: readonly string[];
  /** Manifest gaps that keep this action from executing; forces `needs_input`. */
  readonly needsInput?: readonly string[];
  /** Deletes or irreversibly overwrites store content; forces `needs_approval`. */
  readonly destructive?: boolean;
  /** Reaches end users or production when applied; forces `needs_approval`. */
  readonly production?: boolean;
  readonly riskNotes?: readonly string[];
}

export interface ResourceDiffer {
  readonly store: Store;
  /** Resource this differ owns, e.g. `metadata`. Unique per store within a registry. */
  readonly resource: string;
  plan(input: DifferInput): Promise<readonly ActionDraft[]> | readonly ActionDraft[];
}

/** Holds the differs the kernel plans with. The store adapters register the real ones. */
export class DifferRegistry {
  private readonly differs = new Map<string, ResourceDiffer>();

  register(differ: ResourceDiffer): this {
    const key = `${differ.store}/${differ.resource}`;
    if (this.differs.has(key)) {
      throw new Error(`A differ for ${key} is already registered.`);
    }
    this.differs.set(key, differ);
    return this;
  }

  forStore(store: Store): readonly ResourceDiffer[] {
    return [...this.differs.values()]
      .filter((differ) => differ.store === store)
      .sort((a, b) => a.resource.localeCompare(b.resource));
  }

  all(): readonly ResourceDiffer[] {
    return [...this.differs.values()];
  }
}
