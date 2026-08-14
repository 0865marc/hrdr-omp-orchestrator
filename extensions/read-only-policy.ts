import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const READ_ONLY_TOOLS: Record<string, true> = Object.freeze({
  read: true,
  grep: true,
  glob: true,
  inspect_image: true,
  ask: true,
  todo: true,
});

export function readOnlyToolPolicy(toolName: string) {
  if (READ_ONLY_TOOLS[toolName]) return undefined;
  return {
    block: true,
    reason: `${toolName} is not in the omp-herdr read-only tool allowlist`,
  };
}

export default function readOnlyPolicy(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => readOnlyToolPolicy(event.toolName));
}
