import { writeFile } from 'node:fs/promises';
import { AgentshipError } from '@agentship/core';
import { integrationsPath, readIntegrations } from '@agentship/setup';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../../setup/test/helpers.js';

/**
 * Area 7 of the audit: the installer's own record of what it changed.
 *
 * `integrations.json` is the list of files Agentship will later edit or delete on the user's
 * machine — every agent's MCP configuration and every installed skill. An attacker who can
 * write it cannot run code directly, but can try to aim `uninstall` and `update` at paths
 * Agentship never installed. The defence is that the file is data validated by a schema, and
 * that a file which fails validation stops the operation with a remediation instead of being
 * partially believed.
 *
 * These are the regression tests for the practical attempts recorded in
 * `docs/security-audit-v1.md`; the rest of area 7 (unparseable agent configuration, removing
 * only what was installed, never invoking an agent CLI from a foreign home) is covered by
 * `@agentship/setup`'s own suite.
 */
describe('a tampered integrations.json is refused, never half-believed', () => {
  let testEnv: TestEnv;
  afterEach(async () => {
    await testEnv?.cleanup();
  });

  const rejects = async (content: string): Promise<AgentshipError> => {
    await writeFile(integrationsPath(), content);
    try {
      await readIntegrations();
    } catch (error) {
      if (AgentshipError.is(error)) return error;
      throw error;
    }
    throw new Error('readIntegrations accepted a tampered file');
  };

  it('refuses a record whose shape was altered rather than trusting the good half', async () => {
    testEnv = await createTestEnv();
    // The first record is well-formed and the second is not: a parser that validated
    // entry-by-entry would keep the first and act on a half-read file.
    const error = await rejects(
      JSON.stringify({
        schemaVersion: 1,
        agents: [
          { agent: 'claude-code', configPath: '/tmp/a.json', version: '0.1.0', skills: [] },
          { agent: 'claude-code', configPath: { evil: true } },
        ],
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.remediation?.summary).toContain('setup');
  });

  it('refuses an unknown agent id, so uninstall cannot be aimed at an invented target', async () => {
    testEnv = await createTestEnv();
    const error = await rejects(
      JSON.stringify({
        schemaVersion: 1,
        agents: [{ agent: '../../etc', configPath: '/etc/passwd', version: '0.1.0', skills: [] }],
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID');
  });

  it('refuses a truncated file instead of treating it as "nothing was installed"', async () => {
    testEnv = await createTestEnv();
    // Reading this as an empty record would make `uninstall` silently a no-op and leave
    // every registration in place while reporting success.
    const error = await rejects('{"schemaVersion":1,"agents":[{"agent":"claude-code"');
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('not valid JSON');
  });
});
