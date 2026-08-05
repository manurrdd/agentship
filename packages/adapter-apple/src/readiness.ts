import type {
  AdapterContext,
  AppRef,
  SubmissionBlocker,
  SubmissionReadiness,
} from '@agentship/core';
import { z } from 'zod';
import type { AppleClient } from './client.js';
import { ascCommands } from './commands.js';

/**
 * What App Store Connect itself says is missing before a version can be submitted.
 *
 * This is the one question a diff cannot answer. Agentship's plan knows what the manifest
 * declares and what the snapshot shows, so it reports the gaps it was asked to look for; it
 * has no way to know that Apple stopped accepting a screenshot size, that a reviewer phone
 * number became mandatory, or that the attached build is still processing. `asc validate`
 * asks Apple and comes back with codes (`review_details.missing`, `screenshots.required.any`,
 * `build.required.missing`) that name the obstacle exactly.
 *
 * The report is read defensively. It is another tool's output shape, not an Apple API
 * resource, so an unrecognised payload degrades to "could not be read" — never to an empty
 * list, which would read as "nothing is wrong" and is the one answer that must never be
 * invented here.
 */
const BLOCKER_SEVERITIES = new Set(['error', 'warning', 'info']);

const CheckSchema = z.looseObject({
  code: z.string().optional(),
  severity: z.string().optional(),
  blocking: z.boolean().optional(),
  message: z.string().optional(),
  detail: z.string().optional(),
  summary: z.string().optional(),
  remediation: z.string().optional(),
});

/** Both container names `asc` uses, so a rename of one does not silently empty the report. */
const ReportSchema = z.looseObject({
  checks: z.array(CheckSchema).optional(),
  issues: z.array(CheckSchema).optional(),
});

type Check = z.infer<typeof CheckSchema>;

function toBlocker(check: Check): SubmissionBlocker | undefined {
  const message = check.message ?? check.detail ?? check.summary;
  if (message === undefined) return undefined;
  const severity = (check.severity ?? '').toLowerCase();
  return {
    code: check.code ?? 'unknown',
    severity: BLOCKER_SEVERITIES.has(severity)
      ? (severity as SubmissionBlocker['severity'])
      : 'warning',
    // Apple's own notion of blocking when the report states it; an error that does not say
    // is treated as blocking, because under-reporting a blocker costs a rejection.
    blocking: check.blocking ?? severity === 'error',
    message,
    ...(check.remediation === undefined ? {} : { remediation: check.remediation }),
  };
}

export async function getAppleSubmissionReadiness(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  version: string,
): Promise<SubmissionReadiness> {
  const args = ascCommands.validate({ appId: ref.id, version, platform: 'IOS' });
  const result = await client.runRaw(context, args, { retryTransient: true });

  // A non-zero exit is how `asc validate` reports "not ready"; the findings are still on
  // stdout. Only an unparseable payload means the question went unanswered.
  const parsed = ((): unknown => {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
  })();
  const report = ReportSchema.safeParse(parsed);
  if (!report.success) {
    return {
      store: 'apple',
      supported: false,
      reason:
        result.exitCode === 0
          ? 'asc validate returned a report Agentship could not read.'
          : `asc validate did not produce a report (exit ${result.exitCode}).`,
      blockers: [],
    };
  }

  const checks = report.data.checks ?? report.data.issues ?? [];
  return {
    store: 'apple',
    supported: true,
    blockers: checks
      .map(toBlocker)
      .filter((blocker): blocker is SubmissionBlocker => blocker !== undefined),
  };
}
