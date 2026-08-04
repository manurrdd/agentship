import { readFile } from 'node:fs/promises';
import { AgentshipError, PRIVACY_DATA_TYPES, type PrivacyDeclaration } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import {
  dataSafetyFormat,
  generateDataSafetyCsv,
  mapDataType,
  mapPurpose,
  privacyMapping,
  projectPrivacy,
  validateDataSafetyCsv,
} from '../src/index.js';

function declaration(overrides: Partial<PrivacyDeclaration> = {}): PrivacyDeclaration {
  return {
    declarationStatus: 'confirmed',
    dataPractices: [
      {
        dataType: 'identifiers',
        collected: true,
        purposes: ['advertising', 'analytics'],
        linkedToUser: true,
        tracking: true,
        shared: true,
        source: 'inferred',
        evidence: 'Google AdMob typically collects this data',
      },
      {
        dataType: 'diagnostics',
        collected: true,
        purposes: ['app_functionality'],
        linkedToUser: false,
        tracking: false,
        shared: false,
        source: 'inferred',
        evidence: 'Firebase Crashlytics typically collects this data',
      },
    ],
    ...overrides,
  };
}

describe('privacy taxonomy mappings', () => {
  it('covers every neutral data type in both stores', () => {
    for (const store of ['apple', 'google'] as const) {
      for (const dataType of PRIVACY_DATA_TYPES) {
        expect(mapDataType(store, dataType), `${store}/${dataType}`).toBeDefined();
      }
    }
  });

  it('carries a verification date so a taxonomy change is visible', () => {
    for (const store of ['apple', 'google'] as const) {
      expect(privacyMapping(store).lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('says when a purpose has no equivalent instead of choosing the nearest label', () => {
    // Play's form has no "other purposes" answer; the mapping refuses to invent one.
    expect(mapPurpose('google', 'other').label).toBeUndefined();
    expect(mapPurpose('google', 'other').unmappedReason).toContain('no "other purposes"');
    // Apple does have one.
    expect(mapPurpose('apple', 'other').label).toBe('Other Purposes');
  });
});

describe('projecting the declaration', () => {
  it('renders Apple categories and purposes', () => {
    const projection = projectPrivacy('apple', declaration());
    const identifiers = projection.practices.find((entry) => entry.dataType === 'identifiers');
    expect(identifiers?.category).toBe('Identifiers');
    expect(identifiers?.purposes).toEqual(['Analytics', 'Third-Party Advertising']);
    expect(projection.questions).toEqual([]);
  });

  it('renders Google categories and purposes', () => {
    const projection = projectPrivacy('google', declaration());
    const identifiers = projection.practices.find((entry) => entry.dataType === 'identifiers');
    expect(identifiers?.category).toBe('Device or other IDs');
    expect(identifiers?.purposes).toEqual(['Advertising or marketing', 'Analytics']);
  });

  it('asks a question rather than projecting an unmappable purpose', () => {
    const projection = projectPrivacy('google', {
      declarationStatus: 'confirmed',
      dataPractices: [
        {
          dataType: 'usage_data',
          collected: true,
          purposes: ['other'],
          linkedToUser: false,
          tracking: false,
          shared: false,
          source: 'declared',
        },
      ],
    });
    expect(projection.questions.join(' ')).toContain('no "other purposes"');
    expect(projection.practices).toEqual([]);
  });

  it('leaves out a practice explicitly declared as not collected', () => {
    const projection = projectPrivacy('google', {
      declarationStatus: 'confirmed',
      dataPractices: [
        {
          dataType: 'location',
          collected: false,
          purposes: ['app_functionality'],
          linkedToUser: false,
          tracking: false,
          shared: false,
          source: 'declared',
        },
      ],
    });
    expect(projection.practices).toEqual([]);
    expect(projection.questions).toEqual([]);
  });

  it('is deterministic: same declaration, same projection', () => {
    expect(projectPrivacy('apple', declaration())).toEqual(projectPrivacy('apple', declaration()));
  });
});

describe('the Data Safety CSV', () => {
  it('generates a document that validates against the versioned format', () => {
    const { csv, summary } = generateDataSafetyCsv(projectPrivacy('google', declaration()));
    const validation = validateDataSafetyCsv(csv);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.header).toEqual(dataSafetyFormat().columns.map((column) => column.name));
    expect(summary.length).toBe(validation.rows.length);
  });

  it('round-trips: every generated row reads back with the values it was given', () => {
    const { csv } = generateDataSafetyCsv(projectPrivacy('google', declaration()));
    const { rows } = validateDataSafetyCsv(csv);
    const adId = rows.find((row) => row['data_type'] === 'Device or other IDs');
    expect(adId?.['data_category']).toBe('Device or other IDs');
    expect(adId?.['collected']).toBe('true');
    expect(adId?.['shared']).toBe('true');
    expect(adId?.['purposes']).toBe('Advertising or marketing; Analytics');
    expect(adId?.['sharing_purposes']).toBe('Advertising or marketing; Analytics');

    const crash = rows.find((row) => row['data_type'] === 'Crash logs');
    expect(crash?.['shared']).toBe('false');
    expect(crash?.['sharing_purposes']).toBe('');
  });

  it('refuses to generate while the projection has an open question', () => {
    const projection = projectPrivacy('google', {
      declarationStatus: 'confirmed',
      dataPractices: [
        {
          dataType: 'usage_data',
          collected: true,
          purposes: ['other'],
          linkedToUser: false,
          tracking: false,
          shared: false,
          source: 'declared',
        },
      ],
    });
    expect(() => generateDataSafetyCsv(projection)).toThrow(AgentshipError);
  });

  it('accepts the reference export and rejects one with the wrong header', async () => {
    const reference = await readFile(
      new URL('./fixtures/data-safety-export.csv', import.meta.url),
      'utf8',
    );
    expect(validateDataSafetyCsv(reference).errors).toEqual([]);

    const broken = reference.replace('data_type', 'dataType');
    const validation = validateDataSafetyCsv(broken);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toContain('Header mismatch');
  });

  it('rejects a row whose boolean column holds something else', async () => {
    const reference = await readFile(
      new URL('./fixtures/data-safety-export.csv', import.meta.url),
      'utf8',
    );
    const broken = reference.replace(',true,', ',yes,');
    expect(validateDataSafetyCsv(broken).ok).toBe(false);
  });

  it('quotes a value containing a comma so the document stays parseable', () => {
    const projection = projectPrivacy('google', {
      declarationStatus: 'confirmed',
      dataPractices: [
        {
          dataType: 'identifiers',
          collected: true,
          purposes: ['fraud_prevention'],
          linkedToUser: false,
          tracking: false,
          shared: false,
          source: 'declared',
        },
      ],
    });
    const { csv } = generateDataSafetyCsv(projection);
    // Play's own purpose label contains commas.
    expect(csv).toContain('"Fraud prevention, security, and compliance"');
    expect(validateDataSafetyCsv(csv).rows[0]?.['purposes']).toBe(
      'Fraud prevention, security, and compliance',
    );
  });
});
