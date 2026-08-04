import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentshipError, ERROR_CODES } from '@agentship/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DATA_DIR } from '../data-dir.js';
import type { PrivacyProjection } from './projection.js';

/**
 * The Google Data Safety declaration, as the CSV Play's API takes.
 *
 * `gpc data-safety update --file <csv>` posts the file's bytes verbatim as `safetyLabels`;
 * it does not parse or validate them (verified by reading the pinned gpc 0.9.93 binary). So
 * the document Agentship produces is the only thing standing between a neutral declaration and
 * a legal statement on a store page, and it is generated from a versioned format description
 * (`data/privacy/data-safety-csv.yaml`) rather than from string concatenation.
 *
 * The same endpoint is write-only — Play has no GET for data safety — so nothing can read the
 * live declaration back. Convergence is therefore decided against the copy Agentship archives
 * after each apply, and the Google snapshot reports `dataSafety` as a gap rather than
 * claiming to know.
 */
const ColumnSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    values: z.array(z.string()).optional(),
    required: z.boolean(),
  })
  .strict();

const FormatSchema = z
  .object({
    schemaVersion: z.literal(1),
    lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.string().url(),
    verifiedAgainst: z.enum(['documentation', 'console-export']),
    columns: z.array(ColumnSchema).min(1),
  })
  .strict();

export type DataSafetyFormat = z.infer<typeof FormatSchema>;

let format: DataSafetyFormat | undefined;

export function dataSafetyFormat(): DataSafetyFormat {
  if (format !== undefined) return format;
  const path = join(DATA_DIR, 'privacy', 'data-safety-csv.yaml');
  const parsed = FormatSchema.safeParse(parseYaml(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new AgentshipError(
      ERROR_CODES.CONFIG_INVALID,
      'The Data Safety CSV format description failed validation.',
      { details: { path, issues: z.treeifyError(parsed.error) } },
    );
  }
  format = parsed.data;
  return parsed.data;
}

/** RFC 4180 quoting: only what needs quotes gets them, so the output stays diffable. */
function quoteField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface DataSafetyCsv {
  readonly csv: string;
  /** One line per declared data type, for the diff and the journal. */
  readonly summary: readonly string[];
}

/**
 * Generates the CSV from a Google projection.
 *
 * Refuses outright while the projection has open questions: a declaration with a guessed
 * answer in it is worse than no declaration, because it is the developer's statement about
 * their own app.
 */
export function generateDataSafetyCsv(projection: PrivacyProjection): DataSafetyCsv {
  if (projection.store !== 'google') {
    throw new AgentshipError(
      ERROR_CODES.CONFIG_INVALID,
      'The Data Safety CSV is generated from the Google projection.',
    );
  }
  if (projection.questions.length > 0) {
    throw new AgentshipError(
      ERROR_CODES.PLAN_INPUT_REQUIRED,
      'The privacy declaration has unanswered questions; the Data Safety CSV cannot be generated.',
      {
        details: { questions: projection.questions },
        remediation: {
          summary: 'Answer each question in the manifest privacy section, then plan again.',
        },
      },
    );
  }

  const columns = dataSafetyFormat().columns.map((column) => column.name);
  const rows: string[][] = [];
  const summary: string[] = [];

  for (const practice of projection.practices) {
    for (const type of practice.types) {
      rows.push([
        type,
        practice.category,
        String(practice.collected),
        String(practice.shared),
        // Ephemeral processing is a claim about runtime behaviour that static analysis
        // cannot make. Declaring `false` is the conservative answer: it says the data may
        // be stored, which is never an under-declaration.
        'false',
        String(practice.linkedToUser),
        practice.purposes.join('; '),
        practice.shared ? practice.purposes.join('; ') : '',
      ]);
      summary.push(
        `${practice.category} / ${type}: collected=${practice.collected}, shared=${practice.shared}, purposes=${practice.purposes.join('; ')}`,
      );
    }
  }

  const lines = [columns.join(','), ...rows.map((row) => row.map(quoteField).join(','))];
  return { csv: `${lines.join('\n')}\n`, summary };
}

export interface CsvValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** Header row as found, so a mismatch can be reported precisely. */
  readonly header: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

/** Minimal RFC 4180 reader: enough for a document Agentship generates and Play exports. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Checks a CSV against the versioned format description.
 *
 * Used two ways: on Agentship's own output, so a change to the generator cannot drift from the
 * format file, and on a CSV exported from a real Play Console, which is how the format file
 * itself gets verified.
 */
export function validateDataSafetyCsv(text: string): CsvValidation {
  const spec = dataSafetyFormat();
  const rows = parseCsv(text).filter((row) => row.some((cell) => cell.trim() !== ''));
  const errors: string[] = [];
  if (rows.length === 0) {
    return { ok: false, errors: ['The CSV is empty.'], header: [], rows: [] };
  }
  const header = rows[0] as string[];
  const expected = spec.columns.map((column) => column.name);
  if (header.length !== expected.length || header.some((name, index) => name !== expected[index])) {
    errors.push(
      `Header mismatch. Expected ${expected.join(', ')}; found ${header.join(', ')}. Update data/privacy/data-safety-csv.yaml if Play changed the export.`,
    );
  }

  const parsedRows: Record<string, string>[] = [];
  for (const [index, row] of rows.slice(1).entries()) {
    if (row.length !== header.length) {
      errors.push(
        `Row ${index + 2} has ${row.length} fields; the header declares ${header.length}.`,
      );
      continue;
    }
    const record: Record<string, string> = {};
    header.forEach((name, position) => {
      record[name] = row[position] as string;
    });
    for (const column of spec.columns) {
      const value = record[column.name];
      if (column.required && (value === undefined || value.trim() === '')) {
        errors.push(`Row ${index + 2}: "${column.name}" is required and empty.`);
      }
      if (column.values !== undefined && value !== undefined && !column.values.includes(value)) {
        errors.push(
          `Row ${index + 2}: "${column.name}" is "${value}"; allowed values are ${column.values.join(', ')}.`,
        );
      }
    }
    parsedRows.push(record);
  }

  return { ok: errors.length === 0, errors, header, rows: parsedRows };
}
