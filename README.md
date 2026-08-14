# omp-herdr

`omp-herdr` turns one OMP session into a visible orchestrator for independent OMP agents running in Herdr panes.

The Orchestrator stays read-only. It delegates repository exploration to a cheap Scouter, all mutations to one Builder, and risk-based review to a read-only Reviewer.

```text
OMP Orchestrator
├── OMP Scouter   — repository evidence
├── OMP Builder   — sole writable owner
└── OMP Reviewer  — stable-snapshot review
```

This project does not fork OMP or Herdr. Every role is a standard OMP process; Herdr owns its terminal and lifecycle.

## Status

Initial release. Supported and tested targets:

- Linux x86_64/aarch64;
- macOS Intel/Apple silicon;
- OMP 17.3.0 or newer;
- Herdr 0.8.0 or newer.

Windows is not supported by this release because native Herdr support is currently beta.

## Install

### 1. Install prerequisites

Install [OMP](https://github.com/can1357/oh-my-pi), [Herdr](https://herdr.dev/docs/install/), and [Bun](https://bun.sh/), then verify:

```sh
omp --version
herdr --version
bun --version
```

### 2. Clone and install omp-herdr

Clone the repository into the internal project directory:

```sh
git clone git@github.com:0865marc/hrdr-omp-orchestrator.git omp-herdr
cd omp-herdr
sh scripts/install.sh
```

For a local checkout:

```sh
cd /path/to/omp-herdr
sh scripts/install.sh
```

The installer:

- verifies OMP and Herdr versions and validates the complete role registry with its runtime loader;
- installs the Herdr OMP integration separately in all four profile agent directories;
- copies a versioned payload to `${XDG_DATA_HOME:-$HOME/.local/share}/omp-herdr` and records owned releases, profiles, profile markers, and keys in a validated manifest;
- rejects symlinked manifests, tombstones, profile markers, release directories, and release paths, plus any release name outside the strict portable basename allowlist;
- configures `herdr-orchestrator`, `herdr-scouter`, `herdr-builder`, and `herdr-reviewer` OMP profiles;
- installs the role skills, Orchestrator extension, and read-only role policy;
- creates `omp-herdr` and `omp-herdr-check` in `${OMP_BIN_DIR:-$HOME/.local/bin}`.

It does not log in, copy credentials, start an auth service, or modify a target repository.

Make sure `${OMP_BIN_DIR:-$HOME/.local/bin}` is on `PATH`.

### 3. Configure authentication

OMP profiles isolate authentication. Choose one method.

#### Shared Auth Broker — recommended for a Codex subscription

Authenticate once in the default OMP store:

```sh
omp auth-broker login openai-codex
```

On Linux with systemd, install the managed user service once:

```sh
sh scripts/auth-broker-service.sh install
```

The script first rejects an occupied broker port or unmanaged unit, then starts and verifies `omp-auth-broker.service` before configuring the default OMP instance and all four role profiles. A partial configuration failure restores every previous URL/token value or its prior absence. The bearer token is never printed. No Herdr pane is required.

Manage it with:

```sh
sh scripts/auth-broker-service.sh status
sh scripts/auth-broker-service.sh stop
sh scripts/auth-broker-service.sh start
sh scripts/auth-broker-service.sh uninstall
```

After installation, the ordinary check is sufficient:

```sh
omp auth-broker status --json
```

The expected response contains `"ok":true`.

#### Portable pane fallback

The service helper currently supports Linux/systemd. On macOS, or when a user service is undesirable, expose the broker connection before starting Herdr:

```sh
export OMP_AUTH_BROKER_URL=http://127.0.0.1:8765
export OMP_AUTH_BROKER_TOKEN="$(omp auth-broker token)"
herdr
```

Then run this block once inside Herdr before `omp-herdr`:

```sh
broker_pane=$(
  herdr pane split --current --direction down --cwd "$PWD" --no-focus |
    sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p'
) &&
[ -n "$broker_pane" ] &&
herdr pane rename "$broker_pane" "OMP Auth Broker" &&
herdr pane send-text "$broker_pane" "omp auth-broker serve" &&
herdr pane send-keys "$broker_pane" enter
```

This fallback keeps the broker in a pane named `OMP Auth Broker` without changing focus. Keep that pane open while agents run; closing it stops the broker.

#### OpenAI API key

The shipped registry targets the `openai-codex` provider and therefore does not use `OPENAI_API_KEY`. To use API billing instead:

1. run `omp models openai` to list selectors available to the API provider;
2. replace every `model` in `config/roles.json` with a suitable `openai/...` selector;
3. install the edited checkout;
4. export the key before starting Herdr:

```sh
export OPENAI_API_KEY=...
herdr
```

#### Profile-local login

Without a broker, authenticate each of the four profiles independently with `omp --profile <profile-name> login`. This works but is intentionally not the recommended setup.

## Use

Start or attach to Herdr:

```sh
herdr
```

Inside a Herdr pane, enter the repository to change and start the Orchestrator:

```sh
cd ~/dev/my-project
omp --profile herdr-orchestrator
```

The installed convenience command is equivalent:

```sh
omp-herdr
```

Then ask normally:

```text
Implement X/Y.
```

For a normal change, the expected flow is:

```text
request
  → Scouter maps the repository
  → Orchestrator builds a self-contained brief
  → Builder implements and validates
  → Reviewer checks risky changes
  → accepted findings return to the same Builder
  → Orchestrator reports evidence
```

Small, fully localized changes may skip Scouter. Consultations may require no child agent.

## Profiles

| Profile | Model | Reasoning | Purpose | Mutation policy |
|---|---|---|---|---|
| `herdr-orchestrator` | `openai-codex/gpt-5.6-sol` | `max` | Scope, decisions, delegation, final response | Read-only; delegates through Herdr |
| `herdr-scouter` | `openai-codex/gpt-5.6-luna` | `max` | Compressed repository exploration | Read-only |
| `herdr-builder` | `openai-codex/gpt-5.6-terra` | `max` | Complete implementation and assigned checks | Sole writable owner |
| `herdr-reviewer` | `openai-codex/gpt-5.6-sol` | `xhigh` | Review after delivery on a stable tree | Read-only |

The profiles contain role behavior and tool policy. The role registry contains runtime selection.

## Role registry

Edit `config/roles.json` before installation to select the harness, OMP profile, model, and reasoning level:

```json
{
  "schemaVersion": 1,
  "roles": {
    "scouter": {
      "harness": "omp",
      "profile": "herdr-scouter",
      "model": "openai-codex/gpt-5.6-luna",
      "reasoning": "max",
      "spawnable": true
    }
  }
}
```

The shipped registry contains all four required roles. Version 0.1 supports `omp` as the harness for every role. Unsupported harnesses fail clearly instead of silently falling back.

Model selectors must exist for the authenticated OMP installation. Change them when an account does not expose the shipped defaults, then increment `VERSION` before reinstalling over an existing release.

Reasoning values follow OMP:

```text
off, minimal, low, medium, high, xhigh, max, auto
```

Not every model supports every value. The shipped defaults use `medium`, `high`, or `max`.

## How delegation works

Only the Orchestrator profile loads `extensions/herdr-workflow.ts`. It registers one tool:

```text
herdr_orchestrate
```

Supported actions:

- `delegate`: create or reuse a role agent, submit a prompt, wait, and read terminal evidence;
- `status`: inspect the live Herdr agent state;
- `read`: read recent unwrapped terminal output.

A Scouter launch resolves to the equivalent of:

```sh
herdr agent start <workflow-local-name> \
  --kind omp \
  --pane <new-pane> \
  -- \
  --profile herdr-scouter \
  --model openai-codex/gpt-5.6-luna \
  --thinking max
```

The extension parses Herdr JSON responses and never predicts pane IDs. Background panes use the same repository cwd and do not steal focus.

## Isolation and safety

`omp-herdr` enforces one Builder inside its own workflow, but it is not a security sandbox and does not lock the repository against unrelated processes.

Scouter and Reviewer load a closed tool allowlist. Only `read`, `grep`, `glob`, `inspect_image`, `ask`, and `todo` pass their `tool_call` policy; every other name, including unknown future tools, `bash`, `edit`, `write`, `python`, and `notebook`, is blocked. Builder and Orchestrator are not governed by this child-role allowlist. This is application policy, not an operating-system sandbox.

Important limits:

- all roles currently share the same checkout;
- the closed Scouter/Reviewer tool policy prevents accidental writes but is not an operating-system permission boundary;
- external editors, shells, and other OMP sessions can still modify the repository;
- model output remains nondeterministic;
- Herdr lifecycle state is useful but does not by itself prove turn completion;
- each delegated turn therefore ends with a unique terminal marker; after `agent_prompt_stalled`, the extension submits one recovery Enter and waits for that marker before returning evidence.
- every `herdr_orchestrate` action rechecks the live model and disables the workflow if it no longer matches the configured Orchestrator selector.

Use a clean Git checkout and avoid concurrent writers. Worktree isolation is intentionally outside the first release.

## Check installation

```sh
omp-herdr-check
```

The check validates binaries, profiles, skills, extensions, the complete runtime role registry, the ownership manifest, and a current Herdr OMP integration in each of the four profile agent directories without calling a model.

## Update

From the checkout:

```sh
git pull
sh scripts/install.sh
```

Published releases are copied into canonically contained, non-symlink directories recorded by the ownership manifest. Updates require a valid manifest, `current` link, and four matching regular profile ownership markers before any mutation; if files change without a `VERSION` change, installation fails instead of overwriting an existing release ambiguously.

## Uninstall

```sh
sh scripts/uninstall.sh
```

The uninstaller preflights the manifest, contained releases, `current`, and all four regular profile ownership markers before mutation. It removes only listed releases, managed command links, per-profile Herdr integration files, exact managed profile keys including `setupVersion`, and its marker files. It preserves profile roots, unrelated payload files, profile keys, profile session databases, and authentication. An uninstalled root retained only for unrelated files carries a regular inert ownership tombstone so repeated uninstall remains safe and idempotent.

## Configuration overrides

Installation supports:

```text
OMP_HERDR_HOME   payload root
OMP_BIN_DIR      command link directory
XDG_DATA_HOME    standard data root
```

Example:

```sh
OMP_HERDR_HOME="$HOME/tools/omp-herdr" \
OMP_BIN_DIR="$HOME/bin" \
sh scripts/install.sh
```

Use the same overrides for `check.sh` and `uninstall.sh`.

## Development

Runtime installation uses Bun to execute the same role-registry validator consumed by the extension. It has no Node, npm, jq, or Python dependency. Development tests also use Bun:

```sh
bun test
bun run test
sh -n scripts/ownership.sh scripts/install.sh scripts/check.sh scripts/uninstall.sh scripts/auth-broker-service.sh bin/omp-herdr bin/omp-herdr-check
```

Tests validate registry loading, mandatory-model readiness and drift, read-only tool enforcement, Herdr command construction, ownership/path/symlink rejection, and isolated installer/service transactions with fake CLIs. CI never calls a paid model or modifies real profiles.

A manual release smoke test must additionally prove:

1. `omp --profile herdr-orchestrator` starts inside Herdr;
2. Scouter appears in a new pane;
3. its configured profile/model/reasoning are visible in the launch;
4. the Orchestrator receives its evidence;
5. Builder and Reviewer reuse workflow-local names.

## Upstream documentation

- [Herdr installation](https://herdr.dev/docs/install/)
- [Herdr agent automation](https://herdr.dev/docs/agent-automation/)
- [Herdr integrations](https://herdr.dev/docs/integrations/)
- [OMP extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)
- [OMP Auth Broker](https://github.com/can1357/oh-my-pi/blob/main/docs/auth-broker-gateway.md)

## License

MIT
