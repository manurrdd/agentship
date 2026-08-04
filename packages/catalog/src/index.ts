/**
 * `@agentship/catalog` — the store knowledge Agentship keeps as data rather than as code.
 *
 * Two things live here, for the same reason: both change on the stores' schedule, not on
 * Agentship's, and both are safety-relevant enough that a change should be a reviewed diff
 * with a date on it.
 *
 * - **The console catalog.** Every operation neither store exposes through an API, written
 *   as instructions, fields, cautions and a verification. See `schema.ts` for the shape and
 *   `interpolate.ts` for the rule that keeps untrusted project data out of instruction text.
 * - **The privacy taxonomies.** Apple's App Privacy and Google's Data Safety vocabularies,
 *   and the CSV format Play's API takes, so the neutral declaration in the manifest can be
 *   projected onto either without a translation table hiding inside a function.
 */
export { type CatalogContextInput, CONTEXT_ROOTS, catalogContext } from './context.js';
export {
  ALLOWED_ROOTS,
  type CatalogContext,
  type ContextValue,
  checkPath,
  type Resolved,
  renderInstruction,
  resolveTemplate,
} from './interpolate.js';
export {
  type CatalogEntryWithStore,
  catalogEntries,
  catalogEntry,
  findCatalogEntry,
  loadCatalog,
} from './load.js';
export {
  type CsvValidation,
  type DataSafetyCsv,
  type DataSafetyFormat,
  dataSafetyFormat,
  generateDataSafetyCsv,
  parseCsv,
  validateDataSafetyCsv,
} from './privacy/csv.js';
export {
  type MappedDataType,
  type MappedPurpose,
  mapDataType,
  mapPurpose,
  type PrivacyMapping,
  privacyMapping,
} from './privacy/mapping.js';
export {
  type PrivacyProjection,
  type ProjectedPractice,
  projectionSummaryLine,
  projectPrivacy,
  summarizeProjection,
} from './privacy/projection.js';
export {
  pendingOf,
  type RenderedPending,
  type RenderOptions,
  renderCatalogPending,
  renderPending,
  renderStoreCatalog,
} from './render.js';
export {
  CATALOG_SCHEMA_VERSION,
  type CatalogEntry,
  CatalogEntrySchema,
  type CatalogField,
  CatalogFieldSchema,
  type CatalogFile,
  CatalogFileSchema,
  type CatalogStep,
  CatalogStepSchema,
  type CatalogVerify,
  CatalogVerifySchema,
} from './schema.js';
