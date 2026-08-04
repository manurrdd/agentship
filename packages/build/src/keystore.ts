import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AgentshipError,
  type AgentshipManifest,
  agentshipHome,
  ERROR_CODES,
  ensureDir,
  FILE_MODE,
  type Logger,
  type PendingOperation,
  type PendingVerifier,
  pathExists,
  registerSecret,
  tmpDir,
} from '@agentship/core';
import {
  getKeystoreSecret,
  type KeystoreSecret,
  requireKeystoreSecret,
  setKeystoreSecret,
} from '@agentship/credentials';
import { requireHostTool, runHostTool } from './host.js';

/**
 * The Android upload key.
 *
 * Android has no equivalent of Apple's "the store issues your certificate on demand": every
 * bundle must be signed locally, with a key the developer owns, before Play will look at
 * it. Agentship handles that in the order of least surprise:
 *
 * 1. **Use what the project already has.** A repository with `key.properties` or an
 *    explicit `signingConfig` is already signing its own release builds; Agentship injects
 *    nothing and lets Gradle do exactly what it did before.
 * 2. **Use what Agentship custodies.** A keystore under `~/.agentship/keystores/<package>/`
 *    with its password in the OS keyring, injected through a temporary properties file.
 * 3. **Offer to generate one.** Never silently: generating a key is a decision with lasting
 *    consequences, so it is an approval-gated action with the custody warning attached.
 *
 * The passwords never reach argv (`ps` is world-readable), never reach the environment of
 * the Gradle child (which runs the project's own build scripts), and never reach the
 * repository. They travel in a 0600 properties file inside `~/.agentship`, which is removed
 * in a `finally`.
 */
export type KeystoreOrigin = 'project' | 'agentship' | 'missing';

export interface KeystoreState {
  readonly origin: KeystoreOrigin;
  /** Absolute path of the keystore Agentship would use; absent when the project signs itself. */
  readonly path?: string;
  readonly alias?: string;
  /** True when the passwords are in the keyring and readable. */
  readonly secretStored: boolean;
  readonly detail: string;
}

/** Directory Agentship keeps generated keystores in, one per package name. */
export function keystoreDir(packageName: string): string {
  return join(agentshipHome(), 'keystores', packageName.replace(/[^A-Za-z0-9._-]/g, '_'));
}

export function keystorePath(packageName: string): string {
  return join(keystoreDir(packageName), 'upload.jks');
}

/** Files that tell Agentship the project already signs its own release builds. */
const PROJECT_SIGNING_FILES = ['android/key.properties', 'key.properties'];

/** Decides where this project's signing key comes from, without touching the keyring. */
export async function detectKeystore(
  appDir: string,
  packageName: string,
  manifest: AgentshipManifest,
): Promise<KeystoreState> {
  const configured = manifest.build?.android?.keystore;
  for (const relative of PROJECT_SIGNING_FILES) {
    if (await pathExists(join(appDir, relative))) {
      return {
        origin: 'project',
        secretStored: false,
        detail: `The project signs its own release builds (${relative}); Agentship injects nothing.`,
      };
    }
  }
  if (await hasInlineSigningConfig(appDir, manifest)) {
    return {
      origin: 'project',
      secretStored: false,
      detail:
        'The Gradle module declares a release signingConfig of its own; Agentship injects nothing.',
    };
  }

  const path = configured?.path ?? keystorePath(packageName);
  const alias = configured?.alias ?? 'upload';
  const exists = await pathExists(path);
  const secret = await getKeystoreSecret({
    ...(configured?.credentialProfile === undefined
      ? {}
      : { profile: configured.credentialProfile }),
  }).catch(() => undefined);

  if (!exists) {
    return {
      origin: 'missing',
      path,
      alias,
      secretStored: secret !== undefined,
      detail: `No upload keystore was found at ${path}, and the project declares no signing configuration.`,
    };
  }
  return {
    origin: 'agentship',
    path,
    alias,
    secretStored: secret !== undefined,
    detail:
      secret === undefined
        ? `A keystore exists at ${path} but its password is not in the keyring.`
        : `Agentship signs with the upload keystore at ${path}.`,
  };
}

async function hasInlineSigningConfig(
  appDir: string,
  manifest: AgentshipManifest,
): Promise<boolean> {
  const module = manifest.build?.android?.module ?? 'app';
  for (const candidate of [
    join(appDir, 'android', module, 'build.gradle'),
    join(appDir, 'android', module, 'build.gradle.kts'),
    join(appDir, module, 'build.gradle'),
    join(appDir, module, 'build.gradle.kts'),
  ]) {
    const text = await readFile(candidate, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    // A `signingConfigs { release { … } }` block means the project owns its signing.
    if (/signingConfigs\s*\{[\s\S]{0,400}?release/.test(text)) return true;
  }
  return false;
}

/**
 * Verifiers for console work whose effect is on *this machine*, not in a store.
 *
 * The keystore check used to be registered as a function that always returned `false`,
 * because a store snapshot can never see a file on a laptop. Now that a verifier is also
 * handed the project, the check can be the real one: the app is signable when the project
 * signs itself, or when Agentship's keystore exists and its password opens it.
 */
export const BUILD_VERIFIERS: ReadonlyMap<string, PendingVerifier> = new Map<
  string,
  PendingVerifier
>([
  [
    'google:upload-keystore-ready',
    async (operation, _state, context) => {
      const packageName =
        operation.verification?.params?.['packageName'] ??
        context.manifest.stores.google?.packageName;
      if (packageName === undefined) return false;
      const appDir = join(context.repoRoot, context.manifest.build?.appDir ?? '.');
      const state = await detectKeystore(appDir, packageName, context.manifest);
      // A project that signs itself needs nothing from Agentship; anything else needs both the
      // file and a password that is actually stored.
      return state.origin === 'project' || (state.origin === 'agentship' && state.secretStored);
    },
  ],
]);

/** The pending operation that asks the user to decide about a missing key. */
export function keystorePendingOperation(
  packageName: string,
  path: string,
): Omit<PendingOperation, 'status'> {
  return {
    id: 'google:upload-keystore',
    store: 'google',
    category: 'credentials',
    title: 'Decide how this app is signed for upload',
    reason:
      'Google Play requires every bundle to be signed before upload, and the signing key belongs to the developer, not to Agentship. Nothing can create one on the user’s behalf without their decision.',
    actionClass: 'needs_input',
    steps: [
      `Let Agentship generate an upload keystore at ${path} (it will ask for approval and store the password in the OS keyring), or`,
      'point build.android.keystore.path at a keystore you already own, or',
      'add a release signingConfig to the Gradle module and let the project sign itself.',
    ],
    fields: [
      {
        name: 'decision',
        label: 'Signing key',
        required: true,
        options: ['generate', 'existing', 'project'],
        rationale:
          'Until the app is enrolled in Play App Signing, this key is the app’s identity: losing it means losing the ability to update the listing.',
      },
    ],
    verification: {
      summary: 'A keystore is available and its password opens it.',
      check: 'google:upload-keystore-ready',
      params: { packageName },
    },
  };
}

export interface GenerateKeystoreOptions {
  readonly packageName: string;
  readonly appName: string;
  readonly alias?: string;
  readonly profile?: string;
  readonly logger?: Logger;
  readonly cancelSignal?: AbortSignal;
}

export interface GeneratedKeystore {
  readonly path: string;
  readonly alias: string;
  /** Warning the user must be shown; custody of this file is now their responsibility. */
  readonly custodyNotice: string;
}

/**
 * Generates an upload keystore with `keytool` and stores its password in the keyring.
 *
 * The password is generated here rather than asked for: a human-chosen password buys
 * nothing when the keystore and the keyring live on the same machine, and asking for one
 * invites reuse of a password that matters elsewhere. It reaches `keytool` on stdin, never
 * in argv.
 */
export async function generateKeystore(
  options: GenerateKeystoreOptions,
): Promise<GeneratedKeystore> {
  const alias = options.alias ?? 'upload';
  const path = keystorePath(options.packageName);
  if (await pathExists(path)) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_SIGNING_FAILED,
      `A keystore already exists at ${path}; Agentship will not overwrite a signing key.`,
      {
        details: { path },
        remediation: {
          summary:
            'Use the existing keystore, or move it aside deliberately if you are certain it is not the key this app was published with.',
        },
      },
    );
  }

  // 30 base64url characters: far beyond what a local keystore needs, and never typed.
  const password = randomBytes(24).toString('base64url');
  registerSecret(password);
  const keytool = await requireHostTool({
    name: 'keytool',
    install: 'Install a JDK; keytool ships with it.',
  });
  await ensureDir(dirname(path));

  const result = await runHostTool(keytool, {
    args: [
      '-genkeypair',
      '-v',
      '-keystore',
      path,
      '-alias',
      alias,
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      // Play requires an upload key valid for at least 25 years past 22 October 2033.
      '-validity',
      '10950',
      '-dname',
      `CN=${options.appName.replace(/[,=]/g, ' ')}, OU=Upload, O=${options.packageName}, C=US`,
      // Both passwords come from stdin; `-storepass` on the command line is world-readable.
      '-storetype',
      'PKCS12',
    ],
    cwd: dirname(path),
    // keytool prompts for the store password twice, then the key password.
    env: {},
    timeoutMs: 120_000,
    toolName: 'keytool',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.cancelSignal === undefined ? {} : { cancelSignal: options.cancelSignal }),
    stdin: `${password}\n${password}\n`,
  });
  if (result.exitCode !== 0) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_SIGNING_FAILED,
      `keytool could not create the upload keystore: ${result.stderr.split('\n')[0] ?? 'unknown error'}`,
      { details: { path, exitCode: result.exitCode } },
    );
  }

  await setKeystoreSecret(
    { storePassword: password, keyPassword: password },
    { ...(options.profile === undefined ? {} : { profile: options.profile }) },
  );
  return {
    path,
    alias,
    custodyNotice:
      `Agentship created an upload keystore at ${path} and stored its password in the OS keyring. ` +
      'Back both up. Until this app is enrolled in Play App Signing, this key is the app’s identity: ' +
      'if it is lost, that listing can never be updated again.',
  };
}

/**
 * The Gradle init script that injects the signing configuration.
 *
 * Three constraints shape it. The password must not be in argv (`ps` is world-readable), so
 * it lives in a 0600 properties file next to this script. The user's Gradle files must not
 * be edited, so the configuration arrives through `--init-script`, which is Gradle's own
 * supported way to add configuration from outside a build. And a project that already signs
 * itself must be left alone, which is what the `signingConfig == null` guard is for: Agentship
 * fills a hole, it never replaces a decision the project already made.
 */
function signingInitScript(propertiesPath: string): string {
  return `// Generated by Agentship for one build. Never written into the repository.
def agentshipProps = new Properties()
new File(${JSON.stringify(propertiesPath)}).withInputStream { agentshipProps.load(it) }

gradle.beforeProject { project ->
  project.plugins.withId('com.android.application') {
    def android = project.extensions.getByName('android')
    if (android.signingConfigs.findByName('agentshipUpload') == null) {
      android.signingConfigs.create('agentshipUpload') { cfg ->
        cfg.storeFile = new File(agentshipProps.getProperty('agentshipStoreFile'))
        cfg.storePassword = agentshipProps.getProperty('agentshipStorePassword')
        cfg.keyAlias = agentshipProps.getProperty('agentshipKeyAlias')
        cfg.keyPassword = agentshipProps.getProperty('agentshipKeyPassword')
      }
    }
    android.buildTypes.configureEach { buildType ->
      // Only a build type with no signing configuration of its own is touched.
      if (buildType.name == 'release' && buildType.signingConfig == null) {
        buildType.signingConfig = android.signingConfigs.getByName('agentshipUpload')
      }
    }
  }
}
`;
}

export interface SigningInjection {
  /** Path to pass to `gradlew --init-script`. */
  readonly initScript: string;
  readonly propertiesPath: string;
}

/**
 * Materialises the signing injection for the duration of one build, then removes it.
 *
 * Both files live under `AGENTSHIP_HOME` (0700) with mode 0600 and are deleted in a `finally`,
 * so a failed build cannot leave a keystore password on disk.
 */
export async function withSigningInjection<T>(
  options: {
    readonly keystorePath: string;
    readonly alias: string;
    readonly secret: KeystoreSecret;
  },
  fn: (injection: SigningInjection) => Promise<T>,
): Promise<T> {
  const root = await ensureDir(join(tmpDir(), 'signing'));
  const directory = await mkdtemp(join(root, 's-'));
  const propertiesPath = join(directory, 'agentship-signing.properties');
  const initScript = join(directory, 'agentship-signing.init.gradle');
  try {
    await writeFile(
      propertiesPath,
      [
        `agentshipStoreFile=${options.keystorePath}`,
        `agentshipStorePassword=${options.secret.storePassword}`,
        `agentshipKeyAlias=${options.alias}`,
        `agentshipKeyPassword=${options.secret.keyPassword}`,
        '',
      ].join('\n'),
      { mode: FILE_MODE },
    );
    await writeFile(initScript, signingInitScript(propertiesPath), { mode: FILE_MODE });
    return await fn({ initScript, propertiesPath });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Resolves the signing material a Gradle build needs, or explains what is missing. */
export async function resolveSigning(
  state: KeystoreState,
  profile: string | undefined,
): Promise<
  | { readonly keystorePath: string; readonly alias: string; readonly secret: KeystoreSecret }
  | undefined
> {
  if (state.origin === 'project') return undefined;
  if (state.origin === 'missing' || state.path === undefined) {
    throw new AgentshipError(ERROR_CODES.BUILD_SIGNING_FAILED, state.detail, {
      store: 'google',
      remediation: {
        summary:
          'Let Agentship generate an upload keystore (it asks for approval first), point build.android.keystore.path at one you own, or add a release signingConfig to the project.',
      },
    });
  }
  return {
    keystorePath: state.path,
    alias: state.alias ?? 'upload',
    secret: await requireKeystoreSecret({ ...(profile === undefined ? {} : { profile }) }),
  };
}
