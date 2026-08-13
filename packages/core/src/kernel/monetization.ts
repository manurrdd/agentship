import { z } from 'zod';

/**
 * The neutral monetisation model: what the app sells, in one declaration for both stores.
 *
 * The two platforms are not isomorphic and pretending otherwise would be the whole bug.
 * Apple models a subscription as a *level* inside a *group* — customers move up and down
 * within a group, and a product's rank in it is what "upgrade" means. Google models a
 * subscription as a product containing *base plans*, each with its own billing period and
 * its own *offers*. There is no faithful translation between "level in a group" and "base
 * plan", so the manifest keeps a logical product with an explicit projection per store and
 * refuses to invent either half.
 *
 * Everything else follows from two decisions:
 *
 * - **A logical id, stable forever.** `id` is Agentship's handle on the product; the store
 *   product ids live under `apple`/`google` and may differ. Renaming a store product id is
 *   therefore a visible diff rather than a silently-created duplicate.
 * - **Nothing is deleted implicitly.** A product that exists remotely and is absent here is
 *   reported as drift, never removed. Deletion requires `state: absent`, which the differs
 *   classify as needing input, because a deleted product breaks every customer who owns it.
 */
export const PRODUCT_TYPES = [
  'subscription',
  'consumable',
  'non_consumable',
  'non_renewing',
] as const;

/** Billing periods both stores express, in the neutral spelling. */
export const BILLING_PERIODS = [
  'one_week',
  'one_month',
  'two_months',
  'three_months',
  'six_months',
  'one_year',
] as const;

const NonEmpty = z.string().min(1);

/** Price templates, e.g. `4.99`. Kept as a string so no float ever rounds a price. */
const Money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'a price looks like 4.99');

const ProductLocaleSchema = z
  .object({
    displayName: NonEmpty,
    description: NonEmpty.optional(),
  })
  .strict();

/**
 * An introductory or promotional offer.
 *
 * The common subset is what both stores really share: a mode, a duration and how many times
 * it repeats. Anything only one store has stays under its own key rather than being faked
 * on the other.
 */
const OfferSchema = z
  .object({
    id: NonEmpty,
    kind: z.enum(['introductory', 'promotional', 'offer_code', 'win_back']),
    mode: z.enum(['free_trial', 'pay_as_you_go', 'pay_up_front']),
    /** Ignored for `free_trial`. */
    price: Money.optional(),
    duration: z.enum(BILLING_PERIODS),
    /** How many billing periods the offer lasts. */
    periods: z.number().int().positive().default(1),
    /** Territories the offer applies to; every available territory when omitted. */
    territories: z.array(NonEmpty).optional(),
    google: z
      .object({
        /** Play offer id inside the base plan; defaults to the logical offer id. */
        offerId: NonEmpty.optional(),
        /** Eligibility tag Play matches against, when the offer is targeted. */
        tag: NonEmpty.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const PriceSchema = z
  .object({
    /** Customer price in the base territory, e.g. `4.99`. */
    base: Money,
    /** Territory the base price is quoted in. Defaults to the United States. */
    baseTerritory: NonEmpty.default('US'),
    currency: NonEmpty.optional(),
    /**
     * `convert` asks the store for its own regional equivalents and shows them in the diff
     * before anything is set; `manual` uses only what `territories` lists. Neither sets a
     * price without an approval — the strategy decides what is proposed, never whether the
     * user is asked.
     *
     * Omit it and the manifest decides: listing `territories` *is* the statement that these
     * prices were chosen, so nothing else is proposed; listing none leaves conversion as the
     * only way to reach more than one country. It used to default to `convert` outright,
     * which meant a user who had decided 175 prices by hand also got the store's automatic
     * table for everything they had not listed — the opposite of what writing them down
     * means, and reported as "the automatic prices came out, you did not apply mine".
     */
    strategy: z.enum(['convert', 'manual']).optional(),
    /** Explicit per-territory prices, which always win over a conversion. */
    territories: z.record(NonEmpty, Money).optional(),
    /**
     * What to do with a price that is not one of the shapes stores and customers expect.
     *
     * `exact` (the default) sends the number as written and says in the plan when it looks
     * unusual — `1.82` where every comparable app charges `1.99`, or an amount App Store
     * Connect has no price point for and will simply reject. `pretty` adopts the nearest
     * conventional price instead, and shows the change in the diff before anything is set.
     *
     * Never silent either way: rounding someone's price is a decision about their revenue.
     */
    rounding: z.enum(['exact', 'pretty']).optional(),
  })
  .strict();

export const MonetizationProductSchema = z
  .object({
    /** Stable logical id. Never sent to a store; it is how Agentship recognises the product. */
    id: NonEmpty,
    type: z.enum(PRODUCT_TYPES),
    /** `absent` asks for removal, which is always a decision the user makes explicitly. */
    state: z.enum(['present', 'absent']).default('present'),
    apple: z
      .object({
        productId: NonEmpty,
        /** Subscription group reference name; required for `subscription`. */
        group: NonEmpty.optional(),
        /** Rank inside the group: 1 is the most valuable tier. */
        level: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    google: z
      .object({
        productId: NonEmpty,
        /** Base plan id; required for `subscription`. */
        basePlan: NonEmpty.optional(),
      })
      .strict()
      .optional(),
    /** Only for subscriptions. */
    period: z.enum(BILLING_PERIODS).optional(),
    familySharable: z.boolean().optional(),
    names: z.record(NonEmpty, ProductLocaleSchema),
    price: PriceSchema,
    offers: z.array(OfferSchema).default([]),
  })
  .strict()
  .refine((product) => product.type !== 'subscription' || product.period !== undefined, {
    message: 'A subscription must declare a billing period.',
    path: ['period'],
  })
  .refine((product) => product.apple !== undefined || product.google !== undefined, {
    message: 'A product must project onto at least one store.',
  })
  .refine(
    (product) =>
      product.type !== 'subscription' ||
      product.apple === undefined ||
      product.apple.group !== undefined,
    { message: 'An Apple subscription belongs to a subscription group.', path: ['apple', 'group'] },
  )
  .refine(
    (product) =>
      product.type !== 'subscription' ||
      product.google === undefined ||
      product.google.basePlan !== undefined,
    { message: 'A Google subscription needs a base plan id.', path: ['google', 'basePlan'] },
  );

export const MonetizationSchema = z
  .object({
    products: z.array(MonetizationProductSchema).default([]),
    /**
     * How far a price change may move before Agentship treats it as suspicious. A change
     * outside `[1/factor, factor]` still gets an approval like any other, but the diff
     * carries an extra warning, because a decimal point in the wrong place looks exactly
     * like a normal price otherwise.
     */
    priceSanityFactor: z.number().gt(1).default(10),
  })
  .strict();

export type MonetizationProduct = z.infer<typeof MonetizationProductSchema>;
/**
 * Whether a price change is large enough to deserve a second look.
 *
 * Pure arithmetic on strings, so it is exact and testable: a price moving by more than the
 * factor in either direction is almost always a typo, and the one time it is not, an extra
 * line in the diff costs nothing.
 */
export function priceLooksSuspicious(before: string, after: string, factor: number): boolean {
  const from = Number.parseFloat(before);
  const to = Number.parseFloat(after);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return false;
  const ratio = to / from;
  return ratio >= factor || ratio <= 1 / factor;
}
