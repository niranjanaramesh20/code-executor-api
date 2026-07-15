#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/niranjanaramesh20/code-executor-api.git"
APP_DIR="/opt/code-executor-api"
DB_NAME="codeexec"
DB_USER="coderunner"

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }

log "Updating apt"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git ufw

log "Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

log "Installing Node.js 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

log "Installing Redis, Postgres, Nginx"
apt-get install -y redis-server postgresql nginx
systemctl enable --now redis-server postgresql nginx

log "Installing PM2"
npm install -g pm2

log "Configuring PostgreSQL database + user"
DB_PASSWORD="$(openssl rand -hex 24)"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';"
# ensure password matches what we'll write to .env (in case user already existed)
sudo -u postgres psql -c "ALTER USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

log "Cloning / updating repo"
if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" fetch --all
  git -C "${APP_DIR}" reset --hard origin/main
else
  git clone "${REPO_URL}" "${APP_DIR}"
fi
cd "${APP_DIR}"

log "Installing npm dependencies"
npm ci --omit=dev

log "Loading database schema"
if [ -f db/init.sql ]; then
  PGPASSWORD="${DB_PASSWORD}" psql "host=localhost port=5432 dbname=${DB_NAME} user=${DB_USER}" -f db/init.sql || \
    echo "init.sql load reported an error (may be because tables already exist) - continuing"
fi

log "Writing .env"
JWT_SECRET="$(openssl rand -hex 48)"
cat > "${APP_DIR}/.env" <<EOF
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_HOST=localhost
DB_PORT=5432
DB_NAME=${DB_NAME}
REDIS_URL=redis://127.0.0.1:6379
PORT=5000
JWT_SECRET=${JWT_SECRET}
EOF
chmod 600 "${APP_DIR}/.env"

log "Pre-pulling language Docker images (this can take a few minutes)"
docker pull python:3.12-slim
docker pull node:22-alpine
docker pull gcc:14
docker pull eclipse-temurin:21

log "Starting app with PM2 (api + worker)"
cd "${APP_DIR}"
pm2 delete api worker >/dev/null 2>&1 || true
pm2 start server.js --name api
pm2 start workers/worker.js --name worker
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

log "Configuring Nginx reverse proxy (with websocket upgrade)"
cat > /etc/nginx/sites-available/codeexec <<'NGINX'
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/codeexec /etc/nginx/sites-enabled/codeexec
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "Configuring firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

log "DONE. Summary:"
echo "  App dir:   ${APP_DIR}"
echo "  DB:        ${DB_NAME} / user ${DB_USER}"
echo "  Secrets written to ${APP_DIR}/.env (chmod 600)"
pm2 status
