/**
 * Agent Bridge — backward-compatible re-exports.
 *
 * The actual implementation has been split into:
 *   - tool-registry.ts    — executeTool() with all tool cases
 *   - prompt-builder.ts   — buildCommanderPrompt()
 *   - pipeline.ts         — processWithCommander() orchestrator
 *   - middleware/          — pipeline stages (feedback, knowledge, context, route, execute, learn)
 */

export { executeTool } from "./tool-registry.js";
export { processWithCommander } from "./pipeline.js";
export type { CommanderResponse, PersonaMsg } from "./pipeline.js";
 