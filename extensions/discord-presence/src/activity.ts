import type { Activity } from "./types.ts";
import { bashHead, fileNameFromPath } from "./types.ts";
import { resolveLanguage } from "./language.ts";

export type ToolInput = { readonly path?: string; readonly command?: string };

export type AgentSignal =
  | { readonly type: "tool_start"; readonly toolCallId: string; readonly toolName: string; readonly input: ToolInput }
  | { readonly type: "tool_end"; readonly toolCallId: string }
  | { readonly type: "thinking" } // turn_start / message_update
  | { readonly type: "turn_end" }
  | { readonly type: "agent_end" };

export interface ActivityState {
  readonly activeTools: ReadonlyArray<{ readonly toolCallId: string; readonly activity: Activity }>;
  readonly turnActive: boolean;
}

export const initialActivityState = (): ActivityState => ({ activeTools: [], turnActive: false });

const SEARCH_TOOLS = new Set([
  "grep",
  "glob",
  "find",
  "ffgrep",
  "fffind",
  "search",
  "code_pattern",
  "lsp_workspace_symbols",
]);
const BROWSE_TOOLS = new Set(["web_search", "fetch_content", "fetch", "browse", "get_search_content"]);

export const classifyTool = (toolName: string, input: ToolInput): Activity => {
  const n = toolName.toLowerCase();
  if ((n === "edit" || n === "write") && input.path) {
    return { kind: "editing", language: resolveLanguage(fileNameFromPath(input.path)) };
  }
  if (n === "read" && input.path) {
    return { kind: "reading", language: resolveLanguage(fileNameFromPath(input.path)) };
  }
  if (SEARCH_TOOLS.has(n)) return { kind: "searching" };
  if (BROWSE_TOOLS.has(n)) return { kind: "browsing" };
  if (n === "bash" && input.command) return { kind: "running", head: bashHead(input.command) };
  return { kind: "tool", toolName };
};

export const reduce = (state: ActivityState, signal: AgentSignal): ActivityState => {
  switch (signal.type) {
    case "tool_start":
      return {
        activeTools: [
          ...state.activeTools,
          { toolCallId: signal.toolCallId, activity: classifyTool(signal.toolName, signal.input) },
        ],
        turnActive: true,
      };
    case "tool_end":
      return { ...state, activeTools: state.activeTools.filter((tool) => tool.toolCallId !== signal.toolCallId) };
    case "thinking":
      return { ...state, turnActive: true };
    case "turn_end":
      // Between turns within the agent loop: drop stale tools, stay "thinking".
      return { activeTools: [], turnActive: true };
    case "agent_end":
      // Whole prompt finished → idle.
      return { activeTools: [], turnActive: false };
  }
};

// Most-recently-started active tool wins (OQ1); else thinking if a turn is live;
// else idle.
export const toActivity = (state: ActivityState): Activity => {
  const top = state.activeTools[state.activeTools.length - 1];
  if (top) return top.activity;
  if (state.turnActive) return { kind: "thinking" };
  return { kind: "idle" };
};
