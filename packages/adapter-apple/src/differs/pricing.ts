import type { ActionDraft, DiffEntry, DifferInput, ResourceDiffer } from '@agentship/core';
import { isNeedsInput } from '@agentship/core';

/**
 * `apple/pricing` — the price of the app itself and where it is sold.
 *
 * This is the differ behind the promise "Set the price of the app — API (you approve)":
 * `setPricing` exists in the adapter and in the capability table, and without a differ
 * reading `manifest.pricing` it could never appear in a plan. The comparison follows the
 * two rules every differ lives by:
 *
 * - **Gaps are not absence.** When the snapshot lists `pricing` as a gap, the store's
 *   price is unknown, and nothing is drafted against an unknown. An absent `state.pricing`
 *   without a gap, by contrast, means the store reported nothing is scheduled — the normal
 *   state of a brand-new app — and the manifest's price is proposed against it.
 * - **Territory availability is only compared when it was read.** The Apple backend does
 *   not currently read the territory list back, so a declared availability travels with a
 *   price change (as part of the same schedule) rather than generating a change of its own
 *   against a value nobody has seen.
 *
 * `setPricing` is in the kernel's sensitive set, so the action is always `needs_approval`:
 * a price is money the user's customers pay.
 */
export function applePricingDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'pricing',
    plan(input: DifferInput): readonly ActionDraft[] {
      const pricing = input.manifest.pricing;
      if (pricing === undefined) return [];
      if (input.state.gaps.some((gap) => gap.area === 'pricing')) return [];

      const needsInput: string[] = [];
      if (isNeedsInput(pricing.amount)) needsInput.push('pricing.amount');
      if (isNeedsInput(pricing.baseTerritory)) needsInput.push('pricing.baseTerritory');
      for (const [index, territory] of (pricing.availability?.territories ?? []).entries()) {
        if (isNeedsInput(territory)) needsInput.push(`pricing.availability.territories[${index}]`);
      }

      // A declared pricing section with sentinels is a decision half-made: surface exactly
      // the missing paths instead of comparing around them.
      if (needsInput.length > 0) {
        return [
          {
            kind: 'set_pricing',
            target: 'app-pricing',
            operation: 'setPricing',
            summary: 'The app pricing section still needs values before it can be planned',
            diff: needsInput.map((path) => ({ path, after: '<needs_input>' })),
            needsInput,
          },
        ];
      }

      const remote = input.state.pricing;
      const diff: DiffEntry[] = [];

      if (pricing.free === true) {
        if (remote?.free !== true) {
          diff.push({
            path: 'pricing.free',
            ...(remote?.free === undefined ? {} : { before: remote.free }),
            ...(remote?.amount === undefined ? {} : { note: `currently ${remote.amount}` }),
            after: true,
          });
        }
      } else if (pricing.amount !== undefined && !isNeedsInput(pricing.amount)) {
        if (!samePrice(pricing.amount, remote?.amount)) {
          diff.push({
            path: 'pricing.amount',
            ...(remote?.amount === undefined ? {} : { before: remote.amount }),
            after: pricing.amount,
            ...(pricing.baseTerritory === undefined || isNeedsInput(pricing.baseTerritory)
              ? {}
              : { note: `base territory ${pricing.baseTerritory}` }),
          });
        }
      }

      // Availability only produces a change of its own when the store reported the current
      // territories; otherwise it rides along with a price change below.
      const territories = pricing.availability?.territories?.filter(
        (territory) => !isNeedsInput(territory),
      );
      if (
        territories !== undefined &&
        remote?.territories !== undefined &&
        !sameSet(territories, remote.territories)
      ) {
        diff.push({
          path: 'pricing.availability.territories',
          before: [...remote.territories].sort().join(', '),
          after: [...territories].sort().join(', '),
        });
      }

      if (diff.length === 0) return [];

      const availability =
        pricing.availability === undefined
          ? undefined
          : {
              ...(pricing.availability.allTerritories === undefined
                ? {}
                : { allTerritories: pricing.availability.allTerritories }),
              ...(territories === undefined || territories.length === 0 ? {} : { territories }),
            };

      return [
        {
          kind: 'set_pricing',
          target: 'app-pricing',
          operation: 'setPricing',
          summary:
            pricing.free === true
              ? 'Make the app free on the App Store'
              : `Set the app price to ${pricing.amount}${pricing.baseTerritory === undefined ? '' : ` (${pricing.baseTerritory})`}`,
          diff,
          op: {
            op: 'set_pricing',
            schedule: {
              ...(pricing.free === undefined ? {} : { free: pricing.free }),
              ...(pricing.amount === undefined || pricing.free === true
                ? {}
                : { amount: pricing.amount }),
              ...(pricing.baseTerritory === undefined
                ? {}
                : { baseTerritory: pricing.baseTerritory }),
              ...(availability === undefined || Object.keys(availability).length === 0
                ? {}
                : { availability }),
            },
          },
          riskNotes: [
            'This changes what customers pay for the app itself, effective as soon as Apple processes the schedule.',
            ...(remote === undefined
              ? [
                  'The store reported no current price schedule, so there is nothing to roll back to; check the number twice.',
                ]
              : []),
          ],
        },
      ];
    },
  };
}

/** Numeric equality when both sides parse, string equality otherwise. */
function samePrice(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  const left = Number.parseFloat(a);
  const right = Number.parseFloat(b);
  if (Number.isFinite(left) && Number.isFinite(right)) return left === right;
  return a === b;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}
