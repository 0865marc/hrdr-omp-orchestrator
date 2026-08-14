#!/bin/sh
set -eu

PROGRAM=omp-herdr-auth-broker
SERVICE=omp-auth-broker.service
BROKER_URL=http://127.0.0.1:8765
BROKER_PORT=8765
MANAGED_MARKER='# Managed by omp-herdr'
CLIENTS='default herdr-orchestrator herdr-scouter herdr-builder herdr-reviewer'
CLIENT_KEYS='auth.broker.url auth.broker.token'

fail() {
  printf '%s: %s\n' "$PROGRAM" "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_linux_systemd() {
  [ "$(uname -s)" = Linux ] || fail "managed auth broker service currently requires Linux"
  systemctl --user show-environment >/dev/null 2>&1 || fail "systemd user manager is unavailable"
}

is_managed_unit() {
  [ -f "$unit_file" ] &&
    [ ! -L "$unit_file" ] &&
    [ "$(sed -n '1p' "$unit_file")" = "$MANAGED_MARKER" ]
}

client_get() {
  cg_client=$1
  cg_key=$2
  if [ "$cg_client" = default ]; then
    omp config get "$cg_key"
  else
    omp --profile "$cg_client" config get "$cg_key"
  fi
}

client_set() {
  cs_client=$1
  cs_key=$2
  cs_value=$3
  if [ "$cs_client" = default ]; then
    omp config set "$cs_key" "$cs_value" >/dev/null
  else
    omp --profile "$cs_client" config set "$cs_key" "$cs_value" >/dev/null
  fi
}

client_reset() {
  cr_client=$1
  cr_key=$2
  if [ "$cr_client" = default ]; then
    omp config reset "$cr_key" >/dev/null
  else
    omp --profile "$cr_client" config reset "$cr_key" >/dev/null
  fi
}

backup_clients() {
  backup_dir=$(mktemp -d "${TMPDIR:-/tmp}/omp-herdr-auth.XXXXXX")
  chmod 700 "$backup_dir"
  for bc_client in $CLIENTS; do
    for bc_key in $CLIENT_KEYS; do
      bc_base=$backup_dir/$bc_client.$bc_key
      if bc_value=$(client_get "$bc_client" "$bc_key" 2>/dev/null); then
        printf '%s' "$bc_value" > "$bc_base.value"
        : > "$bc_base.present"
      fi
    done
  done
}

rollback_clients() {
  rc_failed=false
  for rc_entry in $touched_clients; do
    rc_client=${rc_entry%%:*}
    rc_key=${rc_entry#*:}
    rc_base=$backup_dir/$rc_client.$rc_key
    if [ -f "$rc_base.present" ]; then
      rc_value=$(cat "$rc_base.value")
      client_set "$rc_client" "$rc_key" "$rc_value" || rc_failed=true
    else
      client_reset "$rc_client" "$rc_key" || rc_failed=true
    fi
  done
  [ "$rc_failed" = false ]
}

configure_clients() {
  backup_clients
  touched_clients=
  for cc_client in $CLIENTS; do
    for cc_key in $CLIENT_KEYS; do
      cc_entry=$cc_client:$cc_key
      touched_clients="$cc_entry $touched_clients"
      case $cc_key in
        auth.broker.url) cc_value=$BROKER_URL ;;
        auth.broker.token) cc_value=$broker_token ;;
      esac
      if ! client_set "$cc_client" "$cc_key" "$cc_value"; then
        if rollback_clients; then
          rm -rf "$backup_dir"
          fail "failed to configure $cc_client $cc_key; all client configuration was restored"
        fi
        rm -rf "$backup_dir"
        fail "failed to configure $cc_client $cc_key and rollback was incomplete"
      fi
    done
  done
  rm -rf "$backup_dir"
}

broker_ready() {
  omp auth-broker status --json >/dev/null 2>&1
}

managed_broker_ready() {
  OMP_AUTH_BROKER_URL=$BROKER_URL OMP_AUTH_BROKER_TOKEN=$broker_token \
    omp auth-broker status --json >/dev/null 2>&1
}

port_in_use() {
  ss -ltn | awk -v port=":$BROKER_PORT" '$4 ~ (port "$") { found = 1 } END { exit !found }'
}

managed_service_active() {
  systemctl --user is-active --quiet "$SERVICE"
}

preflight_port() {
  if ! managed_service_active && port_in_use; then
    if broker_ready; then
      fail "a broker is already running outside $SERVICE; stop its pane or process, then retry"
    fi
    fail "TCP port $BROKER_PORT is already in use; free it, then retry"
  fi
}

prepare_broker_token() {
  broker_token=$(omp auth-broker token) || fail "could not read the auth broker token; run: omp auth-broker login openai-codex"
  [ -n "$broker_token" ] || fail "auth broker token is empty; run: omp auth-broker login openai-codex"
}

wait_until_ready() {
  attempts=0
  while [ "$attempts" -lt 15 ]; do
    if managed_broker_ready; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

install_service() {
  if { [ -e "$unit_file" ] || [ -L "$unit_file" ]; } && ! is_managed_unit; then
    fail "refusing to replace unmanaged unit: $unit_file"
  fi
  preflight_port
  prepare_broker_token

  omp_path=$(command -v omp)
  escaped_omp=$(printf '%s' "$omp_path" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g')
  mkdir -p "$unit_dir"
  staging=$(mktemp "$unit_dir/.omp-auth-broker.XXXXXX")
  trap 'rm -f "$staging"' EXIT HUP INT TERM
  cat > "$staging" <<EOF
$MANAGED_MARKER
[Unit]
Description=OMP Auth Broker for omp-herdr
After=network.target

[Service]
Type=simple
ExecStart="$escaped_omp" auth-broker serve
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
  chmod 600 "$staging"
  mv "$staging" "$unit_file"
  trap - EXIT HUP INT TERM

  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE"
  if ! wait_until_ready; then
    systemctl --user --no-pager --full status "$SERVICE" >&2 || :
    fail "service started but broker health did not become ready; client configuration was not changed"
  fi
  configure_clients
  printf '%s\n' \
    "Installed and started $SERVICE." \
    "The broker now runs without a Herdr pane and starts with your user session."
}

start_service() {
  { [ -e "$unit_file" ] || [ -L "$unit_file" ]; } ||
    fail "service is not installed; run: $0 install"
  is_managed_unit || fail "refusing to start unmanaged unit: $unit_file"
  preflight_port
  prepare_broker_token
  systemctl --user start "$SERVICE"
  wait_until_ready || fail "service started but broker health did not become ready; client configuration was not changed"
  configure_clients
  printf '%s\n' "Started $SERVICE."
}

stop_service() {
  { [ -e "$unit_file" ] || [ -L "$unit_file" ]; } ||
    fail "service is not installed; run: $0 install"
  is_managed_unit || fail "refusing to stop unmanaged unit: $unit_file"
  systemctl --user stop "$SERVICE"
  printf '%s\n' "Stopped $SERVICE."
}

status_service() {
  systemctl --user is-active "$SERVICE"
  omp auth-broker status --json
}

uninstall_service() {
  if [ -e "$unit_file" ] || [ -L "$unit_file" ]; then
    is_managed_unit || fail "refusing to remove unmanaged unit: $unit_file"
    systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 || :
    rm "$unit_file"
    systemctl --user daemon-reload
  fi
  printf '%s\n' \
    "Removed $SERVICE." \
    "Broker credentials and OMP client configuration were preserved."
}

[ "$#" -eq 1 ] || fail "usage: $0 install|start|stop|status|uninstall"
require_command awk
require_command cat
require_command mktemp
require_command omp
require_command sed
require_command ss
require_command systemctl
require_linux_systemd

config_home=${XDG_CONFIG_HOME:-$HOME/.config}
unit_dir=$config_home/systemd/user
unit_file=$unit_dir/$SERVICE

action=$1
case $action in
  install) install_service ;;
  start) start_service ;;
  stop) stop_service ;;
  status) status_service ;;
  uninstall) uninstall_service ;;
  *) fail "unknown action: $action (expected install|start|stop|status|uninstall)" ;;
esac
