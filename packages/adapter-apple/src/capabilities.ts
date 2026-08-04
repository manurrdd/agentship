import { pendingOf, renderPending } from '@agentship/catalog';
import type { CapabilityMap, PendingOperation } from '@agentship/core';

/**
 * What Agentship can do on App Store Connect, and how.
 *
 * The classification is not a summary of `asc`: it is a summary of Apple. Where `asc`
 * offers a path Agentship refuses to take — its `web` subcommands drive an unofficial Apple
 * ID web session, with the user's password and 2FA — the operation is classified by what
 * Apple's *public API* supports, and the rest becomes an instruction for an agent browser
 * or for a human.
 *
 * `asc capabilities --output json` on 3.4.1 independently reports app creation, App
 * Privacy data-use declarations and reviewer rejection details as web-session only; those
 * are exactly the three entries below that are not `auto`.
 */
export const APPLE_CAPABILITIES: CapabilityMap = {
  // --- readable through the public API -----------------------------------------
  checkAuth: 'auto',
  listApps: 'auto',
  getAppState: 'auto',
  listProducts: 'auto',
  getProductState: 'auto',
  getSubmissionStatus: 'auto',

  // --- work Agentship performs on this machine ------------------------------------
  /** Xcode archives and signs locally; the store is not involved until the upload. */
  buildArtifact: 'auto',

  // --- writes Agentship performs --------------------------------------------------
  /** Creating the editable version is reversible and invisible to users. */
  ensureVersion: 'auto',
  setMetadata: 'needs_approval',
  syncScreenshots: 'needs_approval',
  uploadBuild: 'auto',
  distributeToTesters: 'needs_approval',
  manageTesterGroups: 'auto',
  // Money is never changed without the user seeing the exact schedule first.
  setPricing: 'needs_approval',
  submitForReview: 'needs_approval',
  setPhasedRelease: 'needs_approval',

  // --- monetisation, all through the public API ---------------------------------
  /**
   * `asc iap create/setup` and `asc subscriptions create/setup` cover the whole model:
   * consumables, non-consumables, non-renewing subscriptions, subscription groups and
   * auto-renewable subscriptions with a period.
   */
  createProduct: 'needs_approval',
  updateProduct: 'needs_approval',
  /** `asc iap pricing schedules create` and `asc subscriptions pricing prices set`. */
  setProductPricing: 'needs_approval',
  /** `asc iap offer-codes` and `asc subscriptions offers`. */
  setProductOffers: 'needs_approval',

  // --- no public API ------------------------------------------------------------
  /** Creating the app record is only possible in the console; an agent browser may do it. */
  createApp: 'agent_browser',
  /** App Privacy answers are not in the public API and are a legal declaration by the user. */
  privacyLabels: 'agent_browser',
  /** Reviewer messages and rejection detail are richer in the console than in the API. */
  resolutionCenter: 'agent_browser',
  /**
   * Releasing an approved version that was held for manual release goes through
   * `appStoreVersionReleaseRequests`, which `asc` does not expose. Agentship refuses to guess
   * a command, so the console button is the honest answer.
   */
  releaseVersion: 'agent_browser',
  /**
   * Age rating *is* in the API (`ageRatingDeclarations`, reached through `asc age-rating
   * edit`), but the answers are the developer's declaration about their own app, so the
   * policy keeps it at `needs_approval` and the questionnaire is proposed, never answered.
   */
  contentRating: 'needs_approval',
  appPricing: 'needs_approval',
  appAvailability: 'needs_approval',
  /** Contracts, banking, tax and identity: legal acts by the Account Holder. */
  agreementsTaxBanking: 'human_only',

  // --- Google-only concepts -----------------------------------------------------
  firstRelease: 'unsupported',
  dataSafety: 'unsupported',
  appContentDeclarations: 'unsupported',
  playAppSigning: 'unsupported',
  reviewStatus: 'unsupported',
};

/**
 * What Apple can never automate, independent of any particular app.
 *
 * Rendered from the console catalog (`@agentship/catalog`) rather than written here: the
 * instructions, the fields and the cautions are data with a `lastVerified` date, and this
 * list is only the subset an agent should learn about *before* a plan runs — while there is
 * still time to act on a blocker, instead of at the moment a publish fails.
 *
 * No project context is available at this point, so nothing is interpolated: the operations
 * carry their structure and their labels, and the values arrive when a differ or
 * `agentship_pending` renders the same entries against a manifest.
 */
const KNOWN_APPLE_ENTRIES: readonly string[] = [
  'apple:developer-enrollment',
  'apple:agreements-tax-banking',
  'apple:api-key',
  'apple:create-app-record',
  'apple:app-privacy',
];

export const APPLE_PENDING_OPERATIONS: readonly PendingOperation[] = KNOWN_APPLE_ENTRIES.map((id) =>
  pendingOf(renderPending(id)),
);
