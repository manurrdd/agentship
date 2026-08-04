import type {
  AndroidPermission,
  DetectedSdk,
  Evidence,
  IosPermission,
  PrivacyDataType,
  PrivacySignal,
} from '@agentship/core';
import { catalogEntriesFor } from './sdks.js';

/**
 * Privacy signals: evidence, not declarations.
 *
 * Both stores make the developer legally responsible for the privacy answers, and neither
 * accepts "a tool decided". So Agentship's job stops at proposing: here is a data type, here
 * is the SDK or permission that suggests it, here is the file it was found in. The user
 * confirms, and only then does anything reach a store.
 *
 * Permission-derived signals are `certain` — the permission is declared in the project, so
 * the capability is really there. SDK-derived signals are `inferred` — a dependency being
 * present does not prove the feature is used.
 */

const IOS_PERMISSION_DATA: readonly {
  pattern: RegExp;
  dataType: PrivacyDataType;
  reason: string;
}[] = [
  {
    pattern: /^NSLocation/,
    dataType: 'location',
    reason: 'the app declares a location purpose string',
  },
  {
    pattern: /^NSContactsUsageDescription$/,
    dataType: 'contacts',
    reason: 'the app declares access to the address book',
  },
  {
    pattern: /^NS(Camera|PhotoLibrary|PhotoLibraryAdd|Microphone)UsageDescription$/,
    dataType: 'user_content',
    reason: 'the app declares access to camera, photos or microphone',
  },
  {
    pattern: /^NSHealth/,
    dataType: 'health',
    reason: 'the app declares access to HealthKit data',
  },
  {
    pattern: /^NSUserTrackingUsageDescription$/,
    dataType: 'identifiers',
    reason: 'the app asks for App Tracking Transparency permission',
  },
  {
    pattern: /^NS(Calendars|Reminders)/,
    dataType: 'user_content',
    reason: 'the app declares access to calendars or reminders',
  },
  {
    pattern: /^NS(Motion|Bluetooth)/,
    dataType: 'diagnostics',
    reason: 'the app declares access to motion or Bluetooth data',
  },
];

const ANDROID_PERMISSION_DATA: readonly {
  pattern: RegExp;
  dataType: PrivacyDataType;
  reason: string;
}[] = [
  {
    pattern: /ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION$/,
    dataType: 'location',
    reason: 'the manifest requests location permission',
  },
  {
    pattern: /(READ|WRITE)_CONTACTS$/,
    dataType: 'contacts',
    reason: 'the manifest requests contacts permission',
  },
  {
    pattern: /(CAMERA|RECORD_AUDIO|READ_MEDIA_[A-Z]+|READ_EXTERNAL_STORAGE)$/,
    dataType: 'user_content',
    reason: 'the manifest requests access to media or the camera',
  },
  {
    pattern: /(BODY_SENSORS|ACTIVITY_RECOGNITION)$/,
    dataType: 'health',
    reason: 'the manifest requests sensor or activity data',
  },
  {
    pattern: /AD_ID$/,
    dataType: 'identifiers',
    reason: 'the manifest declares use of the advertising identifier',
  },
  {
    pattern: /(READ_PHONE_STATE|READ_PHONE_NUMBERS)$/,
    dataType: 'identifiers',
    reason: 'the manifest requests device or phone identifiers',
  },
];

interface Accumulated {
  reasons: Set<string>;
  sdkIds: Set<string>;
  evidence: Evidence[];
  certain: boolean;
}

export function derivePrivacySignals(
  sdks: readonly DetectedSdk[],
  iosPermissions: readonly IosPermission[],
  androidPermissions: readonly AndroidPermission[],
): PrivacySignal[] {
  const byType = new Map<PrivacyDataType, Accumulated>();

  const add = (
    dataType: PrivacyDataType,
    reason: string,
    evidence: Evidence,
    certain: boolean,
    sdkId?: string,
  ): void => {
    const entry = byType.get(dataType) ?? {
      reasons: new Set<string>(),
      sdkIds: new Set<string>(),
      evidence: [],
      certain: false,
    };
    entry.reasons.add(reason);
    if (sdkId !== undefined) entry.sdkIds.add(sdkId);
    entry.evidence.push(evidence);
    entry.certain = entry.certain || certain;
    byType.set(dataType, entry);
  };

  for (const entry of catalogEntriesFor(sdks.map((sdk) => sdk.id))) {
    const detected = sdks.find((sdk) => sdk.id === entry.id);
    const evidence = detected?.evidence[0] ?? { file: 'sdk-catalog.json', note: entry.id };
    for (const dataType of entry.privacy) {
      add(dataType, `${entry.name} typically collects this data`, evidence, false, entry.id);
    }
  }

  for (const permission of iosPermissions) {
    for (const rule of IOS_PERMISSION_DATA) {
      if (rule.pattern.test(permission.key)) {
        add(rule.dataType, rule.reason, { file: permission.source, note: permission.key }, true);
      }
    }
  }

  for (const permission of androidPermissions) {
    for (const rule of ANDROID_PERMISSION_DATA) {
      if (rule.pattern.test(permission.name)) {
        add(rule.dataType, rule.reason, { file: permission.source, note: permission.name }, true);
      }
    }
  }

  return [...byType.entries()]
    .map(([dataType, entry]) => ({
      dataType,
      reason: [...entry.reasons].join('; '),
      sdkIds: [...entry.sdkIds].sort(),
      confidence: entry.certain ? ('certain' as const) : ('inferred' as const),
      evidence: entry.evidence,
    }))
    .sort((a, b) => a.dataType.localeCompare(b.dataType));
}
