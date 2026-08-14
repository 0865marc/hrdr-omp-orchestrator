#!/bin/sh
set -eu

PROGRAM=omp-herdr-install
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)
. "$script_dir/ownership.sh"

fail() {
  printf '%s: %s\n' "$PROGRAM" "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

version_at_least() {
  va_actual=$1
  va_required=$2
  awk -v actual="$va_actual" -v required="$va_required" '
    function normalize(value, parts, count, part_index, output) {
      sub(/[^0-9.].*$/, "", value)
      count = split(value, parts, ".")
      output = 0
      for (part_index = 1; part_index <= 3; part_index++) output = output * 1000 + (part_index <= count ? parts[part_index] : 0)
      return output
    }
    BEGIN { exit !(normalize(actual) >= normalize(required)) }
  '
}

json_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}


managed_link() {
  ml_target=$1
  ml_link=$2
  if [ -e "$ml_link" ] || [ -L "$ml_link" ]; then
    [ -L "$ml_link" ] || fail "refusing to replace unmanaged path: $ml_link"
    ml_existing=$(readlink "$ml_link")
    [ "$ml_existing" = "$ml_target" ] || fail "refusing to replace foreign symlink: $ml_link"
    return
  fi
  ln -s "$ml_target" "$ml_link"
}

set_profile() {
  sp_profile=$1
  sp_skill=$2
  sp_approval=$3
  sp_bash=$4
  sp_extensions=$5

  omp --profile "$sp_profile" config set setupVersion 1 >/dev/null
  omp --profile "$sp_profile" config set startup.setupWizard false >/dev/null
  omp --profile "$sp_profile" config set skills.customDirectories "$skills_json" >/dev/null
  omp --profile "$sp_profile" config set skills.includeSkills "[\"$sp_skill\"]" >/dev/null
  omp --profile "$sp_profile" config set extensions "$sp_extensions" >/dev/null
  omp --profile "$sp_profile" config set tools.approval "$sp_approval" >/dev/null
  omp --profile "$sp_profile" config set bash.enabled "$sp_bash" >/dev/null
  omp --profile "$sp_profile" config set eval.py false >/dev/null
  omp --profile "$sp_profile" config set eval.js false >/dev/null
  omp --profile "$sp_profile" config set browser.enabled false >/dev/null
  omp --profile "$sp_profile" config set web_search.enabled false >/dev/null
}

profile_config_dir() {
  pc_agent_dir=$1
  case $pc_agent_dir in
    "$HOME"/*/agent) ;;
    *) fail "OMP profile agent directory must be under HOME and end in /agent: $pc_agent_dir" ;;
  esac
  pc_relative=${pc_agent_dir#"$HOME"/}
  printf '%s\n' "${pc_relative%/agent}"
}

install_integration() {
  ii_agent_dir=$1
  ii_config_dir=$2
  mkdir -p "$ii_agent_dir"
  (
    unset PI_CODING_AGENT_DIR
    PI_CONFIG_DIR=$ii_config_dir herdr integration install omp >/dev/null
  )
}

copy_release() {
  cr_root=$1
  cr_release=$2
  safe_release_name "$cr_release" || fail "unsafe release name: $cr_release"
  validate_releases_dir "$cr_root" || fail "releases path is not a contained managed directory: $cr_root/releases"
  cr_destination=$cr_root/releases/$cr_release
  [ ! -e "$cr_destination" ] && [ ! -L "$cr_destination" ] || fail "release path already exists: $cr_destination"
  cr_staging=$(mktemp -d "${TMPDIR:-/tmp}/omp-herdr-release.XXXXXX")
  mkdir -p "$cr_staging/release"
  if ! cp -R \
    "$project_root/VERSION" \
    "$project_root/LICENSE" \
    "$project_root/README.md" \
    "$project_root/bin" \
    "$project_root/config" \
    "$project_root/extensions" \
    "$project_root/lib" \
    "$project_root/scripts" \
    "$project_root/skills" \
    "$cr_staging/release/"
  then
    rm -rf "$cr_staging"
    fail "could not stage release payload"
  fi
  if ! mv "$cr_staging/release" "$cr_destination"; then
    rm -rf "$cr_staging"
    fail "could not install release payload at $cr_destination"
  fi
  rm -rf "$cr_staging"
  validate_release_path "$cr_root" "$cr_release" || fail "installed release escaped managed containment: $cr_destination"
}

project_root=$(CDPATH= cd -P "$script_dir/.." && pwd -P)
version=$(sed -n '1p' "$project_root/VERSION")
safe_release_name "$version" || fail "VERSION is not a safe release basename: $version"

require_command awk
require_command bun
require_command cmp
require_command diff
require_command herdr
require_command ln
require_command mktemp
require_command omp
require_command readlink
require_command realpath
require_command sed
require_command tr

herdr_version=$(herdr --version | sed 's/^herdr[[:space:]]*//')
omp_version=$(omp --version | sed 's#^omp/##')
version_at_least "$herdr_version" 0.8.0 || fail "Herdr 0.8.0 or newer is required; found $herdr_version"
version_at_least "$omp_version" 17.3.0 || fail "OMP 17.3.0 or newer is required; found $omp_version"
bun "$project_root/lib/roles.mjs" "$project_root/config/roles.json" >/dev/null || fail "role registry validation failed"

data_home=${XDG_DATA_HOME:-$HOME/.local/share}
install_root=${OMP_HERDR_HOME:-$data_home/omp-herdr}
manifest=$install_root/$MANIFEST_NAME
release_dir=$install_root/releases/$version
current_link=$install_root/current
bin_dir=${OMP_BIN_DIR:-$HOME/.local/bin}

managed_install=none
if [ -e "$install_root" ] || [ -L "$install_root" ]; then
  [ -d "$install_root" ] && [ ! -L "$install_root" ] || fail "install root is not a managed directory: $install_root"
  if validate_manifest_releases "$install_root" "$manifest" &&
    validate_current_link "$install_root" "$manifest"
  then
    managed_install=active
  elif validate_tombstone "$install_root/$TOMBSTONE_NAME" &&
    [ ! -e "$current_link" ] && [ ! -L "$current_link" ]
  then
    if [ -e "$install_root/releases" ] || [ -L "$install_root/releases" ]; then
      validate_releases_dir "$install_root" ||
        fail "tombstoned releases path is not a contained managed directory: $install_root/releases"
    fi
    managed_install=tombstone
  else
    fail "refusing to use unowned, invalid, or uncontained install root: $install_root"
  fi
fi

orchestrator_agent_dir=$(omp --profile herdr-orchestrator config path)
scouter_agent_dir=$(omp --profile herdr-scouter config path)
builder_agent_dir=$(omp --profile herdr-builder config path)
reviewer_agent_dir=$(omp --profile herdr-reviewer config path)
orchestrator_config_dir=$(profile_config_dir "$orchestrator_agent_dir")
scouter_config_dir=$(profile_config_dir "$scouter_agent_dir")
builder_config_dir=$(profile_config_dir "$builder_agent_dir")
reviewer_config_dir=$(profile_config_dir "$reviewer_agent_dir")

if [ "$managed_install" = active ]; then
  validate_profile_marker "$orchestrator_agent_dir" herdr-orchestrator ||
    fail "managed profile ownership check failed: herdr-orchestrator"
  validate_profile_marker "$scouter_agent_dir" herdr-scouter ||
    fail "managed profile ownership check failed: herdr-scouter"
  validate_profile_marker "$builder_agent_dir" herdr-builder ||
    fail "managed profile ownership check failed: herdr-builder"
  validate_profile_marker "$reviewer_agent_dir" herdr-reviewer ||
    fail "managed profile ownership check failed: herdr-reviewer"
else
  for profile_dir in "$orchestrator_agent_dir" "$scouter_agent_dir" "$builder_agent_dir" "$reviewer_agent_dir"; do
    if [ -e "$profile_dir" ] || [ -L "$profile_dir" ]; then
      fail "refusing to overwrite pre-existing OMP profile at $profile_dir; move or remove it, then retry"
    fi
  done
fi

if [ "$managed_install" = none ]; then
  install_parent=$(dirname "$install_root")
  mkdir -p "$install_parent"
  root_staging=$(mktemp -d "$install_parent/.omp-herdr-root.XXXXXX")
  trap 'rm -rf "$root_staging"' EXIT HUP INT TERM
  mkdir -p "$root_staging/releases"
  copy_release "$root_staging" "$version"
  write_manifest "$root_staging/$MANIFEST_NAME" "$version"
  ln -s "$install_root/releases/$version" "$root_staging/current"
  mv "$root_staging" "$install_root"
  trap - EXIT HUP INT TERM
elif [ "$managed_install" = tombstone ]; then
  mkdir -p "$install_root/releases"
  validate_releases_dir "$install_root" ||
    fail "releases path is not a contained managed directory: $install_root/releases"
  copy_release "$install_root" "$version"
  write_manifest "$manifest" "$version"
  ln -s "$release_dir" "$current_link"
  rm "$install_root/$TOMBSTONE_NAME"
else
  if [ -e "$release_dir" ] || [ -L "$release_dir" ]; then
    validate_release_path "$install_root" "$version" ||
      fail "release path is not a contained managed directory: $release_dir"
    for file in VERSION LICENSE README.md; do
      cmp -s "$project_root/$file" "$release_dir/$file" || fail "release $version already exists with different contents"
    done
    for directory in bin config extensions lib scripts skills; do
      diff -r "$project_root/$directory" "$release_dir/$directory" >/dev/null || fail "release $version already exists with different contents"
    done
  else
    copy_release "$install_root" "$version"
  fi
  append_manifest_release "$manifest" "$version" ||
    fail "could not update ownership manifest"
  rm "$current_link"
  ln -s "$release_dir" "$current_link"
fi

validate_manifest_releases "$install_root" "$manifest" ||
  fail "installed ownership manifest or release containment is invalid"
validate_current_link "$install_root" "$manifest" ||
  fail "installed current symlink is not owned by the manifest"

if [ "$managed_install" != active ]; then
  mkdir -p "$orchestrator_agent_dir"
  write_profile_marker "$orchestrator_agent_dir" herdr-orchestrator ||
    fail "could not create ownership marker for herdr-orchestrator"
  mkdir -p "$scouter_agent_dir"
  write_profile_marker "$scouter_agent_dir" herdr-scouter ||
    fail "could not create ownership marker for herdr-scouter"
  mkdir -p "$builder_agent_dir"
  write_profile_marker "$builder_agent_dir" herdr-builder ||
    fail "could not create ownership marker for herdr-builder"
  mkdir -p "$reviewer_agent_dir"
  write_profile_marker "$reviewer_agent_dir" herdr-reviewer ||
    fail "could not create ownership marker for herdr-reviewer"
fi

mkdir -p "$bin_dir"
managed_link "$current_link/bin/omp-herdr" "$bin_dir/omp-herdr"
managed_link "$current_link/bin/omp-herdr-check" "$bin_dir/omp-herdr-check"

install_integration "$orchestrator_agent_dir" "$orchestrator_config_dir"
install_integration "$scouter_agent_dir" "$scouter_config_dir"
install_integration "$builder_agent_dir" "$builder_config_dir"
install_integration "$reviewer_agent_dir" "$reviewer_config_dir"

skills_path=$(json_string "$current_link/skills")
workflow_extension_path=$(json_string "$current_link/extensions/herdr-workflow.ts")
readonly_extension_path=$(json_string "$current_link/extensions/read-only-policy.ts")
skills_json="[\"$skills_path\"]"
orchestrator_extensions="[\"$workflow_extension_path\"]"
readonly_extensions="[\"$readonly_extension_path\"]"

orchestrator_approval='{"bash":"deny","edit":"deny","write":"deny","task":"deny","lsp":"deny","ast_edit":"deny","debug":"deny","browser":"deny","python":"deny","notebook":"deny"}'
readonly_approval='{"read":"allow","grep":"allow","glob":"allow","inspect_image":"allow","ask":"allow","todo":"allow","bash":"deny","edit":"deny","write":"deny","task":"deny","lsp":"deny","ast_edit":"deny","debug":"deny","browser":"deny","python":"deny","notebook":"deny"}'
builder_approval='{"task":"deny"}'

set_profile herdr-orchestrator herdr-orchestrator "$orchestrator_approval" false "$orchestrator_extensions"
set_profile herdr-scouter herdr-scouter "$readonly_approval" false "$readonly_extensions"
set_profile herdr-builder herdr-builder "$builder_approval" true '[]'
set_profile herdr-reviewer herdr-reviewer "$readonly_approval" false "$readonly_extensions"

OMP_HERDR_HOME=$install_root OMP_HERDR_PAYLOAD=$current_link "$release_dir/scripts/check.sh"
printf '\nInstalled omp-herdr %s. Start Herdr, then run: omp --profile herdr-orchestrator\n' "$version"
