import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentshipError, ERROR_CODES } from '../errors.js';
import { ensureDir, FILE_MODE, stateDir } from '../paths.js';
import { contentHash } from './hash.js';

/**
 * Declarations Agentship applied and the store will not read back.
 *
 * Google's Data Safety endpoint accepts an update and offers no GET — verified against the
 * pinned `gpc`, whose own `data-safety get` refuses with exactly that reason. So a snapshot
 * can never say what is declared, and a differ comparing against "the store" would either
 * re-apply the same declaration on every plan or apply nothing at all.
 *
 * The answer is to keep what was applied. Each document is archived under its own content
 * hash, so the history is intact for an audit, and a pointer file names the current one. A
 * differ compares the document it would send against that pointer: same hash, nothing to do.
 *
 * The archive is a record of Agentship's own writes, never a claim about the store. If someone
 * edits the declaration in the console, Agentship cannot see it — and says so in the diff
 * rather than pretending the archive is authoritative.
 */
export interface ArchivedDeclaration {
  readonly sha256: string;
  readonly appliedAt: string;
  readonly summary: readonly string[];
}

function archiveDir(repoRoot: string): string {
  return join(stateDir(repoRoot), 'declarations');
}

function pointerPath(repoRoot: string, kind: string): string {
  return join(archiveDir(repoRoot), `${kind}.json`);
}

/** Where the archived copy of one applied document lives. */
export function archivedDocumentPath(repoRoot: string, kind: string, sha256: string): string {
  return join(archiveDir(repoRoot), `${kind}-${sha256.slice(0, 16)}.txt`);
}

/** Records a document Agentship just applied, and returns what was recorded. */
export async function archiveDeclaration(options: {
  readonly repoRoot: string;
  readonly kind: string;
  readonly document: string;
  readonly summary: readonly string[];
}): Promise<ArchivedDeclaration> {
  const sha256 = contentHash(options.document);
  const record: ArchivedDeclaration = {
    sha256,
    appliedAt: new Date().toISOString(),
    summary: options.summary,
  };
  await ensureDir(archiveDir(options.repoRoot));
  await writeFile(archivedDocumentPath(options.repoRoot, options.kind, sha256), options.document, {
    mode: FILE_MODE,
  });
  await writeFile(
    pointerPath(options.repoRoot, options.kind),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: FILE_MODE },
  );
  return record;
}

/** What Agentship last applied, or `undefined` when it has applied nothing. */
export async function lastArchivedDeclaration(
  repoRoot: string,
  kind: string,
): Promise<ArchivedDeclaration | undefined> {
  let raw: string;
  try {
    raw = await readFile(pointerPath(repoRoot, kind), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_HOME_UNWRITABLE,
      `Could not read the archived ${kind} declaration.`,
      cause,
    );
  }
  try {
    return JSON.parse(raw) as ArchivedDeclaration;
  } catch {
    // An unreadable archive means "we do not know what was applied", which makes the differ
    // propose the declaration again — the safe direction.
    return undefined;
  }
}

/** Content hash of a document, in the form the archive stores. */
export function declarationHash(document: string): string {
  return contentHash(document);
}

/** The archive kind used for Google's Data Safety CSV. */
export const DATA_SAFETY_ARCHIVE = 'data-safety';
