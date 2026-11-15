#!/usr/bin/env bash
set -euo pipefail

napcat_uid=${NAPCAT_UID:-1000}
napcat_gid=${NAPCAT_GID:-1000}
groupmod -o -g "$napcat_gid" napcat
usermod -o -u "$napcat_uid" -g napcat napcat

qq_home=/app/.config/QQ
config_dir="$NAPCAT_WORKDIR/config"
mkdir -p "$qq_home" "$config_dir" "$NAPCAT_WORKDIR"/{cache,logs,plugins}
if [[ ! -f "$config_dir/napcat.json" ]]; then
  cp /app/napcat-default.json "$config_dir/napcat.json"
fi
if [[ ! -f "$config_dir/webui.json" ]]; then
  : "${WEBUI_TOKEN:?Set WEBUI_TOKEN before starting NapCat for the first time}"
  (
    umask 077
    jq -n '{host: "0.0.0.0", port: 6099, token: env.WEBUI_TOKEN, prefix: (env.WEBUI_PREFIX // "")}' > "$config_dir/webui.json"
  )
fi
# Limit ownership changes to the writable runtime and mounted data.
chown napcat:napcat /app /app/.config
chown -R napcat:napcat "$qq_home" "$config_dir" "$NAPCAT_WORKDIR"/{cache,logs,plugins}
export HOME=/app
unset WEBUI_TOKEN
qq_args=(--no-sandbox)
if [[ -n ${ACCOUNT:-} ]]; then
  qq_args+=(-q "$ACCOUNT")
fi
exec gosu napcat xvfb-run -a /opt/QQ/qq "${qq_args[@]}"
