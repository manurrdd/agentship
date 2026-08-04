import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { AgentshipError, agentshipHome, ERROR_CODES, isInside, type Logger } from '@agentship/core';
import { type AdapterFactory, Engine, mcpLogger } from './engine.js';

/**
 * One MCP session: which project the conversation is about, and the engine bound to it.
 *
 * `agentship_analyze` fixes the project directory so the rest of the conversation does not
 * have to repeat it — an agent that has analysed a repository can then say "plan" or
 * "apply" with no arguments. Any tool may still override it per call, which is what makes
 * a session covering two repositories possible without a second server.
 */
export interface SessionOptions {
  readonly logger?: Logger;
  readonly profile?: string;
  readonly adapterFactory?: AdapterFactory;
  /** Project directory the session starts on, when the host already knows it. */
  readonly projectDir?: string;
}

export class Session {
  readonly engine: Engine;
  readonly logger: Logger;
  #projectDir: string | undefined;

  constructor(options: SessionOptions = {}) {
    this.logger = options.logger ?? mcpLogger();
    this.engine = new Engine({
      logger: this.logger,
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.adapterFactory === undefined ? {} : { adapterFactory: options.adapterFactory }),
    });
    this.#projectDir = options.projectDir === undefined ? undefined : resolve(options.projectDir);
  }

  get projectDir(): string | undefined {
    return this.#projectDir;
  }

  /** Validates a directory and makes it the session's project. */
  async setProject(dir: string): Promise<string> {
    const resolved = resolve(dir);
    const info = await stat(resolved).catch(() => undefined);
    if (info === undefined) {
      throw new AgentshipError(
        ERROR_CODES.ANALYZE_PATH_NOT_FOUND,
        `There is no directory at ${resolved}.`,
        { remediation: { summary: 'Pass the absolute path of the app repository.' } },
      );
    }
    if (!info.isDirectory()) {
      throw new AgentshipError(
        ERROR_CODES.ANALYZE_NOT_A_DIRECTORY,
        `${resolved} is not a directory.`,
        { remediation: { summary: 'Pass the repository root, not a file inside it.' } },
      );
    }
    // A project directory becomes the root of an `.agentship/` state tree (journal, plan,
    // pending). It must be a repository, never a home directory, the filesystem root, or
    // Agentship's own private home — writing project state there would either scatter it across
    // an unrelated tree or mix it with Agentship's credential-adjacent state. The repository
    // itself is not confined to any parent (an agent may legitimately work anywhere), so this
    // rejects only the roots that are never a project.
    if (resolved === dirname(resolved) || resolved === homedir()) {
      throw new AgentshipError(
        ERROR_CODES.ANALYZE_NOT_A_DIRECTORY,
        `${resolved} is not a project directory; pass the root of an app repository.`,
        { remediation: { summary: 'Pass the repository root, not a home or system directory.' } },
      );
    }
    if (resolved === agentshipHome() || isInside(agentshipHome(), resolved)) {
      throw new AgentshipError(
        ERROR_CODES.ANALYZE_NOT_A_DIRECTORY,
        `${resolved} is inside Agentship's private home and cannot be a project directory.`,
        { remediation: { summary: 'Pass the root of an app repository outside ~/.agentship.' } },
      );
    }
    this.#projectDir = resolved;
    return resolved;
  }

  /** The project this call is about: the explicit argument, or the session's. */
  async requireProject(projectDir?: string): Promise<string> {
    if (projectDir !== undefined) return this.setProject(projectDir);
    if (this.#projectDir !== undefined) return this.#projectDir;
    throw new AgentshipError(
      ERROR_CODES.CONFIG_NOT_FOUND,
      'No project directory is set for this session.',
      {
        remediation: {
          summary:
            'Call agentship_analyze with the repository path first, or pass projectDir to this tool.',
        },
      },
    );
  }
}
