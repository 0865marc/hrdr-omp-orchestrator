import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const releaseVersion = readFileSync(join(projectRoot, "VERSION"), "utf8").trim();


const ompShim = String.raw`#!/bin/sh
set -eu
profile=default
if [ "${"$"}{1:-}" = --profile ]; then
  profile=$2
  shift 2
fi
printf '%s\n' "$profile:$*" >> "$FAKE_STATE/omp.log"
case ${"$"}{1:-} in
  --version)
    printf '%s\n' 'omp/17.3.0'
    ;;
  config)
    action=${"$"}{2:-}
    key=${"$"}{3:-}
    config_dir=$FAKE_STATE/config/$profile
    config_file=$config_dir/$key
    case $action in
      path)
        if [ "$profile" = default ]; then
          printf '%s\n' "$HOME/.omp/agent"
        else
          printf '%s\n' "$HOME/.omp/profiles/$profile/agent"
        fi
        ;;
      set)
        value=${"$"}{4:-}
        entry=$profile:$key
        if [ "${"$"}{FAIL_SET_ENTRY:-}" = "$entry" ] && [ ! -f "$FAKE_STATE/failure-fired" ]; then
          : > "$FAKE_STATE/failure-fired"
          exit 1
        fi
        mkdir -p "$config_dir"
        printf '%s' "$value" > "$config_file"
        ;;
      get)
        [ -f "$config_file" ] || exit 1
        cat "$config_file"
        ;;
      reset)
        rm -f "$config_file"
        ;;
      *) exit 2 ;;
    esac
    ;;
  auth-broker)
    case ${"$"}{2:-} in
      token) printf '%s\n' 'test-broker-token' ;;
      status)
        printf 'health:%s|%s\n' \
          "${"$"}{OMP_AUTH_BROKER_URL:-unset}" \
          "${"$"}{OMP_AUTH_BROKER_TOKEN:-unset}" >> "$FAKE_STATE/health.log"
        [ -f "$FAKE_STATE/broker-ready" ] || exit 1
        printf '%s\n' '{"ok":true}'
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`;

const herdrShim = String.raw`#!/bin/sh
set -eu
case ${"$"}{1:-} in
  --version)
    printf '%s\n' 'herdr 0.8.0'
    ;;
  integration)
    action=${"$"}{2:-}
    extension=$HOME/$PI_CONFIG_DIR/agent/extensions/herdr-omp-agent-state.ts
    case $action in
      install)
        [ "${"$"}{3:-}" = omp ] || exit 2
        mkdir -p "$(dirname "$extension")"
        printf '%s\n' '// fake Herdr integration' > "$extension"
        printf 'install:%s\n' "$extension" >> "$FAKE_STATE/herdr.log"
        ;;
      uninstall)
        [ "${"$"}{3:-}" = omp ] || exit 2
        rm -f "$extension"
        printf 'uninstall:%s\n' "$extension" >> "$FAKE_STATE/herdr.log"
        ;;
      status)
        if [ -f "$extension" ]; then
          printf 'omp: current (%s)\n' "$extension"
        else
          printf 'omp: not installed (%s)\n' "$extension"
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`;

const systemctlShim = String.raw`#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_STATE/systemctl.log"
[ "${"$"}{1:-}" = --user ] && shift
case ${"$"}{1:-} in
  show-environment|daemon-reload) ;;
  is-active)
    [ -f "$FAKE_STATE/service-active" ]
    ;;
  enable|start)
    : > "$FAKE_STATE/service-active"
    : > "$FAKE_STATE/broker-ready"
    ;;
  stop|disable)
    rm -f "$FAKE_STATE/service-active" "$FAKE_STATE/broker-ready"
    ;;
  status) ;;
  *) exit 2 ;;
esac
`;

const ssShim = String.raw`#!/bin/sh
set -eu
printf '%s\n' 'State Recv-Q Send-Q Local Address:Port Peer Address:Port'
if [ -f "$FAKE_STATE/port-in-use" ]; then
  printf '%s\n' 'LISTEN 0 128 127.0.0.1:8765 0.0.0.0:*'
fi
`;

interface Sandbox {
  root: string;
  home: string;
  state: string;
  installRoot: string;
  binDir: string;
  env: Record<string, string>;
}

function executable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "omp-herdr scripts "));
  const home = join(root, "home with spaces");
  const state = join(root, "state");
  const fakeBin = join(root, "fake bin");
  const installRoot = join(root, "payload with spaces");
  const binDir = join(root, "command links");
  const temp = join(root, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(temp, { recursive: true });
  executable(join(fakeBin, "omp"), ompShim);
  executable(join(fakeBin, "herdr"), herdrShim);
  executable(join(fakeBin, "systemctl"), systemctlShim);
  executable(join(fakeBin, "ss"), ssShim);
  executable(join(fakeBin, "uname"), "#!/bin/sh\nprintf '%s\\n' Linux\n");
  executable(join(fakeBin, "sleep"), "#!/bin/sh\nexit 0\n");
  return {
    root,
    home,
    state,
    installRoot,
    binDir,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "config with spaces"),
      XDG_DATA_HOME: join(root, "data with spaces"),
      OMP_HERDR_HOME: installRoot,
      OMP_BIN_DIR: binDir,
      TMPDIR: temp,
      FAKE_STATE: state,
    } as Record<string, string>,
  };
}

function runScript(sandbox: Sandbox, script: string, args: string[] = [], env = {}) {
  return spawnSync("sh", [join(projectRoot, "scripts", script), ...args], {
    cwd: projectRoot,
    env: { ...sandbox.env, ...env },
    encoding: "utf8",
  });
}

function profileAgentDir(sandbox: Sandbox, profile: string) {
  return join(sandbox.home, ".omp", "profiles", profile, "agent");
}

function configPath(sandbox: Sandbox, profile: string, key: string) {
  return join(sandbox.state, "config", profile, key);
}

function writeConfig(sandbox: Sandbox, profile: string, key: string, value: string) {
  const path = configPath(sandbox, profile, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function configSnapshot(sandbox: Sandbox) {
  const root = join(sandbox.state, "config");
  const result: Record<string, string> = {};
  if (!readdirSafe(root).length) return result;
  for (const profile of readdirSync(root)) {
    const profileRoot = join(root, profile);
    for (const key of readdirSync(profileRoot)) {
      result[`${profile}:${key}`] = readFileSync(join(profileRoot, key), "utf8");
    }
  }
  return result;
}

function readdirSafe(path: string) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function cleanup(sandbox: Sandbox) {
  rmSync(sandbox.root, { recursive: true, force: true });
}

const profiles = [
  "herdr-orchestrator",
  "herdr-scouter",
  "herdr-builder",
  "herdr-reviewer",
];

function manifestContents(release: string) {
  return [
    "omp-herdr-installation",
    "manifest-version=2",
    `profiles=${profiles.join(" ")}`,
    "keys=setupVersion startup.setupWizard skills.customDirectories skills.includeSkills extensions tools.approval bash.enabled eval.py eval.js browser.enabled web_search.enabled",
    "profile-marker=.omp-herdr-profile",
    `release=${release}`,
    "",
  ].join("\n");
}

function installOrThrow(sandbox: Sandbox) {
  const result = runScript(sandbox, "install.sh");
  if (result.status !== 0) {
    throw new Error(
      JSON.stringify({
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        omp: readFileSync(join(sandbox.state, "omp.log"), "utf8"),
      }),
    );
  }
  return result;
}

describe("installer ownership and profile safety", () => {
  test("rejects an unowned payload root without changing its sentinel", () => {
    const sandbox = createSandbox();
    try {
      mkdirSync(sandbox.installRoot, { recursive: true });
      const sentinel = join(sandbox.installRoot, "sentinel.bin");
      const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
      writeFileSync(sentinel, bytes);

      const result = runScript(sandbox, "install.sh");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unowned");
      expect(readFileSync(sentinel)).toEqual(bytes);
      expect(readdirSafe(join(sandbox.state, "config"))).toEqual([]);
    } finally {
      cleanup(sandbox);
    }
  });

  test("rejects a pre-existing profile before creating the payload", () => {
    const sandbox = createSandbox();
    try {
      const agentDir = profileAgentDir(sandbox, "herdr-reviewer");
      mkdirSync(agentDir, { recursive: true });
      const sentinel = join(agentDir, "foreign-setting");
      writeFileSync(sentinel, "keep-me");

      const result = runScript(sandbox, "install.sh");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("pre-existing OMP profile");
      expect(readFileSync(sentinel, "utf8")).toBe("keep-me");
      expect(readdirSafe(sandbox.installRoot)).toEqual([]);
    } finally {
      cleanup(sandbox);
    }
  });

  test("installs, checks, and uninstalls only owned paths for four profiles", () => {
    const sandbox = createSandbox();
    try {
      const install = installOrThrow(sandbox);
      expect(install.stdout).toContain("Status:           installed");
      const manifest = readFileSync(join(sandbox.installRoot, ".omp-herdr-manifest"), "utf8");
      expect(manifest).toContain("manifest-version=2");
      expect(manifest).toContain(`profiles=${profiles.join(" ")}`);
      expect(manifest).toContain(`release=${releaseVersion}`);
      expect(manifest).toContain("profile-marker=.omp-herdr-profile");
      for (const profile of profiles) {
        expect(
          readFileSync(join(profileAgentDir(sandbox, profile), ".omp-herdr-profile"), "utf8"),
        ).toBe(`omp-herdr-profile\nmanifest-version=2\nprofile=${profile}\n`);
      }

      const integrationPaths = profiles.map((profile) =>
        join(profileAgentDir(sandbox, profile), "extensions", "herdr-omp-agent-state.ts"),
      );
      for (const path of integrationPaths) {
        expect(readFileSync(path, "utf8")).toContain("fake Herdr");
      }
      const installCalls = readFileSync(join(sandbox.state, "herdr.log"), "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("install:"));
      expect(installCalls).toEqual(integrationPaths.map((path) => `install:${path}`));

      writeConfig(sandbox, "herdr-scouter", "custom.keep", "foreign-value");
      const update = runScript(sandbox, "install.sh");
      expect(update.status, `${update.stdout}\n${update.stderr}`).toBe(0);
      expect(readFileSync(configPath(sandbox, "herdr-scouter", "custom.keep"), "utf8")).toBe(
        "foreign-value",
      );
      expect(readFileSync(configPath(sandbox, "herdr-scouter", "extensions"), "utf8")).toContain(
        "read-only-policy.ts",
      );
      expect(readFileSync(configPath(sandbox, "herdr-builder", "extensions"), "utf8")).toBe("[]");
      expect(
        JSON.parse(
          readFileSync(
            configPath(sandbox, "herdr-orchestrator", "tools.approval"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        task: "deny",
        hub: "deny",
        eval: "deny",
        launch: "deny",
      });
      expect(
        JSON.parse(
          readFileSync(configPath(sandbox, "herdr-builder", "tools.approval"), "utf8"),
        ),
      ).toEqual({ task: "deny" });

      const check = runScript(sandbox, "check.sh");
      expect(check.status).toBe(0);
      expect(check.stdout).toContain("OMP integrations: current for 4 profiles");

      const payloadSentinel = join(sandbox.installRoot, "foreign.bin");
      const sentinelBytes = Buffer.from([9, 8, 7, 0, 6]);
      writeFileSync(payloadSentinel, sentinelBytes);

      const uninstall = runScript(sandbox, "uninstall.sh");
      expect(uninstall.status).toBe(0);
      expect(readFileSync(payloadSentinel)).toEqual(sentinelBytes);
      expect(readFileSync(configPath(sandbox, "herdr-scouter", "custom.keep"), "utf8")).toBe(
        "foreign-value",
      );
      expect(readdirSafe(dirname(configPath(sandbox, "herdr-scouter", "setupVersion")))).not.toContain(
        "setupVersion",
      );
      for (const path of integrationPaths) expect(readdirSafe(dirname(path))).not.toContain("herdr-omp-agent-state.ts");
      expect(readFileSync(join(sandbox.installRoot, ".omp-herdr-uninstalled"), "utf8")).toBe(
        "omp-herdr-uninstalled\nmanifest-version=2\n",
      );

      const second = runScript(sandbox, "uninstall.sh");
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("nothing to remove");
      expect(readFileSync(payloadSentinel)).toEqual(sentinelBytes);
    } finally {
      cleanup(sandbox);
    }
  });

  test("check rejects orchestrator alternative delegation policy drift", () => {
    const sandbox = createSandbox();
    try {
      installOrThrow(sandbox);
      const approvalPath = configPath(
        sandbox,
        "herdr-orchestrator",
        "tools.approval",
      );
      const approval = JSON.parse(readFileSync(approvalPath, "utf8"));
      delete approval.hub;
      writeFileSync(approvalPath, JSON.stringify(approval));

      const result = runScript(sandbox, "check.sh");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "herdr-orchestrator does not deny alternative delegation tool hub",
      );
    } finally {
      cleanup(sandbox);
    }
  });

  test("check rejects an invalid registry through the runtime loader", () => {
    const sandbox = createSandbox();
    try {
      const install = installOrThrow(sandbox);
      const current = realpathSync(join(sandbox.installRoot, "current"));
      const registry = join(current, "config", "roles.json");
      const value = JSON.parse(readFileSync(registry, "utf8"));
      value.schemaVersion = 999;
      writeFileSync(registry, JSON.stringify(value));

      const result = runScript(sandbox, "check.sh");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsupported schemaVersion 999");
      expect(result.stderr).toContain("role registry validation failed");
    } finally {
      cleanup(sandbox);
    }
  });

  test.each([
    ["valid", false],
    ["broken", true],
  ])("rejects a %s manifest symlink without mutation", (_kind, broken) => {
    const sandbox = createSandbox();
    try {
      installOrThrow(sandbox);
      const manifest = join(sandbox.installRoot, ".omp-herdr-manifest");
      const target = join(sandbox.root, "manifest target");
      const original = readFileSync(manifest);
      rmSync(manifest);
      if (!broken) writeFileSync(target, original);
      symlinkSync(target, manifest);
      const currentBefore = readlinkSync(join(sandbox.installRoot, "current"));
      const configBefore = configSnapshot(sandbox);
      const herdrBefore = readFileSync(join(sandbox.state, "herdr.log"), "utf8");

      for (const script of ["install.sh", "uninstall.sh"]) {
        const result = runScript(sandbox, script);
        expect(result.status).not.toBe(0);
      }
      if (!broken) expect(readFileSync(target)).toEqual(original);
      expect(readlinkSync(join(sandbox.installRoot, "current"))).toBe(currentBefore);
      expect(configSnapshot(sandbox)).toEqual(configBefore);
      expect(readFileSync(join(sandbox.state, "herdr.log"), "utf8")).toBe(herdrBefore);
    } finally {
      cleanup(sandbox);
    }
  });

  test.each([
    ["valid", false],
    ["broken", true],
  ])("rejects a %s tombstone symlink", (_kind, broken) => {
    const sandbox = createSandbox();
    try {
      mkdirSync(sandbox.installRoot, { recursive: true });
      const target = join(sandbox.root, "tombstone target");
      if (!broken) writeFileSync(target, "omp-herdr-uninstalled\nmanifest-version=2\n");
      symlinkSync(target, join(sandbox.installRoot, ".omp-herdr-uninstalled"));
      const sentinel = join(sandbox.root, "external sentinel");
      const bytes = Buffer.from([5, 4, 3, 2, 1, 0]);
      writeFileSync(sentinel, bytes);

      expect(runScript(sandbox, "install.sh").status).not.toBe(0);
      expect(runScript(sandbox, "uninstall.sh").status).not.toBe(0);
      expect(readFileSync(sentinel)).toEqual(bytes);
      if (!broken) {
        expect(readFileSync(target, "utf8")).toBe(
          "omp-herdr-uninstalled\nmanifest-version=2\n",
        );
      }
    } finally {
      cleanup(sandbox);
    }
  });

  test("rejects a releases symlink without touching its external sentinel", () => {
    const sandbox = createSandbox();
    try {
      installOrThrow(sandbox);
      const releases = join(sandbox.installRoot, "releases");
      renameSync(releases, join(sandbox.root, "owned releases backup"));
      const external = join(sandbox.root, "external releases");
      mkdirSync(external);
      const sentinel = join(external, "sentinel.bin");
      const bytes = Buffer.from([11, 0, 22, 0, 33]);
      writeFileSync(sentinel, bytes);
      symlinkSync(external, releases);
      const configBefore = configSnapshot(sandbox);

      expect(runScript(sandbox, "install.sh").status).not.toBe(0);
      expect(runScript(sandbox, "uninstall.sh").status).not.toBe(0);
      expect(readFileSync(sentinel)).toEqual(bytes);
      expect(configSnapshot(sandbox)).toEqual(configBefore);
    } finally {
      cleanup(sandbox);
    }
  });

  test.each([".", ".."])("rejects release=%s before touching sentinels", (release) => {
    const sandbox = createSandbox();
    try {
      installOrThrow(sandbox);
      const rootSentinel = join(sandbox.installRoot, "root-sentinel");
      const parentSentinel = join(sandbox.root, "parent-sentinel");
      writeFileSync(rootSentinel, "root-bytes");
      writeFileSync(parentSentinel, "parent-bytes");
      writeFileSync(
        join(sandbox.installRoot, ".omp-herdr-manifest"),
        manifestContents(release),
      );
      const configBefore = configSnapshot(sandbox);

      expect(runScript(sandbox, "install.sh").status).not.toBe(0);
      expect(runScript(sandbox, "uninstall.sh").status).not.toBe(0);
      expect(readFileSync(rootSentinel, "utf8")).toBe("root-bytes");
      expect(readFileSync(parentSentinel, "utf8")).toBe("parent-bytes");
      expect(configSnapshot(sandbox)).toEqual(configBefore);
    } finally {
      cleanup(sandbox);
    }
  });


  test.each([
    ["space", " "],
    ["tab", "\t"],
  ])("rejects a release record containing a %s without mutation", (_kind, separator) => {
    const sandbox = createSandbox();
    try {
      installOrThrow(sandbox);
      const manifest = join(sandbox.installRoot, ".omp-herdr-manifest");
      const current = join(sandbox.installRoot, "current");
      const foreignRelease = join(sandbox.installRoot, "releases", "foreign");
      mkdirSync(foreignRelease);
      const sentinel = join(foreignRelease, "sentinel.bin");
      const sentinelBytes = Buffer.from([19, 0, 91, 10, 255, 7]);
      writeFileSync(sentinel, sentinelBytes);
      writeFileSync(manifest, manifestContents(`${releaseVersion}${separator}foreign`));
      const manifestBefore = readFileSync(manifest);
      const currentBefore = readlinkSync(current);
      const configBefore = configSnapshot(sandbox);

      for (const script of ["install.sh", "check.sh", "uninstall.sh"]) {
        const result = runScript(sandbox, script);
        expect(result.status).not.toBe(0);
      }
      expect(readFileSync(sentinel)).toEqual(sentinelBytes);
      expect(readFileSync(manifest)).toEqual(manifestBefore);
      expect(readlinkSync(current)).toBe(currentBefore);
      expect(configSnapshot(sandbox)).toEqual(configBefore);
    } finally {
      cleanup(sandbox);
    }
  });

  test.each([
    ["NUL", 0],
    ["CR", 13],
  ])("rejects a release record containing %s bytes before mutation", (_kind, byte) => {
    const sandbox = createSandbox();
    try {
      installOrThrow(sandbox);
      const manifest = join(sandbox.installRoot, ".omp-herdr-manifest");
      const current = join(sandbox.installRoot, "current");
      const foreign = join(sandbox.installRoot, "releases", "foreign");
      const foreignSuffix = join(sandbox.installRoot, "releases", "foreignsuffix");
      mkdirSync(foreign);
      mkdirSync(foreignSuffix);
      const foreignSentinel = join(foreign, "sentinel.bin");
      const suffixSentinel = join(foreignSuffix, "sentinel.bin");
      const foreignBytes = Buffer.from([0, 17, 0, 34, 255]);
      const suffixBytes = Buffer.from([255, 68, 0, 51, 0]);
      writeFileSync(foreignSentinel, foreignBytes);
      writeFileSync(suffixSentinel, suffixBytes);
      const manifestBytes = Buffer.from(
        manifestContents(`foreign${String.fromCharCode(byte)}suffix`),
        "utf8",
      );
      writeFileSync(manifest, manifestBytes);
      const currentBefore = readlinkSync(current);
      const configBefore = configSnapshot(sandbox);

      for (const script of ["install.sh", "check.sh", "uninstall.sh"]) {
        const result = runScript(sandbox, script);
        expect(result.status).not.toBe(0);
        expect(readFileSync(manifest)).toEqual(manifestBytes);
        expect(readFileSync(foreignSentinel)).toEqual(foreignBytes);
        expect(readFileSync(suffixSentinel)).toEqual(suffixBytes);
        expect(readlinkSync(current)).toBe(currentBefore);
        expect(configSnapshot(sandbox)).toEqual(configBefore);
      }
      expect(
        readdirSafe(join(sandbox.root, "tmp")).filter((name) =>
          name.startsWith("omp-herdr-manifest-bytes."),
        ),
      ).toEqual([]);
    } finally {
      cleanup(sandbox);
    }
  });
  test("rejects update and uninstall after a managed profile is replaced", () => {
    const sandbox = createSandbox();
    try {
      installOrThrow(sandbox);
      const profileRoot = profileAgentDir(sandbox, "herdr-reviewer");
      renameSync(profileRoot, join(sandbox.root, "owned reviewer backup"));
      mkdirSync(profileRoot, { recursive: true });
      const sentinel = join(profileRoot, "foreign-sentinel");
      writeFileSync(sentinel, "foreign-profile-bytes");
      const manifestBefore = readFileSync(join(sandbox.installRoot, ".omp-herdr-manifest"));
      const currentBefore = readlinkSync(join(sandbox.installRoot, "current"));
      const configBefore = configSnapshot(sandbox);
      const herdrBefore = readFileSync(join(sandbox.state, "herdr.log"), "utf8");

      for (const script of ["install.sh", "uninstall.sh"]) {
        const result = runScript(sandbox, script);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("profile ownership check failed");
      }
      expect(readFileSync(sentinel, "utf8")).toBe("foreign-profile-bytes");
      expect(readFileSync(join(sandbox.installRoot, ".omp-herdr-manifest"))).toEqual(
        manifestBefore,
      );
      expect(readlinkSync(join(sandbox.installRoot, "current"))).toBe(currentBefore);
      expect(configSnapshot(sandbox)).toEqual(configBefore);
      expect(readFileSync(join(sandbox.state, "herdr.log"), "utf8")).toBe(herdrBefore);
    } finally {
      cleanup(sandbox);
    }
  });

  test.each([
    ["valid", false],
    ["broken", true],
  ])("rejects a %s profile ownership marker symlink", (_kind, broken) => {
    const sandbox = createSandbox();
    try {
      installOrThrow(sandbox);
      const marker = join(profileAgentDir(sandbox, "herdr-scouter"), ".omp-herdr-profile");
      const target = join(sandbox.root, "profile marker target");
      const original = readFileSync(marker);
      rmSync(marker);
      if (!broken) writeFileSync(target, original);
      symlinkSync(target, marker);
      const configBefore = configSnapshot(sandbox);

      expect(runScript(sandbox, "install.sh").status).not.toBe(0);
      expect(runScript(sandbox, "uninstall.sh").status).not.toBe(0);
      if (!broken) expect(readFileSync(target)).toEqual(original);
      expect(configSnapshot(sandbox)).toEqual(configBefore);
    } finally {
      cleanup(sandbox);
    }
  });
});


describe("auth broker service safety", () => {
  test("rejects an external broker before writing client configuration", () => {
    const sandbox = createSandbox();
    try {
      writeFileSync(join(sandbox.state, "port-in-use"), "");
      writeFileSync(join(sandbox.state, "broker-ready"), "");
      const result = runScript(sandbox, "auth-broker-service.sh", ["install"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("already running outside");
      const ompLog = readFileSync(join(sandbox.state, "omp.log"), "utf8");
      expect(ompLog).not.toContain("config set");
    } finally {
      cleanup(sandbox);
    }
  });

  test("refuses to stop an unmanaged unit", () => {
    const sandbox = createSandbox();
    try {
      const unit = join(sandbox.env.XDG_CONFIG_HOME, "systemd", "user", "omp-auth-broker.service");
      mkdirSync(dirname(unit), { recursive: true });
      writeFileSync(unit, "# foreign unit\n");
      const result = runScript(sandbox, "auth-broker-service.sh", ["stop"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing to stop unmanaged unit");
      expect(readFileSync(join(sandbox.state, "systemctl.log"), "utf8")).not.toContain(
        "stop omp-auth-broker.service",
      );
    } finally {
      cleanup(sandbox);
    }
  });

  test("rolls back exact client values and absence after a partial write failure", () => {
    const sandbox = createSandbox();
    try {
      const unit = join(sandbox.env.XDG_CONFIG_HOME, "systemd", "user", "omp-auth-broker.service");
      mkdirSync(dirname(unit), { recursive: true });
      writeFileSync(unit, "# Managed by omp-herdr\n[Service]\n");
      writeConfig(sandbox, "default", "auth.broker.url", "http://previous/default");
      writeConfig(sandbox, "default", "auth.broker.token", "previous-default-token");
      writeConfig(sandbox, "herdr-orchestrator", "auth.broker.url", "");
      writeConfig(sandbox, "herdr-builder", "auth.broker.token", "previous-builder-token");
      const before = configSnapshot(sandbox);

      const result = runScript(sandbox, "auth-broker-service.sh", ["start"], {
        FAIL_SET_ENTRY: "herdr-scouter:auth.broker.token",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("all client configuration was restored");
      expect(configSnapshot(sandbox)).toEqual(before);
    } finally {
      cleanup(sandbox);
    }
  });
  test("checks the newly started broker with explicit local credentials", () => {
    const sandbox = createSandbox();
    try {
      const unit = join(
        sandbox.env.XDG_CONFIG_HOME,
        "systemd",
        "user",
        "omp-auth-broker.service",
      );
      mkdirSync(dirname(unit), { recursive: true });
      writeFileSync(unit, "# Managed by omp-herdr\n[Service]\n");
      writeConfig(sandbox, "default", "auth.broker.url", "http://previous.example:9999");
      writeConfig(sandbox, "default", "auth.broker.token", "previous-token");

      const result = runScript(sandbox, "auth-broker-service.sh", ["start"]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(join(sandbox.state, "health.log"), "utf8")).toBe(
        "health:http://127.0.0.1:8765|test-broker-token\n",
      );
      const ompLog = readFileSync(join(sandbox.state, "omp.log"), "utf8");
      expect(ompLog.indexOf("auth-broker status --json")).toBeLessThan(
        ompLog.indexOf("config set auth.broker.url"),
      );
    } finally {
      cleanup(sandbox);
    }
  });

  test.each(
    ["install", "start", "stop", "uninstall"].flatMap((action) => [
      [action, "valid", false],
      [action, "broken", true],
    ]),
  )("rejects a %s action on a %s unit symlink", (action, _kind, broken) => {
    const sandbox = createSandbox();
    try {
      const unit = join(
        sandbox.env.XDG_CONFIG_HOME,
        "systemd",
        "user",
        "omp-auth-broker.service",
      );
      const target = join(sandbox.root, "unit target");
      mkdirSync(dirname(unit), { recursive: true });
      if (!broken) writeFileSync(target, "# Managed by omp-herdr\nsentinel-unit-bytes\n");
      symlinkSync(target, unit);

      const result = runScript(sandbox, "auth-broker-service.sh", [action]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unmanaged unit");
      expect(readlinkSync(unit)).toBe(target);
      if (!broken) {
        expect(readFileSync(target, "utf8")).toBe(
          "# Managed by omp-herdr\nsentinel-unit-bytes\n",
        );
      }
      const systemctlLog = readFileSync(join(sandbox.state, "systemctl.log"), "utf8");
      expect(systemctlLog).not.toContain("enable --now omp-auth-broker.service");
      expect(systemctlLog).not.toContain("start omp-auth-broker.service");
      expect(systemctlLog).not.toContain("stop omp-auth-broker.service");
      expect(systemctlLog).not.toContain("disable --now omp-auth-broker.service");
    } finally {
      cleanup(sandbox);
    }
  });
});
