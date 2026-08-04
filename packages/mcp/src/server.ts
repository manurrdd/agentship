import { AGENTSHIP_VERSION } from '@agentship/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fail, type ToolResponse } from './format.js';
import { Session, type SessionOptions } from './session.js';
import { AGENTSHIP_TOOLS } from './tools/index.js';
import type { Progress, ToolDefinition } from './tools/types.js';

/**
 * The MCP server: nine tools, stdio transport, and no logic of its own.
 *
 * Every handler does the same three things — resolve the project, call the engine,
 * project the result for a model — and every error leaves through {@link fail}, which
 * turns it into a structured payload with a remediation instead of a stack trace. Nothing
 * is ever written to stdout except protocol messages: the logger writes to
 * `~/.agentship/logs/agentship-<date>.log`.
 */
export interface AgentshipServerOptions extends SessionOptions {
  readonly serverName?: string;
}

export function createSession(options: AgentshipServerOptions = {}): Session {
  return new Session(options);
}

export function createAgentshipServer(options: AgentshipServerOptions = {}): {
  readonly server: McpServer;
  readonly session: Session;
} {
  const session = createSession(options);
  const server = new McpServer(
    { name: options.serverName ?? 'agentship', version: AGENTSHIP_VERSION },
    {
      instructions:
        'Agentship publishes iOS and Android apps. Start with agentship_analyze on the repository, check agentship_setup_status, then agentship_plan. Actions classified needs_approval require the human to approve each action id after seeing its diff — never approve on their behalf. Work with no API comes back through agentship_pending.',
    },
  );

  for (const tool of AGENTSHIP_TOOLS) register(server, session, tool);
  return { server, session };
}

function register(server: McpServer, session: Session, tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.schema.shape,
      annotations: { title: tool.title, ...tool.annotations },
    },
    async (args: unknown, extra: unknown): Promise<ToolResponse> => {
      const progress = progressReporter(extra);
      const started = Date.now();
      try {
        const response = await tool.handler(session, args, progress);
        session.logger.debug('tool call finished', {
          tool: tool.name,
          ms: Date.now() - started,
        });
        return response;
      } catch (error) {
        session.logger.warn('tool call failed', { tool: tool.name, err: error });
        return fail(error);
      }
    },
  );
}

/**
 * Progress notifications, when the client asked for them.
 *
 * The MCP client opts in by sending a progress token with the call; without one there is
 * nothing to report to, and the reporter becomes a no-op. A client that rejects the
 * notification does not fail the tool call — progress is a courtesy, never a dependency.
 */
function progressReporter(extra: unknown): Progress {
  const meta = (extra as { _meta?: { progressToken?: string | number } } | undefined)?._meta;
  const token = meta?.progressToken;
  const send = (extra as { sendNotification?: (n: unknown) => Promise<void> } | undefined)
    ?.sendNotification;
  if (token === undefined || send === undefined) return async () => undefined;

  return async (message, current, total) => {
    try {
      await send({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          message,
          progress: current ?? 0,
          ...(total === undefined ? {} : { total }),
        },
      });
    } catch {
      // A client that cannot take notifications still gets its result.
    }
  };
}
