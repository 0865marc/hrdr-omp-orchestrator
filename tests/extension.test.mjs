import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import herdrWorkflow from "../extensions/herdr-workflow.ts";

function schemaNode() {
  return {
    optional() {
      return this;
    },
    int() {
      return this;
    },
    min() {
      return this;
    },
    max() {
      return this;
    },
  };
}

function jsonResult(value) {
  return { stdout: JSON.stringify(value), stderr: "", code: 0, killed: false };
}

function createHarness(options = {}) {
  const calls = [];
  const handlers = new Map();
  const modelEvents = [];
  const activeToolEvents = [];
  const thinkingEvents = [];
  const uiEvents = [];
  let currentModel;
  let tool;
  let started = false;
  const pi = {
    zod: {
      object: schemaNode,
      enum: schemaNode,
      string: schemaNode,
      number: schemaNode,
    },
    setLabel() {},
    registerTool(definition) {
      tool = definition;
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    getAllTools() {
      return [
        { name: "read" },
        { name: "grep" },
        { name: "glob" },
        { name: "ask" },
        { name: "todo" },
        { name: "herdr_orchestrate" },
      ];
    },
    async setActiveTools(tools) {
      activeToolEvents.push(tools);
    },
    async setModel(model) {
      modelEvents.push(["set", model]);
      if (options.setModelThrows) throw new Error("setModel failed");
      const result = options.setModelResult ?? true;
      if (result) currentModel = model;
      return result;
    },
    setThinkingLevel(level) {
      thinkingEvents.push(level);
    },
    async exec(command, args) {
      calls.push([command, ...args]);
      const operation = args.slice(0, 2).join(" ");
      if (operation === "pane current") {
        return jsonResult({ result: { pane: { pane_id: "w1:p1" } } });
      }
      if (operation === "pane layout") {
        return jsonResult({
          result: {
            layout: {
              panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 40 } }],
            },
          },
        });
      }
      if (operation === "pane split") {
        return jsonResult({ result: { pane: { pane_id: "w1:p2" } } });
      }
      if (operation === "agent get") {
        if (!started) return { stdout: "", stderr: "not found", code: 1, killed: false };
        return jsonResult({ result: { agent: { agent_status: "done" } } });
      }
      if (operation === "agent start") {
        started = true;
        return jsonResult({ result: { agent: { agent_status: "idle" } } });
      }
      if (operation === "agent prompt") {
        if (options.stallPrompt) {
          return {
            stdout: "",
            stderr: JSON.stringify({
              error: { code: "agent_prompt_stalled", message: "no observed state change" },
            }),
            code: 1,
            killed: false,
          };
        }
        return jsonResult({ result: { agent: { agent_status: "done" } } });
      }
      if (operation === "agent send-keys" || operation === "pane wait-output") {
        return jsonResult({ result: { type: "ok" } });
      }
      if (operation === "agent read") {
        return { stdout: "SCOUTER_EVIDENCE", stderr: "", code: 0, killed: false };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  herdrWorkflow(pi);
  const sessionContext = {
    cwd: "/repo",
    hasUI: true,
    models: {
      resolve(selector) {
        modelEvents.push(["resolve", selector]);
        if (options.resolveThrows) throw new Error("resolve failed");
        if (Object.hasOwn(options, "resolveResult")) return options.resolveResult;
        return { provider: "openai-codex", id: "gpt-5.6-sol" };
      },
      current() {
        return currentModel;
      },
    },
    ui: {
      notify(message, level) {
        uiEvents.push(["notify", message, level]);
      },
      setStatus(key, value) {
        uiEvents.push(["status", key, value]);
      },
    },
  };
  return {
    calls,
    handlers,
    modelEvents,
    activeToolEvents,
    thinkingEvents,
    uiEvents,
    context: sessionContext,
    changeModel(model) {
      currentModel = model;
    },
    getTool: () => tool,
    startSession: () => handlers.get("session_start")({}, sessionContext),
  };
}

const originalHerdrEnv = process.env.HERDR_ENV;
const originalProfile = process.env.OMP_PROFILE;

beforeEach(() => {
  process.env.HERDR_ENV = "1";
  process.env.OMP_PROFILE = "herdr-orchestrator";
});

afterEach(() => {
  if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = originalHerdrEnv;
  if (originalProfile === undefined) delete process.env.OMP_PROFILE;
  else process.env.OMP_PROFILE = originalProfile;
});

describe("Herdr extension", () => {
  test("delegates Scouter with the configured profile, model, and reasoning", async () => {
    const harness = createHarness();
    await harness.startSession();
    const result = await harness.getTool().execute(
      "call-1",
      {
        action: "delegate",
        role: "scouter",
        prompt: "Map the authentication flow.",
        lines: 80,
        timeoutMs: 30_000,
      },
      undefined,
      undefined,
      harness.context,
    );

    const start = harness.calls.find(
      (args) => args[1] === "agent" && args[2] === "start",
    );
    expect(start).toContain("--profile");
    expect(start).toContain("herdr-scouter");
    expect(start).toContain("openai-codex/gpt-5.6-luna");
    expect(start).toContain("--thinking");
    expect(start).toContain("max");
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("SCOUTER_EVIDENCE");
    expect(result.content[0].text).toContain("State: done");

    const promptCall = harness.calls.find(
      (args) => args[1] === "agent" && args[2] === "prompt",
    );
    const waitCall = harness.calls.find(
      (args) => args[1] === "pane" && args[2] === "wait-output",
    );
    const marker = waitCall[waitCall.indexOf("--match") + 1];
    expect(promptCall[4]).not.toContain(marker);
    expect(marker).toMatch(/^OH_DONE_[a-f0-9]{8}$/);
  });

  test("recovers a stalled OMP prompt and waits for its completion marker", async () => {
    const harness = createHarness({ stallPrompt: true });
    await harness.startSession();
    const result = await harness.getTool().execute(
      "call-stalled",
      {
        action: "delegate",
        role: "scouter",
        prompt: "Inspect the release version.",
        timeoutMs: 30_000,
      },
      undefined,
      undefined,
      harness.context,
    );

    const sendKeys = harness.calls.find(
      (args) => args[1] === "agent" && args[2] === "send-keys",
    );
    const waitOutput = harness.calls.find(
      (args) => args[1] === "pane" && args[2] === "wait-output",
    );
    expect(sendKeys.at(-1)).toBe("enter");
    expect(waitOutput).toContain("--match");
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("completion was confirmed");
  });

  test("blocks delegation outside Herdr", async () => {
    delete process.env.HERDR_ENV;
    const harness = createHarness();
    await harness.startSession();
    const result = await harness.getTool().execute(
      "call-2",
      { action: "status", role: "scouter" },
      undefined,
      undefined,
      harness.context,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not running inside");
    expect(harness.calls).toHaveLength(0);
  });

  test("activates the mandatory orchestrator model before workflow tools", async () => {
    const harness = createHarness();
    await harness.startSession();

    expect(harness.modelEvents).toEqual([
      ["resolve", "openai-codex/gpt-5.6-sol"],
      ["set", { provider: "openai-codex", id: "gpt-5.6-sol" }],
    ]);
    expect(harness.thinkingEvents).toEqual(["max"]);
    expect(harness.activeToolEvents).toEqual([
      ["read", "grep", "glob", "ask", "todo", "herdr_orchestrate"],
    ]);
    expect(harness.uiEvents).toContainEqual([
      "status",
      "omp-herdr",
      "Herdr workflow ready",
    ]);
  });

  test.each([
    ["resolve failure", { resolveThrows: true }, "resolve failed"],
    ["unavailable model", { resolveResult: undefined }, "model is unavailable"],
    ["setModel rejection", { setModelResult: false }, "could not be activated"],
    ["setModel failure", { setModelThrows: true }, "setModel failed"],
  ])("rejects workflow actions after %s", async (_name, options, expected) => {
    const harness = createHarness(options);
    await harness.startSession();
    const result = await harness.getTool().execute(
      "model-failure",
      { action: "status", role: "scouter" },
      undefined,
      undefined,
      harness.context,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(expected);
    expect(harness.thinkingEvents).toEqual([]);
    expect(harness.activeToolEvents).toEqual([]);
    expect(harness.calls).toEqual([]);
    expect(harness.uiEvents).toContainEqual([
      "status",
      "omp-herdr",
      "Herdr workflow unavailable",
    ]);
  });

  test("rejects the next workflow action after the active model drifts", async () => {
    const harness = createHarness();
    await harness.startSession();
    harness.changeModel({ provider: "openai-codex", id: "gpt-5.6-terra" });

    const result = await harness.getTool().execute(
      "model-drift",
      { action: "status", role: "scouter" },
      undefined,
      undefined,
      harness.context,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "active model changed from openai-codex/gpt-5.6-sol to openai-codex/gpt-5.6-terra",
    );
    expect(harness.calls).toEqual([]);
    expect(harness.uiEvents.at(-1)).toEqual([
      "status",
      "omp-herdr",
      "Herdr workflow unavailable",
    ]);
  });
});
