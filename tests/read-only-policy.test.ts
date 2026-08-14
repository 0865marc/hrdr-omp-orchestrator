import { describe, expect, test } from "bun:test";
import readOnlyPolicy from "../extensions/read-only-policy.ts";

describe("read-only role policy", () => {
  test("allows exploration and denies every non-allowlisted tool", () => {
    let callback: ((event: { toolName: string }) => unknown) | undefined;
    readOnlyPolicy({
      on(event: string, handler: (event: { toolName: string }) => unknown) {
        expect(event).toBe("tool_call");
        callback = handler;
      },
    } as never);

    expect(callback?.({ toolName: "read" })).toBeUndefined();
    for (const toolName of [
      "edit",
      "write",
      "bash",
      "python",
      "notebook",
      "future_unknown_tool",
    ]) {
      expect(callback?.({ toolName: toolName })).toEqual({
        block: true,
        reason: `${toolName} is not in the omp-herdr read-only tool allowlist`,
      });
    }
  });
});
