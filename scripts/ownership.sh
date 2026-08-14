#!/bin/sh

MANIFEST_NAME=.omp-herdr-manifest
TOMBSTONE_NAME=.omp-herdr-uninstalled
PROFILE_MARKER_NAME=.omp-herdr-profile
TOMBSTONE_HEADER=omp-herdr-uninstalled
PROFILE_MARKER_HEADER=omp-herdr-profile
MANIFEST_HEADER=omp-herdr-installation
MANIFEST_VERSION=2
MANAGED_PROFILES='herdr-orchestrator herdr-scouter herdr-builder herdr-reviewer'
MANAGED_KEYS='setupVersion startup.setupWizard skills.customDirectories skills.includeSkills extensions tools.approval bash.enabled eval.py eval.js browser.enabled web_search.enabled'

safe_release_name() {
  sr_name=$1
  case $sr_name in
    ''|.|..|*[!A-Za-z0-9._-]*) return 1 ;;
    [A-Za-z0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

regular_file() {
  [ -f "$1" ] && [ ! -L "$1" ]
}

validate_manifest_bytes() (
  vmb_file=$1
  regular_file "$vmb_file" || exit 1
  vmb_filtered=$(mktemp "${TMPDIR:-/tmp}/omp-herdr-manifest-bytes.XXXXXX") || exit 1
  trap 'rm -f "$vmb_filtered"' EXIT HUP INT TERM
  vmb_status=1
  if LC_ALL=C tr -d '\012\040-\176' < "$vmb_file" > "$vmb_filtered" &&
    [ ! -s "$vmb_filtered" ]
  then
    vmb_status=0
  fi
  rm -f "$vmb_filtered" || exit 1
  trap - EXIT HUP INT TERM
  exit "$vmb_status"
)

validate_manifest() {
  vm_file=$1
  regular_file "$vm_file" || return 1
  validate_manifest_bytes "$vm_file" || return 1
  [ "$(sed -n '1p' "$vm_file")" = "$MANIFEST_HEADER" ] || return 1
  [ "$(sed -n '2p' "$vm_file")" = "manifest-version=$MANIFEST_VERSION" ] || return 1
  [ "$(sed -n '3p' "$vm_file")" = "profiles=$MANAGED_PROFILES" ] || return 1
  [ "$(sed -n '4p' "$vm_file")" = "keys=$MANAGED_KEYS" ] || return 1
  [ "$(sed -n '5p' "$vm_file")" = "profile-marker=$PROFILE_MARKER_NAME" ] || return 1
  vm_line_number=0
  vm_release_count=0
  while IFS= read -r vm_line || [ -n "$vm_line" ]; do
    vm_line_number=$((vm_line_number + 1))
    [ "$vm_line_number" -gt 5 ] || continue
    case $vm_line in
      release=*) vm_release=${vm_line#release=} ;;
      *) return 1 ;;
    esac
    safe_release_name "$vm_release" || return 1
    vm_release_count=$((vm_release_count + 1))
  done < "$vm_file"
  [ "$vm_line_number" -eq $((vm_release_count + 5)) ] || return 1
  [ "$vm_release_count" -gt 0 ]
}

validate_tombstone() {
  vt_file=$1
  regular_file "$vt_file" || return 1
  [ "$(sed -n '1p' "$vt_file")" = "$TOMBSTONE_HEADER" ] || return 1
  [ "$(sed -n '2p' "$vt_file")" = "manifest-version=$MANIFEST_VERSION" ] || return 1
  [ "$(awk 'END { print NR }' "$vt_file")" -eq 2 ]
}

validate_releases_dir() {
  vr_root=$1
  vr_dir=$vr_root/releases
  [ -d "$vr_dir" ] && [ ! -L "$vr_dir" ] || return 1
  vr_root_real=$(realpath "$vr_root") || return 1
  vr_dir_real=$(realpath "$vr_dir") || return 1
  [ "$vr_dir_real" = "$vr_root_real/releases" ]
}

validate_release_path() {
  vp_root=$1
  vp_release=$2
  safe_release_name "$vp_release" || return 1
  validate_releases_dir "$vp_root" || return 1
  vp_path=$vp_root/releases/$vp_release
  [ -d "$vp_path" ] && [ ! -L "$vp_path" ] || return 1
  vp_root_real=$(realpath "$vp_root") || return 1
  vp_path_real=$(realpath "$vp_path") || return 1
  [ "$vp_path_real" = "$vp_root_real/releases/$vp_release" ]
}

validate_manifest_releases() {
  vms_root=$1
  vms_file=$2
  validate_manifest "$vms_file" || return 1
  validate_releases_dir "$vms_root" || return 1
  vms_line_number=0
  while IFS= read -r vms_line || [ -n "$vms_line" ]; do
    vms_line_number=$((vms_line_number + 1))
    [ "$vms_line_number" -gt 5 ] || continue
    vms_release=${vms_line#release=}
    validate_release_path "$vms_root" "$vms_release" || return 1
  done < "$vms_file"
}

validate_current_link() {
  vc_root=$1
  vc_manifest=$2
  vc_current=$vc_root/current
  [ -L "$vc_current" ] || return 1
  vc_target=$(readlink "$vc_current") || return 1
  vc_owned=false
  vc_line_number=0
  while IFS= read -r vc_line || [ -n "$vc_line" ]; do
    vc_line_number=$((vc_line_number + 1))
    [ "$vc_line_number" -gt 5 ] || continue
    vc_release=${vc_line#release=}
    if [ "$vc_target" = "$vc_root/releases/$vc_release" ]; then
      validate_release_path "$vc_root" "$vc_release" || return 1
      vc_owned=true
    fi
  done < "$vc_manifest"
  [ "$vc_owned" = true ]
}

write_manifest() {
  wm_file=$1
  shift
  [ "$#" -gt 0 ] || return 1
  wm_staging=$wm_file.tmp.$$
  {
    printf '%s\n' "$MANIFEST_HEADER"
    printf 'manifest-version=%s\n' "$MANIFEST_VERSION"
    printf 'profiles=%s\n' "$MANAGED_PROFILES"
    printf 'keys=%s\n' "$MANAGED_KEYS"
    printf 'profile-marker=%s\n' "$PROFILE_MARKER_NAME"
    for wm_release
    do
      safe_release_name "$wm_release" || return 1
      printf 'release=%s\n' "$wm_release"
    done
  } > "$wm_staging"
  chmod 600 "$wm_staging"
  mv "$wm_staging" "$wm_file"
}

manifest_has_release() {
  mhr_file=$1
  mhr_release=$2
  safe_release_name "$mhr_release" || return 1
  awk -v release="$mhr_release" '
    substr($0, 1, 8) == "release=" && substr($0, 9) == release { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$mhr_file"
}

append_manifest_release() {
  amr_file=$1
  amr_release=$2
  validate_manifest "$amr_file" || return 1
  safe_release_name "$amr_release" || return 1
  manifest_has_release "$amr_file" "$amr_release" && return 0
  amr_staging=$amr_file.tmp.$$
  {
    awk '{ print }' "$amr_file"
    printf 'release=%s\n' "$amr_release"
  } > "$amr_staging"
  chmod 600 "$amr_staging"
  mv "$amr_staging" "$amr_file"
}

write_profile_marker() {
  wp_root=$1
  wp_profile=$2
  wp_marker=$wp_root/$PROFILE_MARKER_NAME
  wp_staging=$wp_marker.tmp.$$
  [ -d "$wp_root" ] && [ ! -L "$wp_root" ] || return 1
  [ ! -e "$wp_marker" ] && [ ! -L "$wp_marker" ] || return 1
  {
    printf '%s\n' "$PROFILE_MARKER_HEADER"
    printf 'manifest-version=%s\n' "$MANIFEST_VERSION"
    printf 'profile=%s\n' "$wp_profile"
  } > "$wp_staging"
  chmod 600 "$wp_staging"
  mv "$wp_staging" "$wp_marker"
}

validate_profile_marker() {
  vp_root=$1
  vp_profile=$2
  vp_marker=$vp_root/$PROFILE_MARKER_NAME
  [ -d "$vp_root" ] && [ ! -L "$vp_root" ] || return 1
  regular_file "$vp_marker" || return 1
  [ "$(sed -n '1p' "$vp_marker")" = "$PROFILE_MARKER_HEADER" ] || return 1
  [ "$(sed -n '2p' "$vp_marker")" = "manifest-version=$MANIFEST_VERSION" ] || return 1
  [ "$(sed -n '3p' "$vp_marker")" = "profile=$vp_profile" ] || return 1
  [ "$(awk 'END { print NR }' "$vp_marker")" -eq 3 ]
}
