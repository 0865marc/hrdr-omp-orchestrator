#!/bin/sh
set -eu

PROGRAM=omp-herdr-check
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)
. "$script_dir/ownership.sh"

fail() {
  printf '%s: %s\n' "$PROGRAM" "$*" >&2
  exit 1
}


command -v bun >/dev/null 2>&1 || fail "bun is not installed"
command -v omp >/dev/null 2>&1 || fail "omp is not installed"
command -v herdr >/dev/null 2>&1 || fail "herdr is not installed"
command -v realpath >/dev/null 2>&1 || fail "realpath is not installed"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is not installed"
command -v tr >/dev/null 2>&1 || fail "tr is not installed"

script_root=$(CDPATH= cd -P "$script_dir/.." && pwd -P)
data_home=${XDG_DATA_HOME:-$HOME/.local/share}
install_root=${OMP_HERDR_HOME:-$data_home/omp-herdr}
current=${OMP_HERDR_PAYLOAD:-$install_root/current}
if [ ! -d "$current" ]; then
  current=$script_root
fi

[ -f "$current/config/roles.json" ] || fail "role registry is missing"
[ -f "$current/extensions/herdr-workflow.ts" ] || fail "Herdr extension is missing"
[ -f "$current/extensions/read-only-policy.ts" ] || fail "read-only policy extension is missing"
for role in orchestrator scouter builder reviewer; do
  [ -f "$current/skills/herdr-$role/SKILL.md" ] || fail "skill herdr-$role is missing"
done
bun "$current/lib/roles.mjs" "$current/config/roles.json" >/dev/null || fail "role registry validation failed"

if [ -e "$install_root" ] || [ -L "$install_root" ]; then
  [ -d "$install_root" ] && [ ! -L "$install_root" ] || fail "install root is not a managed directory"
  validate_manifest_releases "$install_root" "$install_root/$MANIFEST_NAME" ||
    fail "install ownership manifest or release containment is invalid"
  validate_current_link "$install_root" "$install_root/$MANIFEST_NAME" ||
    fail "installed current symlink is not owned by the manifest"
fi

check_profile() {
  cp_profile=$1
  cp_skill=$2
  cp_policy=$3
  cp_agent_dir=$(omp --profile "$cp_profile" config path)
  validate_profile_marker "$cp_agent_dir" "$cp_profile" ||
    fail "$cp_profile ownership marker is invalid"
  cp_setup=$(omp --profile "$cp_profile" config get setupVersion)
  [ "$cp_setup" = 1 ] || fail "$cp_profile is not initialized"
  cp_skills=$(omp --profile "$cp_profile" config get skills.includeSkills)
  case $cp_skills in
    *"\"$cp_skill\""*) ;;
    *) fail "$cp_profile does not include $cp_skill" ;;
  esac
  cp_extensions=$(omp --profile "$cp_profile" config get extensions)
  case $cp_policy in
    workflow)
      case $cp_extensions in
        *herdr-workflow.ts*) ;;
        *) fail "$cp_profile does not load herdr-workflow.ts" ;;
      esac
      ;;
    readonly)
      case $cp_extensions in
        *read-only-policy.ts*) ;;
        *) fail "$cp_profile does not load read-only-policy.ts" ;;
      esac
      ;;
    none)
      [ "$cp_extensions" = '[]' ] || fail "$cp_profile loads an unexpected extension"
      ;;
  esac

  cp_integration=$cp_agent_dir/extensions/herdr-omp-agent-state.ts
  [ -f "$cp_integration" ] || fail "$cp_profile is missing the Herdr OMP integration at $cp_integration"
  case $cp_agent_dir in
    "$HOME"/*/agent) ;;
    *) fail "$cp_profile agent directory must be under HOME and end in /agent" ;;
  esac
  cp_relative=${cp_agent_dir#"$HOME"/}
  cp_config_dir=${cp_relative%/agent}
  cp_status=$(
    unset PI_CODING_AGENT_DIR
    PI_CONFIG_DIR=$cp_config_dir herdr integration status
  )
  case $cp_status in
    *"omp: current"*) ;;
    *) fail "$cp_profile Herdr OMP integration is not current at $cp_integration" ;;
  esac
  case $cp_status in
    *"$cp_integration"*) ;;
    *) fail "$cp_profile Herdr OMP integration status reports a different path" ;;
  esac
}

check_profile herdr-orchestrator herdr-orchestrator workflow
check_profile herdr-scouter herdr-scouter readonly
check_profile herdr-builder herdr-builder none
check_profile herdr-reviewer herdr-reviewer readonly

auth_status=profile-local-or-unconfigured
broker_url=${OMP_AUTH_BROKER_URL:-}
broker_token=${OMP_AUTH_BROKER_TOKEN:-}
if [ -z "$broker_url" ]; then
  if configured_url=$(omp --profile herdr-orchestrator config get auth.broker.url 2>/dev/null); then
    broker_url=$configured_url
  fi
  if configured_token=$(omp --profile herdr-orchestrator config get auth.broker.token 2>/dev/null); then
    broker_token=$configured_token
  fi
fi
if [ -n "$broker_url" ]; then
  if OMP_AUTH_BROKER_URL=$broker_url OMP_AUTH_BROKER_TOKEN=$broker_token \
    omp auth-broker status --json >/dev/null 2>&1
  then
    auth_status=broker
  else
    auth_status=broker-unreachable
  fi
elif [ -n "${OPENAI_API_KEY:-}" ]; then
  auth_status=api-key
fi

printf '%s\n' \
  "OMP Herdr installation" \
  "" \
  "OMP:              $(omp --version)" \
  "Herdr:            $(herdr --version)" \
  "OMP integrations: current for 4 profiles" \
  "Profiles:         orchestrator, scouter, builder, reviewer" \
  "Role registry:    $current/config/roles.json" \
  "Authentication:   $auth_status" \
  "Status:           installed"
