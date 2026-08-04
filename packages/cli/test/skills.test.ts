import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENTSHIP_TOOL_NAMES } from '@agentship/mcp';
import { readSkillSources, type SkillSource, validateSkill } from '@agentship/setup';
import { describe, expect, it } from 'vitest';
import { generatedFiles } from '../../../scripts/generate-skill-references.js';
import { skillsSourceDir } from '../src/locations.js';

/**
 * The skills are product, not documentation: they are what an agent reads before touching
 * a user's App Store account. So they are checked like code — valid against the Agent
 * Skills standard, citing only tools that exist, carrying every safety rule, and with
 * their generated references in sync with the engine.
 */
const sources: readonly SkillSource[] = await readSkillSources(skillsSourceDir());
const EXPECTED = ['agentship-publish', 'agentship-first-release', 'agentship-troubleshoot'];

async function bodyOf(source: SkillSource): Promise<string> {
  const files = source.files.map((file) => file.path);
  const texts = await Promise.all(files.map((file) => readFile(join(source.dir, file), 'utf8')));
  return texts.join('\n');
}

describe('bundled skills', () => {
  it('ships exactly the three planned skills', () => {
    expect(sources.map((source) => source.name).sort()).toEqual([...EXPECTED].sort());
  });

  it('validates against the Agent Skills standard', async () => {
    for (const source of sources) {
      const validation = await validateSkill(source);
      expect(validation.errors, `${source.name}: ${validation.errors.join('; ')}`).toEqual([]);
    }
  });

  it('describes when to use each skill, so an agent can pick one', () => {
    for (const source of sources) {
      expect(source.description.length).toBeGreaterThan(80);
      expect(source.description.toLowerCase()).toContain('use w');
    }
  });

  it('mentions only tools that exist in the frozen catalog', async () => {
    for (const source of sources) {
      const text = await bodyOf(source);
      const mentioned = new Set(text.match(/agentship_[a-z_]+/g) ?? []);
      for (const name of mentioned) {
        expect(AGENTSHIP_TOOL_NAMES, `${source.name} mentions ${name}`).toContain(name);
      }
      // And every skill actually names the tools it tells the agent to use.
      expect(mentioned.size).toBeGreaterThan(0);
    }
  });

  it('carries the rules that must appear in every skill', async () => {
    const rules: { id: string; pattern: RegExp }[] = [
      {
        id: 'never auto-approve',
        pattern: /never approve on the user'?s behalf|never approve|do not approve/i,
      },
      { id: 'no "approve everything"', pattern: /approve everything|approve all/i },
      { id: 'secrets only through configure_auth', pattern: /agentship_configure_auth/i },
      { id: 'human_only is sacred', pattern: /human_only/i },
      { id: 'do not re-ask certain values', pattern: /certain|proposal|proposed/i },
      { id: 'follow the remediation', pattern: /remediation/i },
    ];
    for (const source of sources) {
      const text = await bodyOf(source);
      for (const rule of rules) {
        expect(rule.pattern.test(text), `${source.name} is missing: ${rule.id}`).toBe(true);
      }
    }
  });

  it('never tells the agent to ask for a password or a two-factor code', async () => {
    for (const source of sources) {
      const text = (await bodyOf(source)).toLowerCase();
      for (const forbidden of ['ask the user for their password', 'ask for the 2fa code']) {
        expect(text).not.toContain(forbidden);
      }
    }
  });

  it('keeps every SKILL.md body inside the token budget', async () => {
    for (const source of sources) {
      const text = await readFile(join(source.dir, 'SKILL.md'), 'utf8');
      // ~3000 tokens at four characters per token, the ceiling the standard recommends.
      expect(text.length, `${source.name} SKILL.md is too long`).toBeLessThan(12_000);
    }
  });

  it('has generated references that match the engine', async () => {
    for (const [path, expected] of Object.entries(generatedFiles())) {
      const actual = await readFile(path, 'utf8');
      expect(actual, `${path} is stale; run pnpm generate:skill-references`).toBe(expected);
    }
  });
});
