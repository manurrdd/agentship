import { AGENTSHIP_VERSION, agentshipHome, STORES, type Store } from '@agentship/core';
import {
  CREDENTIAL_ENV_VARS,
  credentialSource,
  listProfiles,
  parseServiceAccountJson,
  type SetupField,
  setCredentials,
  setupFlow,
  validateSetupValue,
} from '@agentship/credentials';
import {
  agentIntegrations,
  defaultEnv,
  detectAgents,
  readIntegrations,
  runDoctor,
  skillState,
} from '@agentship/setup';
import { verifyInstall } from '@agentship/toolchain';
import { z } from 'zod';
import { mockStoresEnabled } from '../engine.js';
import { ok } from '../format.js';
import { DETAIL_DESCRIPTION, type ToolDefinition } from './types.js';

const statusSchema = z.object({
  detail: z.enum(['concise', 'full']).optional().describe(DETAIL_DESCRIPTION),
});

export const setupStatusTool: ToolDefinition = {
  name: 'agentship_setup_status',
  title: 'Installation and credential status',
  description: `Report whether this machine can publish: managed binaries installed and verified, credentials configured per store (their source and non-secret metadata — never the values), which agents have the Agentship MCP server registered, and a condensed doctor result.

Call it before planning anything, and whenever a store call fails with an authentication error.

If a store shows credentials "none", do not try to invent them and do not ask for passwords: call agentship_configure_auth for that store and walk the user through the console steps it returns. Those steps are human_only because both stores gate credential creation behind two-factor authentication — never attempt them yourself, not even with a browser.

A store with no credentials only blocks that store: the other one can still be planned and applied.`,
  schema: statusSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  async handler(session, args) {
    const input = statusSchema.parse(args);
    const detail = input.detail ?? 'concise';
    const env = defaultEnv({ logger: session.logger });

    const tools = (await verifyInstall()).map((verification) => ({
      tool: verification.tool,
      status: verification.status,
      ...(verification.version === undefined ? {} : { version: verification.version }),
      expectedVersion: verification.expectedVersion,
      ...(verification.issues.length > 0 ? { issues: verification.issues } : {}),
    }));

    const profiles = await listProfiles();
    const profile = session.engine.profile;
    const metadata = profiles.find((entry) => entry.profile === profile);
    const credentials: Record<string, unknown> = {};
    for (const store of STORES) {
      const source = await credentialSource(store, { profile });
      credentials[store] = {
        source,
        profile,
        ...(store === 'apple' && metadata?.apple !== undefined
          ? { keyId: metadata.apple.keyId, issuerId: metadata.apple.issuerId }
          : {}),
        ...(store === 'google' && metadata?.google !== undefined
          ? { clientEmail: metadata.google.clientEmail, projectId: metadata.google.projectId }
          : {}),
        ...(source === 'none'
          ? {
              howToConfigure: `Call agentship_configure_auth with store "${store}".`,
              environmentVariables: CREDENTIAL_ENV_VARS[store],
            }
          : {}),
      };
    }

    const installed = await readIntegrations();
    const agents: Record<string, unknown>[] = [];
    for (const record of installed.agents) {
      const integration = agentIntegrations().find((entry) => entry.agent === record.agent);
      const check = await integration?.check(env);
      const skills: Record<string, unknown>[] = [];
      for (const skill of record.skills) {
        skills.push({ name: skill.name, state: await skillState(skill) });
      }
      agents.push({
        agent: record.agent,
        name: integration?.name ?? record.agent,
        registered: check?.registered ?? false,
        command: check?.command,
        configPath: record.mcp?.configPath,
        method: record.mcp?.method,
        agentshipVersion: record.agentshipVersion,
        skills,
      });
    }

    const doctor = await runDoctor({ env });
    return ok({
      agentshipVersion: AGENTSHIP_VERSION,
      home: agentshipHome(),
      /** True when Agentship is talking to the in-memory mock stores instead of the real ones. */
      mockStores: mockStoresEnabled(),
      tools,
      credentials,
      agents,
      ...(detail === 'full'
        ? { detectedAgents: await detectAgents(env), doctor }
        : {
            doctor: {
              ok: doctor.ok,
              problems: doctor.checks.filter((check) => check.status !== 'ok'),
            },
          }),
    });
  },
};

const configureSchema = z.object({
  store: z.enum(['apple', 'google']).describe('Store to configure credentials for.'),
  values: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Values the user handed over, keyed by field name (apple: keyId, issuerId, privateKeyPem, optional keyName; google: serviceAccountJson). Omit to get the guided flow. Secrets are stored in the OS keyring and never echoed back.',
    ),
  profile: z.string().optional().describe('Credential profile. Defaults to the session profile.'),
  verify: z
    .boolean()
    .optional()
    .describe('Check the stored credentials against the store with one real call. Default true.'),
});

function requiredFields(store: Store): readonly SetupField[] {
  return setupFlow(store)
    .steps.flatMap((step) => step.collects ?? [])
    .filter((field) => field.required);
}

export const configureAuthTool: ToolDefinition = {
  name: 'agentship_configure_auth',
  title: 'Configure store credentials',
  description: `Guide the user through creating store credentials, then store what they bring back.

Called without "values" it returns the exact flow for that store: prerequisites, numbered console steps with URLs, which fields each step yields, warnings and troubleshooting. Every console step is human_only — both stores require two-factor authentication to create credentials, so a human must do them. Relay the steps, wait, and never attempt them with a browser.

Called with "values" it validates each value (key format, PEM curve, service-account JSON shape), stores the secret in the OS keyring, and optionally proves it works with one real store call. Nothing is echoed back: the response reports field names and status only.

This is the one place where asking the user for a secret is correct. Anywhere else in the conversation, do not ask for keys, passwords or tokens — and never write them into files or into the manifest.

Apple needs: keyId, issuerId, privateKeyPem (the whole .p8 file), optionally keyName. Google needs: serviceAccountJson (the whole file). Partial submissions are rejected with the list of what is still missing — collect them all from one console visit.`,
  schema: configureSchema,
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },

  async handler(session, args) {
    const input = configureSchema.parse(args);
    const store = input.store;
    const profile = input.profile ?? session.engine.profile;
    const flow = setupFlow(store);
    const source = await credentialSource(store, { profile });

    if (input.values === undefined || Object.keys(input.values).length === 0) {
      return ok({
        store,
        profile,
        currentCredentials: source,
        flow,
        requiredFields: requiredFields(store).map((field) => ({
          name: field.name,
          label: field.label,
          secret: field.secret,
          multiline: field.multiline,
          ...(field.help === undefined ? {} : { help: field.help }),
        })),
        nextStep: `Walk the user through flow.steps, collect every required field, then call agentship_configure_auth again with values for store "${store}".`,
      });
    }

    const fields = setupFlow(store)
      .steps.flatMap((step) => step.collects ?? [])
      .filter((field) => input.values?.[field.name] !== undefined || field.required);

    const invalid: { field: string; message: string }[] = [];
    const missing: string[] = [];
    for (const field of fields) {
      const value = input.values[field.name];
      if (value === undefined || value.trim() === '') {
        if (field.required) missing.push(field.name);
        continue;
      }
      const validation = validateSetupValue(field.kind, value);
      if (!validation.ok) invalid.push({ field: field.name, message: validation.message });
    }

    if (missing.length > 0 || invalid.length > 0) {
      return ok({
        store,
        profile,
        stored: false,
        missing,
        invalid,
        nextStep:
          'Ask the user for the missing or corrected values and call this tool again with the complete set. Do not store anything partial.',
      });
    }

    const values = input.values;
    if (store === 'apple') {
      await setCredentials(
        {
          store: 'apple',
          keyId: values['keyId'] as string,
          issuerId: values['issuerId'] as string,
          privateKeyPem: values['privateKeyPem'] as string,
          ...(values['keyName'] === undefined ? {} : { keyName: values['keyName'] }),
        },
        { profile, logger: session.logger },
      );
    } else {
      const json = values['serviceAccountJson'] as string;
      const { clientEmail, projectId } = parseServiceAccountJson(json);
      await setCredentials(
        { store: 'google', serviceAccountJson: json, clientEmail, projectId },
        { profile, logger: session.logger },
      );
    }

    let authCheck: Record<string, unknown> | undefined;
    if (input.verify !== false) {
      const adapters = await session.engine.adapters(session.projectDir ?? process.cwd());
      const adapter = adapters.get(store);
      try {
        const result = await adapter?.checkAuth(
          session.engine.context(session.projectDir ?? process.cwd()),
        );
        authCheck = result === undefined ? undefined : { ...result };
      } catch (error) {
        authCheck = {
          ok: false,
          detail:
            error instanceof Error
              ? error.message
              : 'The credentials were stored but could not be verified.',
        };
      }
    }

    return ok({
      store,
      profile,
      stored: true,
      storedFields: fields.map((field) => field.name),
      ...(authCheck === undefined ? {} : { authCheck }),
      nextStep:
        authCheck?.['ok'] === false
          ? 'Report the verification failure and its detail to the user; the credential is stored but the store rejected it.'
          : 'Credentials are ready. Continue with agentship_plan.',
    });
  },
};

const doctorSchema = z.object({});

export const doctorTool: ToolDefinition = {
  name: 'agentship_doctor',
  title: 'Diagnose the installation',
  description: `Run every installation check and report what is wrong and how to fix it: Node version, platform support, managed binaries (verified by hash, self-repaired when possible), OS keyring, credentials per store, MCP registrations and installed skills.

Use it when something fails for a reason that is not about a specific app: a tool that will not run, credentials that stopped working, an agent that no longer sees the Agentship server.

Each check carries a status (ok / warn / fail) and, when it is not ok, a remediation to relay. "fail" means publishing is blocked; "warn" means something is missing but the rest still works (no credentials for one store, for instance). If a check tells the user to run "agentship setup" or "agentship update", relay that command — those are lifecycle commands the user runs in a terminal, not something you can do through this server.`,
  schema: doctorSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  async handler(session) {
    const report = await runDoctor({ env: defaultEnv({ logger: session.logger }) });
    return ok({
      ...report,
      failing: report.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    });
  },
};
