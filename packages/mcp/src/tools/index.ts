import { analyzeTool } from './analyze.js';
import { buildTool } from './build.js';
import { applyTool, planTool, resumeTool, storeStatusTool } from './kernel.js';
import { pendingTool } from './pending.js';
import { configureAuthTool, doctorTool, setupStatusTool } from './setup.js';
import type { ToolDefinition } from './types.js';

/**
 * The catalog — ten tools, and the names are frozen: the skills cite them.
 *
 * The catalog is small on purpose. A tool per store operation would push the whole
 * publishing workflow into the model's head, one call at a time; these follow the workflow
 * instead (understand the app, check the machine, look at the store, build, plan, approve,
 * apply, handle what has no API, recover). `agentship_build` is the last addition the design
 * allows: anything else that seems necessary belongs inside the engine or inside one of
 * these entries.
 */
export const AGENTSHIP_TOOLS: readonly ToolDefinition[] = [
  analyzeTool,
  setupStatusTool,
  configureAuthTool,
  storeStatusTool,
  buildTool,
  planTool,
  applyTool,
  pendingTool,
  resumeTool,
  doctorTool,
];

export const AGENTSHIP_TOOL_NAMES: readonly string[] = AGENTSHIP_TOOLS.map((tool) => tool.name);

export type { ToolDefinition } from './types.js';
export {
  analyzeTool,
  applyTool,
  buildTool,
  configureAuthTool,
  doctorTool,
  pendingTool,
  planTool,
  resumeTool,
  setupStatusTool,
  storeStatusTool,
};
