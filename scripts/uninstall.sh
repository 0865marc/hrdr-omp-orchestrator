#!/bin/sh
set -eu

PROGRAM=omp-herdr-uninstall
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)
. "$script_dir/ownership.sh"

fail() {
  printf '%s: %s\n' "$PROGRAM" "$*" >&2
  exit 1
}


reset_profile() {
  rp_profile=$1
  for key in $MANAGED_KEYS; do
    omp --profile "$rp_profile" config reset "$key" >/dev/null
  done
}

uninstall_profile() {
  up_profile=$1
  up_agent_dir=$2
  up_config_dir=$3
  (
    unset PI_CODING_AGENT_DIR
    PI_CONFIG_DIR=$up_config_dir herdr integration uninstall omp >/dev/null
  )
  reset_profile "$up_profile"
  rm "$up_agent_dir/$PROFILE_MARKER_NAME"
}

data_home=${XDG_DATA_HOME:-$HOME/.local/share}
install_root=${OMP_HERDR_HOME:-$data_home/omp-herdr}
manifest=$install_root/$MANIFEST_NAME
current=$install_root/current
bin_dir=${OMP_BIN_DIR:-$HOME/.local/bin}

if [ ! -e "$install_root" ] && [ ! -L "$install_root" ]; then
  printf '%s\n' "omp-herdr is not installed; nothing to remove."
  exit 0
fi

command -v awk >/dev/null 2>&1 || fail "awk is not installed"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is not installed"
command -v realpath >/dev/null 2>&1 || fail "realpath is not installed"
command -v sed >/dev/null 2>&1 || fail "sed is not installed"
command -v tr >/dev/null 2>&1 || fail "tr is not installed"
[ -d "$install_root" ] && [ ! -L "$install_root" ] || fail "install root is not a managed directory: $install_root"
if [ ! -e "$manifest" ] && [ ! -L "$manifest" ] &&
  validate_tombstone "$install_root/$TOMBSTONE_NAME"
then
  printf '%s\n' "omp-herdr is not installed; nothing to remove."
  exit 0
fi
validate_manifest_releases "$install_root" "$manifest" ||
  fail "refusing to uninstall from unowned, invalid, or uncontained root: $install_root"
validate_current_link "$install_root" "$manifest" ||
  fail "refusing to uninstall with an unowned current symlink: $current"

orchestrator_agent_dir=$(omp --profile herdr-orchestrator config path)
scouter_agent_dir=$(omp --profile herdr-scouter config path)
builder_agent_dir=$(omp --profile herdr-builder config path)
reviewer_agent_dir=$(omp --profile herdr-reviewer config path)
for agent_dir in "$orchestrator_agent_dir" "$scouter_agent_dir" "$builder_agent_dir" "$reviewer_agent_dir"; do
  case $agent_dir in
    "$HOME"/*/agent) ;;
    *) fail "managed profile agent directory must be under HOME and end in /agent: $agent_dir" ;;
  esac
done
validate_profile_marker "$orchestrator_agent_dir" herdr-orchestrator ||
  fail "managed profile ownership check failed: herdr-orchestrator"
validate_profile_marker "$scouter_agent_dir" herdr-scouter ||
  fail "managed profile ownership check failed: herdr-scouter"
validate_profile_marker "$builder_agent_dir" herdr-builder ||
  fail "managed profile ownership check failed: herdr-builder"
validate_profile_marker "$reviewer_agent_dir" herdr-reviewer ||
  fail "managed profile ownership check failed: herdr-reviewer"
orchestrator_relative=${orchestrator_agent_dir#"$HOME"/}
scouter_relative=${scouter_agent_dir#"$HOME"/}
builder_relative=${builder_agent_dir#"$HOME"/}
reviewer_relative=${reviewer_agent_dir#"$HOME"/}
orchestrator_config_dir=${orchestrator_relative%/agent}
scouter_config_dir=${scouter_relative%/agent}
builder_config_dir=${builder_relative%/agent}
reviewer_config_dir=${reviewer_relative%/agent}

config_home=${XDG_CONFIG_HOME:-$HOME/.config}
unit_file=$config_home/systemd/user/omp-auth-broker.service
service_script=$current/scripts/auth-broker-service.sh
if [ -f "$service_script" ] && { [ -e "$unit_file" ] || [ -L "$unit_file" ]; }; then
  sh "$service_script" uninstall
fi

uninstall_profile herdr-orchestrator "$orchestrator_agent_dir" "$orchestrator_config_dir"
uninstall_profile herdr-scouter "$scouter_agent_dir" "$scouter_config_dir"
uninstall_profile herdr-builder "$builder_agent_dir" "$builder_config_dir"
uninstall_profile herdr-reviewer "$reviewer_agent_dir" "$reviewer_config_dir"

for command in omp-herdr omp-herdr-check; do
  link=$bin_dir/$command
  if [ -L "$link" ]; then
    target=$(readlink "$link")
    case $target in
      "$current"/*) rm "$link" ;;
      *) fail "refusing to remove foreign symlink: $link" ;;
    esac
  elif [ -e "$link" ]; then
    fail "refusing to remove unmanaged path: $link"
  fi
done

if [ -L "$current" ]; then
  rm "$current"
fi
release_line_number=0
while IFS= read -r release_line || [ -n "$release_line" ]; do
  release_line_number=$((release_line_number + 1))
  [ "$release_line_number" -gt 5 ] || continue
  release=${release_line#release=}
  validate_release_path "$install_root" "$release" ||
    fail "refusing to remove invalid or uncontained managed release: $release"
  rm -rf "$install_root/releases/$release"
done < "$manifest"
rm "$manifest"
rmdir "$install_root/releases" 2>/dev/null || :
if ! rmdir "$install_root" 2>/dev/null; then
  tombstone=$install_root/$TOMBSTONE_NAME
  [ ! -e "$tombstone" ] && [ ! -L "$tombstone" ] ||
    fail "refusing to replace existing uninstall tombstone: $tombstone"
  {
    printf '%s\n' "$TOMBSTONE_HEADER"
    printf 'manifest-version=%s\n' "$MANIFEST_VERSION"
  } > "$tombstone"
  chmod 600 "$tombstone"
fi

printf '%s\n' "Removed omp-herdr payload, managed broker service, integrations, and owned profile settings. Sessions, authentication, and unrelated settings were preserved."
