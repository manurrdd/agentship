import type { ActionDraft, ActionKey, AgentshipManifest } from '@agentship/core';

/**
 * Which Google actions belong in one Play edit, and which cannot.
 *
 * Google's model is an *edit*: a transaction opened against an app, filled with changes, and
 * committed. A commit is atomic and — unless it says otherwise — sends the app to review. So
 * two things follow, and this module is where both are expressed.
 *
 * **Everything that can share an edit must.** Not for speed: each extra commit is another
 * chance to send the app to review, another chance to collide with a review already running,
 * and another partial state to recover from.
 *
 * **What cannot share an edit comes after, in its own.** A staged rollout only exists once a
 * release has been committed; promoting a build between tracks addresses a release that must
 * already be there. Those are post-commit operations, and pretending they could join the
 * first edit would produce a plan that fails halfway.
 *
 * **How far "must" actually reaches, honestly.** `gpc` owns the edit lifecycle: it opens,
 * fills and commits one edit per invocation, and exposes no way to hold an edit open across
 * commands. So a single edit is achieved *within* a command — `listings push` covers every
 * locale, `images sync` every locale, device and slot — and Agentship's grouping cannot fuse
 * two commands into one commit. What the dependencies below buy is the next best thing: the
 * groupable actions run consecutively, in the order Play wants, inside one `applyBatch`, under
 * one package lock, so no other Agentship call can interleave an edit between them. Reducing
 * that to a genuine single commit would require an adapter that speaks the Play API directly
 * instead of `gpc`; the {@link StoreAdapter} contract is what keeps that substitution open.
 */
export type GoogleActionKind =
  | 'set_metadata'
  | 'sync_screenshots'
  | 'upload_build'
  | 'manage_tester_groups'
  | 'submit_for_review'
  | 'set_phased_release'
  | 'promote_release';

/** Actions Agentship commits together, in the order Play wants them inside an edit. */
export const GOOGLE_EDIT_GROUP: readonly GoogleActionKind[] = [
  'manage_tester_groups',
  'set_metadata',
  'sync_screenshots',
  'upload_build',
  'submit_for_review',
];

/** Actions that address a release that must already be committed. */
export const GOOGLE_POST_COMMIT: readonly GoogleActionKind[] = [
  'set_phased_release',
  'promote_release',
];

/** Identity of every action that could take part in the shared edit. */
export const GOOGLE_EDIT_GROUP_KEYS: readonly ActionKey[] = [
  { kind: 'manage_tester_groups', target: 'groups', optional: true },
  { kind: 'set_metadata', target: 'listing', optional: true },
  { kind: 'sync_screenshots', target: 'images', optional: true },
];

/**
 * The dependencies a draft needs so the shared edit stays one edit.
 *
 * `preceding` lists the group members that must run before `kind`; every reference is
 * optional, because a plan rarely contains all of them and a missing sibling is not a broken
 * dependency.
 */
export function editGroupDependencies(
  kind: GoogleActionKind,
  buildNumber?: string,
): readonly ActionKey[] {
  const index = GOOGLE_EDIT_GROUP.indexOf(kind);
  if (index > 0) {
    const preceding = GOOGLE_EDIT_GROUP.slice(0, index);
    return preceding.map((previous) => keyFor(previous, buildNumber));
  }
  if (GOOGLE_POST_COMMIT.includes(kind)) {
    // Everything in the edit, so a rollout or a promotion is never planned before the
    // release it addresses exists.
    return GOOGLE_EDIT_GROUP.map((previous) => keyFor(previous, buildNumber));
  }
  return [];
}

/**
 * Ordering the release behind the monetisation catalog it references.
 *
 * Play's product endpoints are not edits, so a product write cannot join the shared edit —
 * but a release that references a product Play does not have yet is rejected at review. So
 * every edit member declares an optional dependency on every declared product's actions,
 * which puts the whole catalog before the whole edit and keeps the edit members contiguous
 * relative to each other.
 *
 * Derived from the manifest rather than from the other differs' output, because a differ
 * cannot see what its siblings drafted — and every reference is optional, so a product that
 * already converged simply is not in the plan.
 */
export function monetizationDependencies(manifest: AgentshipManifest): readonly ActionKey[] {
  const keys: ActionKey[] = [{ kind: 'set_data_safety', target: 'data-safety', optional: true }];
  for (const product of manifest.monetization?.products ?? []) {
    const productId = product.google?.productId;
    if (productId === undefined) continue;
    keys.push(
      { kind: 'create_product', target: `product/${productId}`, optional: true },
      { kind: 'update_product', target: `product/${productId}`, optional: true },
      { kind: 'set_product_pricing', target: `price/${productId}`, optional: true },
      { kind: 'set_product_offers', target: `offers/${productId}`, optional: true },
    );
  }
  return keys;
}

function keyFor(kind: GoogleActionKind, buildNumber: string | undefined): ActionKey {
  switch (kind) {
    case 'manage_tester_groups':
      return { kind, target: 'groups', optional: true };
    case 'set_metadata':
      return { kind, target: 'listing', optional: true };
    case 'sync_screenshots':
      return { kind, target: 'images', optional: true };
    case 'upload_build':
      return { kind, target: `bundle/${buildNumber ?? 'unknown'}`, optional: true };
    case 'submit_for_review':
      return { kind, target: 'release', optional: true };
    case 'set_phased_release':
      return { kind, target: 'rollout', optional: true };
    case 'promote_release':
      return { kind, target: 'promote', optional: true };
  }
}

/**
 * Checks that a set of drafts really would travel as one uninterrupted `applyBatch`.
 *
 * Not "as one Play edit" — see the module doc for why `gpc` cannot offer that. What this
 * proves is the property Agentship does guarantee and the release tests assert: the groupable
 * actions are totally ordered by `dependsOn`, so the executor emits them as a single
 * consecutive run rather than letting an unrelated action split them apart.
 *
 * Used by the tests rather than by the runtime: the guarantee is produced by the dependencies
 * above, and this is how it is proved rather than assumed.
 */
export function groupsIntoOneBatch(drafts: readonly ActionDraft[]): boolean {
  const kinds = drafts.map((draft) => draft.kind);
  const groupable = kinds.filter((kind) => (GOOGLE_EDIT_GROUP as readonly string[]).includes(kind));
  if (groupable.length <= 1) return true;
  // Every groupable draft must depend on every groupable draft that precedes it in the
  // canonical order; that total order is what makes the executor emit a single batch.
  return groupable.every((kind) => {
    const draft = drafts.find((candidate) => candidate.kind === kind) as ActionDraft;
    const expected = editGroupDependencies(kind as GoogleActionKind).filter((key) =>
      groupable.includes(key.kind),
    );
    const actual = new Set((draft.dependsOn ?? []).map((key) => key.kind));
    return expected.every((key) => actual.has(key.kind));
  });
}
