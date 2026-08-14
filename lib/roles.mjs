import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const REQUIRED_ROLES = ["orchestrator", "scouter", "builder", "reviewer"];
const REASONING_LEVELS = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
};
const SUPPORTED_HARNESSES = { omp: true };
const PROFILE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export const DEFAULT_REGISTRY_URL = new URL("../config/roles.json", import.meta.url);

function fail(message) {
  throw new Error(`invalid role registry: ${message}`);
}

export function validateRoleRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("root must be an object");
  }
  if (value.schemaVersion !== 1) {
    fail(`unsupported schemaVersion ${String(value.schemaVersion)}`);
  }
  if (!value.roles || typeof value.roles !== "object" || Array.isArray(value.roles)) {
    fail("roles must be an object");
  }

  const profiles = new Set();
  for (const roleName of REQUIRED_ROLES) {
    const role = value.roles[roleName];
    if (!role || typeof role !== "object" || Array.isArray(role)) {
      fail(`missing role ${roleName}`);
    }
    if (!SUPPORTED_HARNESSES[role.harness]) {
      fail(`${roleName}.harness must be one of ${Object.keys(SUPPORTED_HARNESSES).join(", ")}`);
    }
    if (typeof role.profile !== "string" || !PROFILE_PATTERN.test(role.profile)) {
      fail(`${roleName}.profile is malformed`);
    }
    if (profiles.has(role.profile)) {
      fail(`profile ${role.profile} is assigned more than once`);
    }
    profiles.add(role.profile);
    if (typeof role.model !== "string" || role.model.trim() !== role.model || role.model.length === 0) {
      fail(`${roleName}.model must be a non-empty trimmed string`);
    }
    if (!REASONING_LEVELS[role.reasoning]) {
      fail(`${roleName}.reasoning is unsupported`);
    }
    if (typeof role.spawnable !== "boolean") {
      fail(`${roleName}.spawnable must be boolean`);
    }
  }

  if (value.roles.orchestrator.spawnable) {
    fail("orchestrator must not be spawnable");
  }
  for (const roleName of REQUIRED_ROLES.slice(1)) {
    if (!value.roles[roleName].spawnable) {
      fail(`${roleName} must be spawnable`);
    }
  }

  const extras = Object.keys(value.roles).filter((name) => !REQUIRED_ROLES.includes(name));
  if (extras.length > 0) {
    fail(`unknown roles: ${extras.join(", ")}`);
  }
  return value;
}

export function loadRoleRegistry(source = DEFAULT_REGISTRY_URL) {
  const raw = readFileSync(source, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateRoleRegistry(parsed);
}

export function buildLaunchArgs(role) {
  if (role.harness !== "omp") {
    throw new Error(`unsupported harness: ${role.harness}`);
  }
  return [
    "--profile",
    role.profile,
    "--model",
    role.model,
    "--thinking",
    role.reasoning,
  ];
}

export function roleSkillName(roleName) {
  if (!REQUIRED_ROLES.includes(roleName)) {
    throw new Error(`unknown role: ${roleName}`);
  }
  return `herdr-${roleName}`;
}

export function agentName(roleName, callerPaneId) {
  if (!REQUIRED_ROLES.slice(1).includes(roleName)) {
    throw new Error(`role is not spawnable: ${roleName}`);
  }
  if (typeof callerPaneId !== "string" || callerPaneId.length === 0) {
    throw new Error("caller pane id is unavailable");
  }
  const suffix = createHash("sha256").update(callerPaneId).digest("hex").slice(0, 8);
  const prefixes = { scouter: "scout", builder: "build", reviewer: "review" };
  return `oh-${prefixes[roleName]}-${suffix}`;
}

export const ROLE_NAMES = Object.freeze([...REQUIRED_ROLES]);
export const SPAWNABLE_ROLE_NAMES = Object.freeze(REQUIRED_ROLES.slice(1));

if (import.meta.main) {
  const source = process.argv[2] || DEFAULT_REGISTRY_URL;
  try {
    loadRoleRegistry(source);
    process.stdout.write(`Role registry valid: ${String(source)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
