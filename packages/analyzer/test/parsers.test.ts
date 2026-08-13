import { describe, expect, it } from 'vitest';
import {
  blockChildNames,
  entitlementKeys,
  extractBlock,
  gradleDependencies,
  gradleNumber,
  gradleValue,
  parsePlist,
  parseYaml,
  pbxprojApplicationSettings,
  pbxprojConfigurations,
  pbxprojSettings,
  stripComments,
  xmlElements,
} from '../src/parsers.js';

describe('stripComments', () => {
  it('removes line, hash and block comments', () => {
    const source = `a // one\nb # two\nc /* three\nstill */ d`;
    const stripped = stripComments(source);
    expect(stripped).not.toContain('one');
    expect(stripped).not.toContain('two');
    expect(stripped).not.toContain('three');
    expect(stripped).toContain('d');
  });

  it('leaves comment markers that appear inside strings', () => {
    expect(stripComments('url = "https://example.test/path"')).toContain('https://example.test');
    expect(stripComments("id = 'a#b'")).toContain('a#b');
  });

  it('is what stops a commented-out value from being extracted', () => {
    const gradle = `defaultConfig {\n  // applicationId "com.attacker.spoofed"\n  applicationId "com.real.app"\n}`;
    expect(gradleValue(stripComments(gradle), 'applicationId')).toBe('com.real.app');
  });
});

describe('extractBlock', () => {
  it('returns the body of a named block, matching nested braces', () => {
    const body = extractBlock('android {\n a { b }\n c = 1\n}\nother { x }', 'android');
    expect(body).toContain('a { b }');
    expect(body).toContain('c = 1');
    expect(body).not.toContain('other');
  });

  it('returns undefined for a missing or unbalanced block', () => {
    expect(extractBlock('android { }', 'buildTypes')).toBeUndefined();
    expect(extractBlock('android {', 'android')).toBeUndefined();
  });
});

describe('blockChildNames', () => {
  it('reads Groovy-style declarations', () => {
    expect(blockChildNames('free {\n dimension "tier"\n}\npro {\n}').sort()).toEqual([
      'free',
      'pro',
    ]);
  });

  it('reads Kotlin DSL create/register declarations', () => {
    expect(
      blockChildNames('create("free") {\n}\nregister("pro") {\n}\ngetByName("debug") {\n}').sort(),
    ).toEqual(['debug', 'free', 'pro']);
  });
});

describe('gradleValue', () => {
  it('reads both DSL spellings', () => {
    expect(gradleValue('applicationId "com.a"', 'applicationId')).toBe('com.a');
    expect(gradleValue('applicationId = "com.b"', 'applicationId')).toBe('com.b');
    expect(gradleValue("versionName 'a.b'", 'versionName')).toBe('a.b');
    expect(gradleNumber('versionCode = 42', 'versionCode')).toBe(42);
  });

  it('returns undefined for a value that is not literal', () => {
    // Evaluating these would mean running the build script, which the analyzer never does.
    expect(gradleValue('applicationId project.property("id")', 'applicationId')).toBeUndefined();
    expect(
      gradleNumber('versionCode flutterVersionCode.toInteger()', 'versionCode'),
    ).toBeUndefined();
    expect(gradleValue('implementation libs.versions.foo', 'applicationId')).toBeUndefined();
  });

  it('does not match a different key with the same prefix', () => {
    expect(gradleValue('targetSdkVersion 34', 'targetSdk')).toBeUndefined();
    expect(gradleNumber('targetSdkVersion 34', 'targetSdkVersion')).toBe(34);
  });
});

describe('gradleDependencies', () => {
  it('extracts maven coordinates with and without a version', () => {
    const deps = gradleDependencies(`
      implementation "com.google.firebase:firebase-analytics"
      implementation("com.android.billingclient:billing:7.0.0")
    `);
    expect(deps.map((d) => d.coordinate)).toEqual([
      'com.google.firebase:firebase-analytics',
      'com.android.billingclient:billing',
    ]);
    expect(deps[1]?.version).toBe('7.0.0');
  });
});

describe('pbxproj extraction', () => {
  const pbxproj = `
/* Begin XCBuildConfiguration section */
    A /* Debug */ = {
      buildSettings = {
        PRODUCT_BUNDLE_IDENTIFIER = com.a.debug;
        MARKETING_VERSION = 1.2.3;
        PRODUCT_NAME = "$(TARGET_NAME)";
      };
      name = Debug;
    };
    B /* Release */ = {
      buildSettings = {
        PRODUCT_BUNDLE_IDENTIFIER = com.a;
      };
      name = Release;
    };
/* End XCBuildConfiguration section */
`;

  it('collects every distinct value of a setting, in file order', () => {
    const settings = pbxprojSettings(pbxproj);
    expect(settings.get('PRODUCT_BUNDLE_IDENTIFIER')).toEqual(['com.a.debug', 'com.a']);
    expect(settings.get('MARKETING_VERSION')).toEqual(['1.2.3']);
    expect(settings.get('PRODUCT_NAME')).toEqual(['$(TARGET_NAME)']);
  });

  it('lists build configuration names', () => {
    expect(pbxprojConfigurations(pbxproj).sort()).toEqual(['Debug', 'Release']);
  });

  it('reads only the application target when an extension appears first', () => {
    const project = `
/* Begin PBXNativeTarget section */
  WIDGET /* HabitWidget */ = { buildConfigurationList = WLIST; productType = "com.apple.product-type.app-extension"; };
  RUNNER /* Runner */ = { buildConfigurationList = ALIST; productType = "com.apple.product-type.application"; };
/* End PBXNativeTarget section */
/* Begin XCConfigurationList section */
  WLIST = { buildConfigurations = (WDEBUG /* Debug */,); };
  ALIST = { buildConfigurations = (ADEBUG /* Debug */, ARELEASE /* Release */,); };
/* End XCConfigurationList section */
/* Begin XCBuildConfiguration section */
  WDEBUG = {
    buildSettings = {
      PRODUCT_BUNDLE_IDENTIFIER = com.example.app.Widget;
    };
    name = Debug;
  };
  ADEBUG = {
    buildSettings = {
      PRODUCT_BUNDLE_IDENTIFIER = com.example.app;
      MARKETING_VERSION = 2.0;
    };
    name = Debug;
  };
  ARELEASE = {
    buildSettings = {
      PRODUCT_BUNDLE_IDENTIFIER = com.example.app;
      MARKETING_VERSION = 2.0;
    };
    name = Release;
  };
/* End XCBuildConfiguration section */`;
    const settings = pbxprojApplicationSettings(project);
    expect(settings.get('PRODUCT_BUNDLE_IDENTIFIER')).toEqual(['com.example.app']);
    expect(settings.get('MARKETING_VERSION')).toEqual(['2.0']);
  });
});

describe('xmlElements', () => {
  it('extracts attributes of repeated elements', () => {
    const manifest = `<manifest package="com.a">
      <uses-permission android:name="android.permission.CAMERA"/>
      <uses-permission android:name="android.permission.INTERNET" android:maxSdkVersion="30"/>
    </manifest>`;
    const permissions = xmlElements(manifest, 'uses-permission');
    expect(permissions).toHaveLength(2);
    expect(permissions[1]?.attributes['android:maxSdkVersion']).toBe('30');
    expect(xmlElements(manifest, 'manifest')[0]?.attributes['package']).toBe('com.a');
  });

  it('degrades gracefully on malformed XML', () => {
    expect(() => xmlElements('<manifest <uses-permission', 'uses-permission')).not.toThrow();
  });
});

describe('parsePlist', () => {
  it('parses a well-formed plist', () => {
    const parsed = parsePlist(
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>A</key><string>b</string></dict></plist>`,
    );
    expect(parsed).toEqual({ A: 'b' });
  });

  it('returns undefined for malformed XML, without writing to the console', () => {
    expect(parsePlist('<plist><dict><key>A</key>')).toBeUndefined();
  });

  it('returns undefined for a binary plist', () => {
    expect(parsePlist('bplist00\u0000\u0000')).toBeUndefined();
  });
});

describe('entitlementKeys', () => {
  it('lists keys with their scalar values', () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
      <key>aps-environment</key><string>production</string>
      <key>com.apple.developer.applesignin</key><array><string>Default</string></array>
    </dict></plist>`;
    expect(entitlementKeys(source)).toEqual([
      { key: 'aps-environment', value: 'production' },
      { key: 'com.apple.developer.applesignin' },
    ]);
  });
});

describe('parseYaml', () => {
  it('salvages what it can from a document with syntax errors', () => {
    // A pubspec with one bad line should still yield the app's name and version.
    expect(parseYaml('name: app\nversion: 1.0.0\ndeps: [a, b')).toMatchObject({
      name: 'app',
      version: '1.0.0',
    });
  });

  it('returns undefined instead of throwing on input it cannot recover', () => {
    expect(parseYaml('*undefined-anchor')).toBeUndefined();
  });

  it('parses valid YAML', () => {
    expect(parseYaml('name: app\nversion: 1.0.0+2')).toEqual({ name: 'app', version: '1.0.0+2' });
  });
});
