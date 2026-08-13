import type { OperationId } from '../store-ops.js';
import type { PlannedAction, ReleasePlan } from './plan.js';

/**
 * Approvals: the mechanism that makes "nothing sensitive without a human" enforceable.
 *
 * An approval is a string equal to a planned action's id — and an action id embeds the
 * hash of what that action will make true. There is nothing else to an approval: no
 * session, no expiry bookkeeping. If the content changes, replanning mints a new id, the
 * old approval matches nothing, and the action is withheld until it is approved again.
 *
 * A plan id is also accepted, and means "this exact set of actions". That is not a weaker
 * promise — the plan id is the hash of the action ids, so it goes stale on any change the
 * individual ids would have caught. It exists because the alternative failed a real user:
 * having read the plan and said "do it", they were asked to paste back a dozen hashes, and
 * then asked again after every partial apply. Two operations stay individual whatever
 * happens; see {@link ALWAYS_INDIVIDUAL}.
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

/**
 * Operations that are approved one by one even when the whole plan was approved.
 *
 * The line is "does this reach real people, irreversibly". Submitting to review starts a
 * process at Apple or Google that a user cannot take back, and releasing a held version puts
 * it in front of everyone. Everything else a plan contains — text, images, a build going to a
 * testing channel, a price on a product nobody has bought yet — is visible in the plan and
 * covered by approving that plan.
 *
 * Kept deliberately short. A list that grows swallows the plan-level approval and the
 * ceremony comes back one operation at a time.
 */
const ALWAYS_INDIVIDUAL: ReadonlySet<OperationId> = new Set<OperationId>([
  'submitForReview',
  'releaseVersion',
]);

/**
 * Whether an approval covers everything in one plan.
 *
 * The plan id is the hash of the set of action ids, so approving it is not a blanket "yes":
 * it names exactly this set of actions with exactly this content. Add an action, change a
 * word in a description, let the store drift — the plan id changes and the approval stops
 * matching, exactly like an action-level one.
 *
 * This exists because the alternative was worse in practice, not because it is looser. A
 * user who has read the plan and says "do it" was being asked to paste back a dozen hashes,
 * and then to paste them again after each partial apply.
 */
export function isPlanApproval(plan: ReleasePlan, approval: string): boolean {
  return approval === plan.planId;
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
    if (isPlanApproval(plan, approval)) {
      for (const [id, action] of requiring) {
        if (!ALWAYS_INDIVIDUAL.has(action.operation)) valid.add(id);
      }
    } else if (requiring.has(approval)) {
      valid.add(approval);
    } else if (approval.startsWith('plan-') || keysInPlan.has(actionKey(approval))) {
      // A `plan-` id that is not this plan's is the commonest stale approval there is: the
      // user approved the plan, a partial apply moved the store, and the next plan differs.
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
