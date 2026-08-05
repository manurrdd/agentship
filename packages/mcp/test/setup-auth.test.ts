import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManifestSchema } from '@agentship/core';
import { deleteCredentials, keyringAvailable } from '@agentship/credentials';
import { afterEach, describe, expect, it } from 'vitest';
import { testManifest } from '../../core/test/kernel-helpers.js';
import {
  APPLE_ISSUER_ID,
  APPLE_KEY_ID,
  applePrivateKeyPem,
  serviceAccountJson,
} from '../../credentials/test/helpers.js';
import { createMcpHarness, type McpHarness } from './helpers.js';

/**
 * Credential hand-over through the MCP surface: the file-path route (the secret never
 * enters the conversation), the honest three-way verification outcome, and the profile the
 * manifest declares.
 *
 * Keyring-backed cases use a process-scoped profile and delete it afterwards, exactly like
 * the credentials package's own round-trip tests, so a developer's real credentials are
 * never touched.
 */
const keyring = await keyringAvailable();
const PROFILE = `mcptest-${process.pid}`;

describe('configure_auth with a file path', () => {
  let harness: McpHarness | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    if (keyring) {
      await deleteCredentials('apple', { profile: PROFILE }).catch(() => undefined);
      await deleteCredentials('google', { profile: PROFILE }).catch(() => undefined);
    }
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
    await harness?.cleanup();
    harness = undefined;
  });

  it.skipIf(!keyring)(
    'reads the .p8 from disk, warns about loose permissions, and never echoes the key',
    async () => {
      harness = await createMcpHarness({ stores: ['apple'] });
      scratch = await mkdtemp(join(tmpdir(), 'agentship-p8-'));
      const keyPath = join(scratch, 'AuthKey_ABCD1234EF.p8');
      const pem = applePrivateKeyPem();
      await writeFile(keyPath, pem);
      await chmod(keyPath, 0o644);

      const response = await harness.call('agentship_configure_auth', {
        store: 'apple',
        profile: PROFILE,
        verify: false,
        values: { keyId: APPLE_KEY_ID, issuerId: APPLE_ISSUER_ID, privateKeyPath: keyPath },
      });

      expect(response.payload['stored']).toBe(true);
      const warnings = (response.payload['warnings'] as string[]).join('\n');
      expect(warnings).toContain(`chmod 600 ${keyPath}`);
      const notes = (response.payload['notes'] as string[]).join('\n');
      expect(notes).toContain('no longer needed');
      // The secret travelled as a path; the contents must never appear in the response.
      expect(response.text).not.toContain('BEGIN PRIVATE KEY');
      expect(response.text).not.toContain(pem.split('\n')[1] as string);
    },
  );

  it.skipIf(!keyring)(
    'reports a Google credential as unverifiable — not rejected — without an app to test against',
    async () => {
      harness = await createMcpHarness({ stores: ['google'] });
      // No project in the session: nothing carries a package name, so nothing was tested.
      const response = await harness.call('agentship_configure_auth', {
        store: 'google',
        profile: PROFILE,
        values: { serviceAccountJson: serviceAccountJson() },
      });
      expect(response.payload['stored']).toBe(true);
      const check = response.payload['authCheck'] as { status: string; ok: boolean };
      expect(check.status).toBe('unverifiable');
      expect(check.ok).toBe(false);
      const nextStep = String(response.payload['nextStep']);
      expect(nextStep).toContain('NOT rejected');
      expect(nextStep).not.toContain('the store rejected it');
    },
  );

  it.skipIf(!keyring)(
    'verifies Google against the package name once the session has a project',
    async () => {
      harness = await createMcpHarness({ stores: ['google'] });
      // Any project-bound call fixes the session's project; the manifest carries the
      // package name the verification needs.
      await harness.call('agentship_pending', { projectDir: harness.repoRoot, action: 'list' });
      const response = await harness.call('agentship_configure_auth', {
        store: 'google',
        profile: PROFILE,
        values: { serviceAccountJson: serviceAccountJson() },
      });
      const check = response.payload['authCheck'] as { status: string; ok: boolean };
      expect(check.status).toBe('ok');
      expect(String(response.payload['nextStep'])).toContain('agentship_plan');
    },
  );
});

describe('the profile the manifest declares', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('is the effective profile of the project, and setup_status warns about the difference', async () => {
    const manifest = ManifestSchema.parse({
      ...testManifest({ stores: ['apple'] }),
      credentials: { profile: 'workprofile' },
    });
    harness = await createMcpHarness({ stores: ['apple'], manifest });
    await harness.call('agentship_pending', { projectDir: harness.repoRoot, action: 'list' });

    const status = await harness.call('agentship_setup_status', {});
    const credentials = status.payload['credentials'] as {
      apple: { profile: string };
    };
    expect(credentials.apple.profile).toBe('workprofile');
    const warnings = (status.payload['warnings'] as string[] | undefined) ?? [];
    expect(warnings.join('\n')).toContain('workprofile');
    expect(warnings.join('\n')).toContain('default');
  });
});
