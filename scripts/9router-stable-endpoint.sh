#!/usr/bin/env bash
# Permanent 9router endpoint — replaces expiring trycloudflare quick tunnels.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/root/.9router}"
STABLE_JSON="${DATA_DIR}/stable-endpoint.json"
PUBLIC_PORT="${NINE_ROUTER_PUBLIC_PORT:-9443}"
VPS_IP="$(curl -4 -s --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"

write_stable_json() {
  local local_url="http://127.0.0.1:20128"
  local public_url="https://screeningg97.devs.surf/9router"
  cat > "${STABLE_JSON}" <<EOF
{
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "local": {
    "api": "${local_url}/v1",
    "dashboard": "${local_url}",
    "expires": false,
    "note": "Same VPS only — Hermes, Meridian, curl. Never expires."
  },
  "remote": {
    "api": "${public_url}/v1",
    "dashboard": "${public_url}",
    "expires": false,
    "note": "VPS public IP via nginx — stable while IP unchanged. Use API key in Authorization header."
  },
  "deprecated": "trycloudflare.com quick tunnels — do not use"
}
EOF
  echo "Wrote ${STABLE_JSON}"
}

stop_quick_tunnel() {
  local pidfile="${DATA_DIR}/tunnel/cloudflared.pid"
  if [[ -f "${pidfile}" ]]; then
    local pid
    pid="$(cat "${pidfile}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
      echo "Stopped quick tunnel cloudflared (pid ${pid})"
    fi
    rm -f "${pidfile}"
  fi
  # Disable tunnel flag in state so 9router UI stops showing dead URL
  if [[ -f "${DATA_DIR}/tunnel/state.json" ]]; then
    python3 - <<'PY'
import json
from pathlib import Path
p = Path("/root/.9router/tunnel/state.json")
try:
    d = json.loads(p.read_text())
except Exception:
    d = {}
d["tunnelUrl"] = None
d["enabled"] = False
d["note"] = "replaced by stable-endpoint (nginx VPS IP)"
p.write_text(json.dumps(d, indent=2))
print("Cleared tunnel state.json")
PY
  fi
}

install_nginx_site() {
  local NGINX_BIN=""
  for c in /usr/sbin/nginx /sbin/nginx nginx; do
    if [[ -x "${c}" ]] || command -v "${c}" >/dev/null 2>&1; then
      NGINX_BIN="${c}"
      break
    fi
  done
  if [[ -z "${NGINX_BIN}" ]]; then
    echo "nginx not installed — run: apt-get install -y nginx"
    return 1
  fi
  export PATH="/usr/sbin:/sbin:${PATH}"
  local site="/etc/nginx/sites-available/9router-stable"
  cat > "${site}" <<NGINX
# Meridian — permanent 9router proxy (no trycloudflare expiry)
server {
    listen ${PUBLIC_PORT};
    listen [::]:${PUBLIC_PORT};
    server_name _;

    client_max_body_size 32m;
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;

    location / {
        proxy_pass http://127.0.0.1:20128;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX
  ln -sf "${site}" /etc/nginx/sites-enabled/9router-stable
  "${NGINX_BIN}" -t
  systemctl enable nginx
  systemctl reload nginx
  echo "nginx listening on :${PUBLIC_PORT} → 127.0.0.1:20128"
}

case "${1:-install}" in
  install)
    stop_quick_tunnel
    install_nginx_site || true
    write_stable_json
    echo ""
    echo "=== Permanent 9router URLs ==="
    echo "Local (same VPS):  http://127.0.0.1:20128/v1"
    echo "Remote (HTTPS):    https://screeningg97.devs.surf/9router/v1"
    echo "Dashboard remote:  https://screeningg97.devs.surf/9router/"
    echo ""
    echo "Hermes/Meridian on this VPS → use LOCAL only."
    ;;
  status)
    cat "${STABLE_JSON}" 2>/dev/null || echo "Run: $0 install"
    ss -tlnp | grep -E '20128|9443' || true
    ;;
  stop-tunnel)
    stop_quick_tunnel
    ;;
  *)
    echo "Usage: $0 [install|status|stop-tunnel]"
    exit 1
    ;;
esac