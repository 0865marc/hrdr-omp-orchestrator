import { describe, expect, test } from "bun:test";
import {
  agentName,
  buildLaunchArgs,
  loadRoleRegistry,
  validateRoleRegistry,
} from "../lib/roles.mjs";

describe("role registry", () => {
  test("loads the shipped four-role configuration", () => {
    const registry = loadRoleRegistry();
    expect(Object.keys(registry.roles)).toEqual([
      "orchestrator",
      "scouter",
      "builder",
      "reviewer",
    ]);
    expect(registry.roles.orchestrator.spawnable).toBe(false);
    expect(registry.roles.scouter.spawnable).toBe(true);
    expect({
      orchestrator: [
        registry.roles.orchestrator.model,
        registry.roles.orchestrator.reasoning,
      ],
      scouter: [registry.roles.scouter.model, registry.roles.scouter.reasoning],
      builder: [registry.roles.builder.model, registry.roles.builder.reasoning],
      reviewer: [registry.roles.reviewer.model, registry.roles.reviewer.reasoning],
    }).toEqual({
      orchestrator: ["openai-codex/gpt-5.6-sol", "max"],
      scouter: ["openai-codex/gpt-5.6-terra", "medium"],
      builder: ["openai-codex/gpt-5.6-sol", "medium"],
      reviewer: ["openai-codex/gpt-5.6-sol", "high"],
    });
  });

  test("builds an explicit standard OMP launch", () => {
    const role = loadRoleRegistry().roles.scouter;
    expect(buildLaunchArgs(role)).toEqual([
      "--profile",
      "herdr-scouter",
      "--model",
      "openai-codex/gpt-5.6-terra",
      "--thinking",
      "medium",
    ]);
  });

  test("rejects an unsupported harness instead of silently falling back", () => {
    const registry = structuredClone(loadRoleRegistry());
    registry.roles.builder.harness = "claude";
    expect(() => validateRoleRegistry(registry)).toThrow("builder.harness");
  });

  test("rejects a spawnable orchestrator", () => {
    const registry = structuredClone(loadRoleRegistry());
    registry.roles.orchestrator.spawnable = true;
    expect(() => validateRoleRegistry(registry)).toThrow("orchestrator must not be spawnable");
  });

  test("derives stable workflow-local Herdr names", () => {
    expect(agentName("scouter", "w1:p1")).toBe(agentName("scouter", "w1:p1"));
    expect(agentName("scouter", "w1:p1")).not.toBe(agentName("scouter", "w1:p2"));
    expect(agentName("scouter", "w1:p1")).toMatch(/^oh-scout-[a-f0-9]{8}$/);
  });
});
