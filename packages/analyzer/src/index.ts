export { type AnalyzeOptions, analyzeApp } from './analyze.js';
export { collectAssets } from './assets.js';
export {
  type Ecosystem,
  loadAndroidRequirements,
  loadSdkCatalog,
  requiredTargetSdk,
  type SdkCatalogEntry,
  sdkCatalogLastVerified,
  type TargetSdkRequirement,
} from './catalog.js';
export { type DetectionOutcome, detectFramework } from './detect.js';
export { type AndroidExtraction, extractAndroid } from './extract-android.js';
export { extractIos, type IosExtraction } from './extract-ios.js';
export { extractProject, type ProjectExtraction } from './extract-project.js';
export { derivePrivacySignals } from './privacy.js';
export {
  DEFAULT_LIMITS,
  IGNORED_DIRECTORIES,
  RepoFs,
  type ScanLimits,
  type SkippedEntry,
} from './repo-fs.js';
export { catalogEntriesFor, type DependencySource, detectSdks } from './sdks.js';
