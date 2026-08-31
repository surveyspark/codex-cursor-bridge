import { CodexAppServerAdapter } from "./app-server.js";
import { CodexExecAdapter } from "./exec-fallback.js";
import { mapProfileToSandbox } from "./sandbox.js";
import { buildTaskPrompt, buildFollowUpPrompt } from "./prompt.js";
import {
  extractChangedFiles,
  extractCommands,
  extractTests,
} from "./normalize.js";
import type {
  AdapterAvailability,
  AdapterCapabilities,
  AdapterRunContext,
  AgentAdapter,
} from "./types.js";

export {
  CodexAppServerAdapter,
  CodexExecAdapter,
  mapProfileToSandbox,
  buildTaskPrompt,
  buildFollowUpPrompt,
  extractChangedFiles,
  extractCommands,
  extractTests,
};
export type {
  AdapterAvailability,
  AdapterCapabilities,
  AdapterRunContext,
  AgentAdapter,
};
