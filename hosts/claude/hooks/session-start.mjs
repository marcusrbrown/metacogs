// generated — do not edit; run `bun run generate`
// helper_version: 0.3.0

// src/hosts/session-start.ts
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
var FALSE_LIKE = new Set(["false", "0", "off", "no"]);
function markerPath(env) {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : env.HOME ? join(env.HOME, ".config") : undefined;
  return base === undefined ? undefined : join(base, "metacogs", "guidance-off");
}
function guidanceOff(env) {
  if (env.METACOGS_GUIDANCE?.toLowerCase() === "off")
    return true;
  if (FALSE_LIKE.has((env.CLAUDE_PLUGIN_OPTION_GUIDANCE ?? "").toLowerCase()))
    return true;
  const marker = markerPath(env);
  return marker !== undefined && existsSync(marker);
}
var off = false;
try {
  off = guidanceOff(process.env);
} catch {
  off = false;
}
if (!off) {
  process.stdout.on("error", () => {});
  process.stdout.write("metacogs is installed in Claude Code. It provides two reasoning tools, `feel` and `drugs`, a `record` tool, and four skills: `feel`, `drugs`, `synthesis` and `counterfactual`.\n\nThe `feel` tool is `mcp__plugin_metacogs_metacogs__feel`. It is a pause on a tension that has no name yet. It fits when the same failure persists after materially different attempts, when conflicting constraints block a commitment, or when the next step would repeat a hypothesis already exhausted. The `feel` skill describes it, and a person can start that skill with `/metacogs:feel`.\n\nThe `drugs` tool is `mcp__plugin_metacogs_metacogs__drugs`. It is a stated change of approach for the next attempt. It fits when requested creative or design exploration has stalled on the same few alternatives, or when another attempt would repeat the last one. The `drugs` skill describes it, and a person can start that skill with `/metacogs:drugs`.\n\nNeither tool supplies facts or checks anything. Permissions, verification and stated uncertainty are unchanged.\n\nThe `record` tool is `mcp__plugin_metacogs_metacogs__record`. It writes the decision record that `synthesis` and `counterfactual` end with to a file on this machine.\n\nThe `synthesis` skill fits a request to decide, approve or choose between options when several analyses, reviews or proposals disagree or converge. The `counterfactual` skill fits a go/no-go, approval, or migration or implementation-plan request for a consequential change that rests on a claim nobody has checked. A person can start them with `/metacogs:synthesis` and `/metacogs:counterfactual`.\n");
}
