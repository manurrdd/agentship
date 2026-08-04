import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type AgentshipServerOptions, createAgentshipServer } from './server.js';

/**
 * Runs the server over stdio — the only transport Agentship supports.
 *
 * An MCP stdio server owns stdout: a single stray byte written there corrupts the
 * protocol stream. Agentship's logger writes to a file (and to stderr only when asked), and
 * nothing in the engine prints, so the guarantee holds without a redirection hack here.
 */
export async function runStdioServer(options: AgentshipServerOptions = {}): Promise<void> {
  const { server, session } = createAgentshipServer(options);
  const transport = new StdioServerTransport();
  session.logger.info('starting the MCP server', { transport: 'stdio' });
  await server.connect(transport);

  // The session ends when the client closes the pipe or the process is asked to stop.
  // `transport.onclose` belongs to the SDK's own protocol bookkeeping, so the end of
  // stdin is observed directly instead of being intercepted.
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void server.close().finally(() => {
        resolve();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdin.once('end', stop);
    process.stdin.once('close', stop);
  });
}
