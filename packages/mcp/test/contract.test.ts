import { afterEach, describe, expect, it } from 'vitest';
import { MAX_RESPONSE_CHARS, serialize } from '../src/format.js';
import { AGENTSHIP_TOOLS } from '../src/tools/index.js';
import { createMcpHarness, type McpHarness } from './helpers.js';

/**
 * The parts of the MCP surface that are a contract rather than an implementation detail:
 * the tool names (frozen — the skills cite them), the descriptions (they are the prompt an
 * agent reads before choosing a tool), the response ceiling, and the promise that no
 * secret ever leaves through a tool response.
 */
describe('tool catalog', () => {
  it('is exactly ten agentship_ tools', () => {
    expect(AGENTSHIP_TOOLS).toHaveLength(10);
    for (const tool of AGENTSHIP_TOOLS) expect(tool.name.startsWith('agentship_')).toBe(true);
  });

  it('matches the reviewed descriptions', () => {
    const catalog = AGENTSHIP_TOOLS.map(
      (tool) => `## ${tool.name}\n${tool.title}\n\n${tool.description}`,
    ).join('\n\n---\n\n');
    expect(catalog).toMatchSnapshot();
  });

  it('describes every input field', () => {
    for (const tool of AGENTSHIP_TOOLS) {
      for (const [name, field] of Object.entries(tool.schema.shape)) {
        expect(field.description, `${tool.name}.${name} has no description`).toBeDefined();
      }
    }
  });

  it('tells the agent that approvals come from the human', () => {
    const apply = AGENTSHIP_TOOLS.find((tool) => tool.name === 'agentship_apply');
    expect(apply?.description).toMatch(/human approved/i);
    expect(apply?.description).toMatch(/content hash/i);
    const plan = AGENTSHIP_TOOLS.find((tool) => tool.name === 'agentship_plan');
    expect(plan?.description).toMatch(/never approve on the user's behalf/i);
  });

  it('warns that generating a signing key is the user decision', () => {
    const build = AGENTSHIP_TOOLS.find((tool) => tool.name === 'agentship_build');
    expect(build?.description).toMatch(/ask the user first/i);
    expect(build?.description).toMatch(/never be updated again/i);
  });
});

describe('response budget', () => {
  it('trims oversized payloads and says what it trimmed', () => {
    const payload = {
      actions: Array.from({ length: 5_000 }, (_, index) => ({
        id: `action-${index}`,
        summary: 'x'.repeat(200),
      })),
    };
    const result = serialize(payload);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const parsed = JSON.parse(result.text) as {
      truncated: { paths: { path: string; kept: number; total: number }[] };
    };
    expect(parsed.truncated.paths.some((entry) => entry.path === 'actions')).toBe(true);
  });

  it('leaves payloads that fit exactly as they are', () => {
    const result = serialize({ hello: 'world' });
    expect(result.truncated).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ hello: 'world' });
  });
});

describe('secrets', () => {
  let harness: McpHarness | undefined;
  const canary = 'CANARY-c3cb0f1a-private-key-material';

  afterEach(async () => {
    delete process.env['AGENTSHIP_APPLE_KEY_ID'];
    delete process.env['AGENTSHIP_APPLE_ISSUER_ID'];
    delete process.env['AGENTSHIP_APPLE_P8'];
    await harness?.cleanup();
    harness = undefined;
  });

  it('never echoes credential material in a tool response', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });
    process.env['AGENTSHIP_APPLE_KEY_ID'] = 'ABCD1234EF';
    process.env['AGENTSHIP_APPLE_ISSUER_ID'] = '69a6de70-03db-47e3-e053-5b8c7c11a4d1';
    process.env['AGENTSHIP_APPLE_P8'] =
      `-----BEGIN PRIVATE KEY-----\n${canary}\n-----END PRIVATE KEY-----`;

    const responses = [
      await harness.call('agentship_setup_status', {}),
      await harness.call('agentship_setup_status', { detail: 'full' }),
      await harness.call('agentship_doctor', {}),
      await harness.call('agentship_configure_auth', { store: 'apple' }),
      await harness.call('agentship_store_status', { projectDir: harness.repoRoot }),
      await harness.call('agentship_plan', { projectDir: harness.repoRoot }),
    ];

    for (const response of responses) {
      expect(response.text).not.toContain(canary);
      expect(response.text).not.toContain('BEGIN PRIVATE KEY');
    }
    // The non-secret metadata is still reported, so the agent can tell what is configured.
    expect(responses[0]?.text).toContain('"source": "env"');
    // And the env path is explained: precedence over the keyring, profile-agnostic.
    expect(responses[0]?.text).toContain('precedence over anything stored in the OS keyring');
    // Six real tool calls, two of which probe the machine's toolchain and keyring. That is
    // the point — the canary has to survive the paths that actually touch credentials — but
    // it makes this the one test here that does seconds of I/O, and it hit the default
    // ceiling when the suite ran it alongside everything else. The number is room for real
    // work, not cover for a regression: if this starts approaching it, something got slower.
  }, 60_000);

  it('returns the credential flow without asking anyone to hand over a password', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });
    const response = await harness.call('agentship_configure_auth', { store: 'google' });
    const flow = response.payload['flow'] as {
      steps: { actionClass: string; instructions: string[] }[];
    };
    expect(flow.steps.every((step) => step.instructions.length > 0)).toBe(true);
    expect(flow.steps.some((step) => step.actionClass === 'human_only')).toBe(true);
    expect(response.payload['currentCredentials']).toBe('none');
  });

  it('refuses a partial credential submission instead of storing half of it', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });
    const response = await harness.call('agentship_configure_auth', {
      store: 'apple',
      values: { keyId: 'ABCD1234EF' },
      verify: false,
    });
    expect(response.payload['stored']).toBe(false);
    expect(response.payload['missing']).toEqual(
      expect.arrayContaining(['issuerId', 'privateKeyPem']),
    );
  });
});
