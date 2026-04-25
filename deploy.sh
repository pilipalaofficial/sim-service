#!/usr/bin/env bash
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_DIR="/data/sim-service"
APP_NAME="sim-service"
APP_PORT="${SIM_SERVICE_HEALTH_PORT:-3500}"
SYSTEMD_UNIT_NAME="sim-service.service"
SYSTEMD_UNIT_TEMPLATE="${LOCAL_DIR}/deploy/systemd/sim-service.service.tpl"

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
  sg-lab-for-allen)
    REMOTE_HOST="18.143.183.71"
    REMOTE_USER="ubuntu"
    SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/Downloads/delta2-sg.pem}"
    [[ -f "${SSH_KEY}" ]] || err "SSH key not found: ${SSH_KEY}"
    ;;
  sg-relay-1)
    REMOTE_HOST="13.212.206.252"
    REMOTE_USER="ubuntu"
    SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/Downloads/delta2-sg.pem}"
    [[ -f "${SSH_KEY}" ]] || err "SSH key not found: ${SSH_KEY}"
    ;;
  sg-relay-2)
    REMOTE_HOST="13.229.94.3"
    REMOTE_USER="ubuntu"
    SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/Downloads/delta2-sg.pem}"
    [[ -f "${SSH_KEY}" ]] || err "SSH key not found: ${SSH_KEY}"
    ;;
  us-relay-1)
    REMOTE_HOST="54.227.77.170"
    REMOTE_USER="ubuntu"
    SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/Downloads/us-east.pem}"
    [[ -f "${SSH_KEY}" ]] || err "SSH key not found: ${SSH_KEY}"
    ;;
  us-relay-2)
    REMOTE_HOST="3.95.170.181"
    REMOTE_USER="ubuntu"
    SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/Downloads/us-east.pem}"
    [[ -f "${SSH_KEY}" ]] || err "SSH key not found: ${SSH_KEY}"
    ;;
  cn-relay-1)
    REMOTE_HOST="8.129.104.104"
    REMOTE_USER="root"
    SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/Downloads/ali-shenzhen.pem}"
    [[ -f "${SSH_KEY}" ]] || err "SSH key not found: ${SSH_KEY}"
    ;;
  *)
    err "Unknown env '${DEPLOY_ENV}'. Add a case block to extend."
    ;;
esac

[[ -f "${SSH_KEY}" ]] || err "SSH key not found: ${SSH_KEY}"

ENV_LOCAL="${LOCAL_DIR}/deploy/envs/${DEPLOY_ENV}.env"
[[ "${MODE}" != "status" && "${MODE}" != "setup" && ! -f "${ENV_LOCAL}" ]] && \
  err "Env file not found: ${ENV_LOCAL}"
[[ "${MODE}" != "status" && "${MODE}" != "setup" && ! -f "${SYSTEMD_UNIT_TEMPLATE}" ]] && \
  err "Systemd unit template not found: ${SYSTEMD_UNIT_TEMPLATE}"

SSH_CMD="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=30 ${REMOTE_USER}@${REMOTE_HOST}"
RSYNC_SSH="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=30"
SUDO=""
[[ "${REMOTE_USER}" != "root" ]] && SUDO="sudo"

info "Environment: ${DEPLOY_ENV}"
info "Server:      ${REMOTE_USER}@${REMOTE_HOST}"
info "Remote dir:  ${REMOTE_DIR}"
[[ "${MODE}" != "status" && "${MODE}" != "setup" ]] && info "Env file:    ${ENV_LOCAL}"
echo

ensure_remote_dir() {
  ${SSH_CMD} "${SUDO} mkdir -p ${REMOTE_DIR} && ${SUDO} chown -R ${REMOTE_USER}:${REMOTE_USER} ${REMOTE_DIR}"
}

render_systemd_unit() {
  local target="$1"
  sed \
    -e "s|__RUN_USER__|${REMOTE_USER}|g" \
    -e "s|__WORKDIR__|${REMOTE_DIR}|g" \
    "${SYSTEMD_UNIT_TEMPLATE}" > "${target}"
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
    --filter='protect .env' \
    --include='ecosystem.config.example.cjs' \
    --exclude='ecosystem.config.cjs' \
    --exclude='ecosystem.config.*.cjs' \
    --exclude='node_modules' --exclude='.git' --exclude='.env' \
    -e "${RSYNC_SSH}" \
    "${LOCAL_DIR}/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"
  ok "Code synced"
}

do_sync_env() {
  scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no \
    "${ENV_LOCAL}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/.env"
  ok "Environment synced (${ENV_LOCAL} → .env)"
}

do_sync_systemd_unit() {
  local rendered
  rendered="$(mktemp)"
  render_systemd_unit "${rendered}"
  scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no \
    "${rendered}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/${SYSTEMD_UNIT_NAME}"
  rm -f "${rendered}"
  ${SSH_CMD} "${SUDO} mv ${REMOTE_DIR}/${SYSTEMD_UNIT_NAME} /etc/systemd/system/${SYSTEMD_UNIT_NAME} && ${SUDO} systemctl daemon-reload"
  ok "Systemd unit synced (/etc/systemd/system/${SYSTEMD_UNIT_NAME})"
}

do_install() {
  info "Installing dependencies..."
  ${SSH_CMD} "cd ${REMOTE_DIR} && npm ci --omit=dev 2>/dev/null || npm install --omit=dev"
  ok "Dependencies installed"
}

do_restart() {
  info "Restarting ${APP_NAME}..."
  ${SSH_CMD} "${SUDO} systemctl enable --now ${SYSTEMD_UNIT_NAME} && ${SUDO} systemctl restart ${SYSTEMD_UNIT_NAME}"
  sleep 2
  ${SSH_CMD} "curl -sf http://127.0.0.1:${APP_PORT}/health" && ok "Health check passed" || warn "Health check failed — run: ${SUDO} journalctl -u ${SYSTEMD_UNIT_NAME} -n 100 --no-pager"
}

do_status() {
  info "=== systemd Status ==="
  ${SSH_CMD} "${SUDO} systemctl status ${SYSTEMD_UNIT_NAME} --no-pager -l" || true
  echo
  info "=== Health Check ==="
  ${SSH_CMD} "curl -sf http://127.0.0.1:${APP_PORT}/health && echo" || warn "Health check failed"
}

case "${MODE}" in
  setup)   do_setup ;;
  status)  do_status ;;
  restart)
    ensure_remote_dir
    do_sync_env
    do_sync_systemd_unit
    do_restart
    ;;
  sync)    do_sync_code ;;
  full)
    do_sync_code
    do_sync_env
    do_sync_systemd_unit
    do_install
    do_restart
    ;;
esac
