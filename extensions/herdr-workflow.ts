import { randomUUID } from "node:crypto";
import type {
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import {
  agentName,
  buildLaunchArgs,
  loadRoleRegistry,
  roleSkillName,
} from "../lib/roles.mjs";

type JsonRecord = Record<string, unknown>;

const registry = loadRoleRegistry();
const orchestrator = registry.roles.orchestrator;
const ALLOWED_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  glob: true,
  ask: true,
  todo: true,
  herdr_orchestrate: true,
};
const FORBIDDEN_TOOLS: Record<string, true> = {
  bash: true,
  edit: true,
  write: true,
  task: true,
  lsp: true,
  ast_edit: true,
  debug: true,
  browser: true,
};

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelSelector(value: unknown): string | undefined {
  if (!isJsonRecord(value)) return undefined;
  const provider = value.provider;
  const id = value.id;
  if (typeof provider !== "string" || typeof id !== "string") return undefined;
  return `${provider}/${id}`;
}

function nestedValue(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isJsonRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function nestedRecord(value: unknown, ...path: string[]): JsonRecord | undefined {
  const candidate = nestedValue(value, ...path);
  return isJsonRecord(candidate) ? candidate : undefined;
}

function nestedString(value: unknown, ...path: string[]): string | undefined {
  const candidate = nestedValue(value, ...path);
  return typeof candidate === "string" ? candidate : undefined;
}

class HerdrError extends Error {
  details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "HerdrError";
    this.details = details;
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new HerdrError(`${label} returned invalid JSON`, {
      text,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function commandError(result: ExecResult, args: string[]): HerdrError {
  let payload: unknown;
  const raw = String(result.stderr || result.stdout || "").trim();
  if (raw.length > 0) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
  }
  return new HerdrError(`herdr ${args.join(" ")} failed with exit code ${result.code}`, {
    args,
    code: result.code,
    killed: result.killed,
    payload,
  });
}

export default function herdrWorkflow(pi: ExtensionAPI): void {
  const z = pi.zod;

  pi.setLabel("Herdr Orchestrator");
  let workflowReady = false;
  let workflowFailure = `configured orchestrator model ${orchestrator.model} has not been activated`;
  let activatedModelSelector: string | undefined;


  async function execHerdr(
    args: string[],
    ctx: ExtensionContext,
    signal?: AbortSignal,
    timeout = 30_000,
  ): Promise<ExecResult> {
    const result = await pi.exec("herdr", args, {
      cwd: ctx.cwd,
      signal,
      timeout,
    });
    if (result.code !== 0 || result.killed) {
      throw commandError(result, args);
    }
    return result;
  }

  async function execHerdrJson(
    args: string[],
    ctx: ExtensionContext,
    signal?: AbortSignal,
    timeout = 30_000,
  ): Promise<unknown> {
    const result = await execHerdr(args, ctx, signal, timeout);
    return parseJson(result.stdout, `herdr ${args.join(" ")}`);
  }

  async function getAgent(
    name: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<unknown | undefined> {
    const result = await pi.exec("herdr", ["agent", "get", name], {
      cwd: ctx.cwd,
      signal,
      timeout: 10_000,
    });
    if (result.code !== 0 || result.killed) return undefined;
    return parseJson(result.stdout, `herdr agent get ${name}`);
  }

  async function callerPane(
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<{ paneId: string }> {
    const payload = await execHerdrJson(["pane", "current", "--current"], ctx, signal, 10_000);
    const paneId = nestedString(payload, "result", "pane", "pane_id");
    if (!paneId) throw new HerdrError("Herdr did not return the current pane", payload);
    return { paneId };
  }

  async function splitForRole(
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<{ paneId: string }> {
    const pane = await callerPane(ctx, signal);
    const layoutPayload = await execHerdrJson(
      ["pane", "layout", "--pane", pane.paneId],
      ctx,
      signal,
      10_000,
    );
    const panes = nestedValue(layoutPayload, "result", "layout", "panes");
    const currentPane = Array.isArray(panes)
      ? panes.find(
          (candidate: unknown) =>
            isJsonRecord(candidate) && candidate.pane_id === pane.paneId,
        )
      : undefined;
    const width = nestedValue(currentPane, "rect", "width");
    const direction = typeof width === "number" && width >= 100 ? "right" : "down";
    const splitPayload = await execHerdrJson(
      [
        "pane",
        "split",
        "--pane",
        pane.paneId,
        "--direction",
        direction,
        "--cwd",
        ctx.cwd,
        "--no-focus",
      ],
      ctx,
      signal,
      15_000,
    );
    const childPaneId = nestedString(splitPayload, "result", "pane", "pane_id");
    if (!childPaneId) {
      throw new HerdrError("Herdr did not return the split pane", splitPayload);
    }
    return { paneId: childPaneId };
  }

  async function ensureAgent(
    roleName: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    const role = registry.roles[roleName];
    if (!role?.spawnable) throw new HerdrError(`role ${roleName} is not spawnable`);

    const caller = await callerPane(ctx, signal);
    const name = agentName(roleName, caller.paneId);
    const existing = await getAgent(name, ctx, signal);
    if (existing) {
      const paneId = nestedString(existing, "result", "agent", "pane_id");
      if (!paneId) {
        throw new HerdrError(`Herdr did not return a pane for ${name}`, existing);
      }
      return { name, paneId, created: false, payload: existing };
    }

    const split = await splitForRole(ctx, signal);
    const args = [
      "agent",
      "start",
      name,
      "--kind",
      role.harness,
      "--pane",
      split.paneId,
      "--timeout",
      "30000",
      "--",
      ...buildLaunchArgs(role),
    ];
    const payload = await execHerdrJson(args, ctx, signal, 40_000);
    return { name, paneId: split.paneId, created: true, payload };
  }

  async function readAgent(
    name: string,
    lines: number,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await execHerdr(
      ["agent", "read", name, "--source", "recent-unwrapped", "--lines", String(lines)],
      ctx,
      signal,
      30_000,
    );
    return result.stdout;
  }

  async function delegate(
    roleName: string,
    prompt: string,
    lines: number,
    timeoutMs: number,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    const ensured = await ensureAgent(roleName, ctx, signal);
    const completionNonce = randomUUID().slice(0, 8);
    const completionMarker = `OH_DONE_${completionNonce}`;
    const rolePrompt = [
      `You are the ${roleName} role in an OMP workflow managed through Herdr.`,
      `Read skill://${roleSkillName(roleName)} before acting.`,
      "Complete the following self-contained assignment and finish with a concise evidence report:",
      "",
      prompt,
      "",
      "End your final response with the exact marker formed by concatenating these fragments with no spaces:",
      `"OH_DONE_" and "${completionNonce}"`,
    ].join("\n");

    const promptArgs = [
      "agent",
      "prompt",
      ensured.name,
      rolePrompt,
      "--wait",
      "--timeout",
      String(timeoutMs),
    ];
    const promptResult = await pi.exec("herdr", promptArgs, {
      cwd: ctx.cwd,
      signal,
      timeout: timeoutMs + 5_000,
    });

    let warning: unknown;
    if (promptResult.code !== 0 || promptResult.killed) {
      const error = commandError(promptResult, promptArgs);
      const code = nestedString(error.details, "payload", "error", "code");
      if (code !== "agent_prompt_stalled") throw error;
      warning = error.details;
      await execHerdr(
        ["agent", "send-keys", ensured.name, "enter"],
        ctx,
        signal,
        10_000,
      );
    }

    await execHerdr(
      [
        "pane",
        "wait-output",
        ensured.paneId,
        "--match",
        completionMarker,
        "--source",
        "recent-unwrapped",
        "--lines",
        "300",
        "--timeout",
        String(timeoutMs),
      ],
      ctx,
      signal,
      timeoutMs + 5_000,
    );

    const [status, transcript] = await Promise.all([
      getAgent(ensured.name, ctx, signal),
      readAgent(ensured.name, lines, ctx, signal),
    ]);
    return {
      role: roleName,
      agent: ensured.name,
      created: ensured.created,
      state: nestedString(status, "result", "agent", "agent_status") ?? "unknown",
      transcript,
      warning,
    };
  }

  pi.on("session_start", async (_event, ctx) => {
    workflowReady = false;
    activatedModelSelector = undefined;
    workflowFailure = `configured orchestrator model ${orchestrator.model} has not been activated`;
    try {
      const model = ctx.models.resolve(orchestrator.model);
      if (!model) {
        throw new HerdrError(`configured orchestrator model is unavailable: ${orchestrator.model}`);
      }
      const resolvedSelector = modelSelector(model);
      if (resolvedSelector !== orchestrator.model) {
        throw new HerdrError(
          `configured orchestrator model resolved unexpectedly: ${resolvedSelector || "unknown"}`,
        );
      }
      const changed = await pi.setModel(model);
      if (!changed) {
        throw new HerdrError(
          `configured orchestrator model could not be activated: ${orchestrator.model}`,
        );
      }
      activatedModelSelector = resolvedSelector;

      pi.setThinkingLevel(orchestrator.reasoning);
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      await pi.setActiveTools(
        Object.keys(ALLOWED_TOOLS).filter((name) => available.has(name)),
      );
      workflowReady = true;
      workflowFailure = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      workflowFailure = `Herdr workflow unavailable: ${message}`;
      if (ctx.hasUI) {
        ctx.ui.notify(workflowFailure, "error");
        ctx.ui.setStatus("omp-herdr", "Herdr workflow unavailable");
      }
      return;
    }

    const inHerdr = process.env.HERDR_ENV === "1";
    const correctProfile = process.env.OMP_PROFILE === orchestrator.profile;
    if (ctx.hasUI) {
      if (!inHerdr) ctx.ui.notify("Herdr Orchestrator must run inside Herdr", "error");
      if (!correctProfile) {
        ctx.ui.notify(`Expected OMP profile ${orchestrator.profile}`, "error");
      }
      ctx.ui.setStatus(
        "omp-herdr",
        inHerdr && correctProfile ? "Herdr workflow ready" : "Herdr workflow unavailable",
      );
    }
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: [
      ...event.systemPrompt,
      `You are the orchestration-only OMP profile ${orchestrator.profile}. Read skill://herdr-orchestrator before acting. Delegate repository mutations through herdr_orchestrate; never implement directly.`,
    ],
  }));

  pi.on("tool_call", async (event) => {
    if (FORBIDDEN_TOOLS[event.toolName]) {
      return {
        block: true,
        reason: `${event.toolName} is disabled in the Herdr Orchestrator profile; delegate through herdr_orchestrate`,
      };
    }
  });

  pi.registerTool({
    name: "herdr_orchestrate",
    label: "Herdr Orchestrate",
    description:
      "Create or reuse a configured Scouter, Builder, or Reviewer in a Herdr pane; inspect its status or read its terminal evidence.",
    parameters: z.object({
      action: z.enum(["delegate", "status", "read"]),
      role: z.enum(["scouter", "builder", "reviewer"]),
      prompt: z.string().optional(),
      lines: z.number().int().min(20).max(300).optional(),
      timeoutMs: z.number().int().min(5_001).max(600_000).optional(),
    }),
    approval: "exec",
    loadMode: "essential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        if (workflowReady) {
          const currentSelector = modelSelector(ctx.models.current());
          if (
            currentSelector !== orchestrator.model ||
            currentSelector !== activatedModelSelector
          ) {
            workflowReady = false;
            workflowFailure =
              `Herdr workflow unavailable: active model changed from ${orchestrator.model} ` +
              `to ${currentSelector || "none"}`;
            if (ctx.hasUI) {
              ctx.ui.notify(workflowFailure, "error");
              ctx.ui.setStatus("omp-herdr", "Herdr workflow unavailable");
            }
          }
        }
        if (!workflowReady) {
          throw new HerdrError(workflowFailure);
        }
        if (process.env.HERDR_ENV !== "1") {
          throw new HerdrError("not running inside a Herdr-managed pane");
        }
        if (process.env.OMP_PROFILE !== orchestrator.profile) {
          throw new HerdrError(
            `expected OMP profile ${orchestrator.profile}, found ${process.env.OMP_PROFILE || "default"}`,
          );
        }

        const roleName = params.role;
        const lines = params.lines ?? 120;
        if (params.action === "delegate") {
          if (!params.prompt?.trim()) {
            throw new HerdrError("delegate requires a non-empty prompt");
          }
          const result = await delegate(
            roleName,
            params.prompt.trim(),
            lines,
            params.timeoutMs ?? 120_000,
            ctx,
            signal,
          );
          const warning = result.warning
            ? "\n\nWarning: Herdr missed the initial lifecycle transition; completion was confirmed by the per-turn terminal marker."
            : "";
          return {
            content: [
              {
                type: "text",
                text:
                  `Role: ${result.role}\nAgent: ${result.agent}\nState: ${result.state}\n` +
                  `Created: ${result.created}\n\n${result.transcript}${warning}`,
              },
            ],
            details: result,
          };
        }

        const caller = await callerPane(ctx, signal);
        const name = agentName(roleName, caller.paneId);
        if (params.action === "status") {
          const status = await getAgent(name, ctx, signal);
          if (!status) throw new HerdrError(`no live ${roleName} agent exists for this orchestrator`);
          const agent = nestedRecord(status, "result", "agent") ?? status;
          return {
            content: [{ type: "text", text: JSON.stringify(agent, null, 2) }],
            details: status,
          };
        }

        const transcript = await readAgent(name, lines, ctx, signal);
        return {
          content: [{ type: "text", text: transcript }],
          details: { role: roleName, agent: name, lines },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: error instanceof HerdrError ? error.details : undefined,
          isError: true,
        };
      }
    },
  });
}
