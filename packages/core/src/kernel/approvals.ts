import type { PlannedAction, ReleasePlan } from './plan.js';

/**
 * Approvals: the mechanism that makes "nothing sensitive without a human" enforceable.
 *
 * An approval is a string equal to a planned action's id — and an action id embeds the
 * hash of the action's content. There is nothing else to an approval: no session, no
 * expiry bookkeeping, no "approve all". If the content changes (locally or through
 * remote drift), replanning mints a new id, the old approval matches nothing, and the
 * action is simply withheld until it is approved again against the new content.
 */
export interface ApprovalCheck {
  /** Approvals that match a current action requiring approval. */
  readonly valid: ReadonlySet<string>;
  /**
   * Approvals that name a (kind, target) present in the plan but with a different
   * content hash: the plan changed after they were granted.
   */
  readonly stale: readonly string[];
  /** Approvals that match nothing in the plan at all. */
  readonly unknown: readonly string[];
  /** Actions requiring approval that no valid approval covers. */
  readonly missing: readonly string[];
}

/** Strips the trailing content hash of an action id, leaving `kind:target`. */
function actionKey(id: string): string {
  const cut = id.lastIndexOf(':');
  return cut === -1 ? id : id.slice(0, cut);
}

export function checkApprovals(plan: ReleasePlan, approvals: readonly string[]): ApprovalCheck {
  const requiring = new Map<string, PlannedAction>(
    plan.actions
      .filter((action) => action.classification === 'needs_approval')
      .map((action) => [action.id, action]),
  );
  const keysInPlan = new Set(plan.actions.map((action) => actionKey(action.id)));

  const valid = new Set<string>();
  const stale: string[] = [];
  const unknown: string[] = [];
  for (const approval of new Set(approvals)) {
    if (requiring.has(approval)) {
      valid.add(approval);
    } else if (keysInPlan.has(actionKey(approval))) {
      stale.push(approval);
    } else {
      unknown.push(approval);
    }
  }

  const missing = [...requiring.keys()].filter((id) => !valid.has(id));
  return { valid, stale, unknown, missing };
}

/** True when this action may execute under the given approval check. */
export function isApproved(action: PlannedAction, check: ApprovalCheck): boolean {
  return action.classification !== 'needs_approval' || check.valid.has(action.id);
}
