import { pendingOf, renderPending } from '@agentship/catalog';
import type { CapabilityMap, PendingOperation } from '@agentship/core';

/**
 * What Agentship can do on Google Play, and how.
 *
 * Google's Play Developer API is narrower than Apple's in a specific way: it manages the
 * *contents* of an app that already exists and has already shipped once, and nothing about
 * the app's commercial or regulatory setup. Creating the app, the first release, the
 * content rating, the price, the countries and the App content declarations are all console
 * work, permanently.
 *
 * `listApps` is the surprise in this table. Google publishes no endpoint that enumerates a
 * developer account's apps — `gpc apps list` reads a local config file, not the API — so
 * Agentship cannot discover an app it was not told about. Reporting that as `unsupported` is
 * the honest answer; the alternative would be an empty list that reads like "you have no
 * apps".
 */
export const GOOGLE_CAPABILITIES: CapabilityMap = {
  // --- readable through the API --------------------------------------------------
  checkAuth: 'auto',
  /** No API enumerates a developer's apps; the package name must be supplied. */
  listApps: 'unsupported',
  getAppState: 'auto',
  listProducts: 'auto',
  getProductState: 'auto',
  /** Play exposes no review-status endpoint; see `reviewStatus` below. */
  getSubmissionStatus: 'auto',

  // --- work Agentship performs on this machine ---------------------------------------
  /** Gradle (or Flutter) builds and signs the bundle locally, with the upload key. */
  buildArtifact: 'auto',

  // --- writes Agentship performs ----------------------------------------------------
  /** No version resource exists: a Play release carries its own name. */
  ensureVersion: 'unsupported',
  setMetadata: 'needs_approval',
  syncScreenshots: 'needs_approval',
  uploadBuild: 'auto',
  distributeToTesters: 'needs_approval',
  manageTesterGroups: 'auto',
  submitForReview: 'needs_approval',
  setPhasedRelease: 'needs_approval',

  // --- monetisation, through the Play Developer API ---------------------------------
  /**
   * `gpc iap create` (one-time products) and `gpc subscriptions create` (subscriptions with
   * base plans and offers). Both take a JSON document, which is what Agentship writes from the
   * neutral product declaration.
   */
  createProduct: 'needs_approval',
  updateProduct: 'needs_approval',
  /**
   * Prices live inside the product document on Play, so pricing is an update of the same
   * resource. `gpc pricing convert` supplies the regional proposals Agentship shows first.
   */
  setProductPricing: 'needs_approval',
  /** `gpc subscriptions offers` / `gpc otp offers`. */
  setProductOffers: 'needs_approval',
  /**
   * Data Safety has a real API (`applications.dataSafety`), reached through
   * `gpc data-safety update` with the console's own CSV format.
   */
  dataSafety: 'needs_approval',

  // --- no API -----------------------------------------------------------------------
  /** Creating the app is console-only. */
  createApp: 'agent_browser',
  /** The first release of a new app must be made in Play Console. */
  firstRelease: 'agent_browser',
  /** IARC questionnaire: a declaration, with no API. */
  contentRating: 'agent_browser',
  /** App price and paid/free status: console-only. */
  setPricing: 'agent_browser',
  appPricing: 'agent_browser',
  /** Country availability for the app as a whole: console-only. */
  appAvailability: 'agent_browser',
  /** App content declarations (ads, target audience, news, COVID…): console-only. */
  appContentDeclarations: 'agent_browser',
  /** Play App Signing enrolment: console-only, and irreversible. */
  playAppSigning: 'agent_browser',
  /**
   * With managed publishing on, a committed change waits for a human to press "Publish" in
   * Play Console; the API has no equivalent, by design.
   */
  releaseVersion: 'agent_browser',
  /** Developer account, payments profile, tax and identity verification. */
  agreementsTaxBanking: 'human_only',
  /**
   * Google exposes no review status. The only signal is indirect — an attempted commit
   * failing with "changes already in review" — and Agentship will not provoke a write to
   * read a status.
   */
  reviewStatus: 'unsupported',

  // --- Apple-only concepts ------------------------------------------------------------
  privacyLabels: 'unsupported',
  resolutionCenter: 'unsupported',
};

/**
 * What Google can never automate, independent of any particular app.
 *
 * Rendered from the console catalog (`@agentship/catalog`), like Apple's: the steps, the
 * fields and the cautions are versioned data with a `lastVerified` date. This list is the
 * subset worth knowing before a plan runs — an unverified developer account or a missing
 * first release stops everything, and finding that out at upload time is too late.
 */
const KNOWN_GOOGLE_ENTRIES: readonly string[] = [
  'google:account-and-payments',
  'google:closed-testing-requirement',
  'google:create-app',
  'google:first-release',
  'google:content-rating',
  'google:app-content',
  'google:pricing-and-countries',
];

export const GOOGLE_PENDING_OPERATIONS: readonly PendingOperation[] = KNOWN_GOOGLE_ENTRIES.map(
  (id) => pendingOf(renderPending(id)),
);
