#!/usr/bin/env bash
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_DIR="/data/sim-service"
APP_NAME="sim-service"
# Must match PORT in ecosystem.config.<env>.cjs (sg-lab uses 3500)
APP_PORT="${SIM_SERVICE_HEALTH_PORT:-3500}"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

MODE="full"
DEPLOY_ENV=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      shift
      DEPLOY_ENV="${1:-}"
      [[ -z "${DEPLOY_ENV}" ]] && err "--env requires a value"
      ;;
    --restart)     MODE="restart" ;;
    --sync-only)   MODE="sync" ;;
    --status)      MODE="status" ;;
    --setup)       MODE="setup" ;;
    *) err "Unknown option: $1" ;;
  esac
  shift
done

[[ -z "${DEPLOY_ENV}" ]] && err "--env is required (e.g. sg-lab)"

case "${DEPLOY_ENV}" in
  sg-lab)
    # Do not commit real hosts/keys — set in your shell or CI secrets.
    REMOTE_HOST="${DEPLOY_SG_LAB_HOST:-}"
    REMOTE_USER="${DEPLOY_SG_LAB_USER:-ubuntu}"
    SSH_KEY="${DEPLOY_SSH_KEY:-}"
    [[ -z "${REMOTE_HOST}" ]] && err "Set DEPLOY_SG_LAB_HOST (e.g. export DEPLOY_SG_LAB_HOST=1.2.3.4)"
    [[ -z "${SSH_KEY}" || ! -f "${SSH_KEY}" ]] && err "Set DEPLOY_SSH_KEY to your SSH private key path"
    ;;
  *)
    err "Unknown env '${DEPLOY_ENV}'. Add a case block to extend."
    ;;
esac

ECOSYSTEM_LOCAL="${LOCAL_DIR}/ecosystem.config.${DEPLOY_ENV}.cjs"
[[ "${MODE}" != "status" && "${MODE}" != "setup" && ! -f "${ECOSYSTEM_LOCAL}" ]] && \
  err "Ecosystem config not found: ${ECOSYSTEM_LOCAL}"

[[ -f "${SSH_KEY}" ]] || err "SSH key not found: ${SSH_KEY}"

SSH_CMD="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=30 ${REMOTE_USER}@${REMOTE_HOST}"
RSYNC_SSH="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=30"
SUDO=""
[[ "${REMOTE_USER}" != "root" ]] && SUDO="sudo"

info "Environment: ${DEPLOY_ENV}"
info "Server:      ${REMOTE_USER}@${REMOTE_HOST}"
info "Remote dir:  ${REMOTE_DIR}"
[[ "${MODE}" != "status" && "${MODE}" != "setup" ]] && info "Ecosystem:   ${ECOSYSTEM_LOCAL}"
echo

ensure_remote_dir() {
  ${SSH_CMD} "${SUDO} mkdir -p ${REMOTE_DIR} && ${SUDO} chown -R ${REMOTE_USER}:${REMOTE_USER} ${REMOTE_DIR}"
}

do_setup() {
  info "=== First-time setup (${APP_NAME}) ==="
  ensure_remote_dir
  ${SSH_CMD} "${SUDO} bash -s" <<'INSTALL_NODE'
set -e
if command -v node &>/dev/null; then echo "Node: $(node -v)"
else curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
fi
INSTALL_NODE
  ${SSH_CMD} "command -v pm2 &>/dev/null || ${SUDO} npm install -g pm2"
  ${SSH_CMD} "${SUDO} ufw allow ${APP_PORT}/tcp 2>/dev/null || true"
  ok "Setup done — now run: ./deploy.sh --env ${DEPLOY_ENV}"
}

build_dist() {
  info "Building dist locally..."
  (cd "${LOCAL_DIR}" && npm run build)
  ok "Dist built"
}

do_sync_code() {
  info "Syncing code to ${REMOTE_HOST}:${REMOTE_DIR}..."
  build_dist
  ensure_remote_dir
  rsync -avz --delete \
    --include='ecosystem.config.example.cjs' \
    --exclude='ecosystem.config.cjs' \
    --exclude='ecosystem.config.*.cjs' \
    --exclude='node_modules' --exclude='.git' --exclude='.env' \
    -e "${RSYNC_SSH}" \
    "${LOCAL_DIR}/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"
  ok "Code synced"
}

do_sync_ecosystem() {
  scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no \
    "${ECOSYSTEM_LOCAL}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/ecosystem.config.cjs"
  ok "Ecosystem synced (${ECOSYSTEM_LOCAL} → ecosystem.config.cjs)"
}

do_install() {
  info "Installing dependencies..."
  ${SSH_CMD} "cd ${REMOTE_DIR} && npm ci --omit=dev 2>/dev/null || npm install --omit=dev"
  ok "Dependencies installed"
}

do_restart() {
  info "Restarting ${APP_NAME}..."
  ${SSH_CMD} "cd ${REMOTE_DIR} && pm2 startOrRestart ecosystem.config.cjs --update-env && pm2 save"
  sleep 2
  ${SSH_CMD} "curl -sf http://127.0.0.1:${APP_PORT}/health" && ok "Health check passed" || warn "Health check failed — run: pm2 logs ${APP_NAME}"
}

do_status() {
  info "=== PM2 Status ==="
  ${SSH_CMD} "pm2 status" || true
  echo
  info "=== Health Check ==="
  ${SSH_CMD} "curl -sf http://127.0.0.1:${APP_PORT}/health && echo" || warn "Health check failed"
}

case "${MODE}" in
  setup)   do_setup ;;
  status)  do_status ;;
  restart)
    ensure_remote_dir
    do_sync_ecosystem
    do_restart
    ;;
  sync)    do_sync_code ;;
  full)
    do_sync_code
    do_sync_ecosystem
    do_install
    do_restart
    ;;
esac
