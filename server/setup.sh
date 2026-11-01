#!/usr/bin/env bash
# TapReview: установка на чистый сервер Ubuntu 24.04 (Россия).
#   curl -fsSLo setup.sh https://raw.githubusercontent.com/kypol52/tapreview/main/server/setup.sh && sudo bash setup.sh
#
# Ставит: PostgreSQL 17 (база), PostgREST (доступ к базе для кода сайта, только изнутри сервера),
# Node.js 22 (код сайта), Caddy (HTTPS для tapreview.ru), брандмауэр, автообновление сайта из GitHub
# каждые 2 минуты, ежедневную резервную копию базы. Повторный запуск безопасен.
set -euo pipefail

DOMAIN="tapreview.ru"
REPO="https://github.com/kypol52/tapreview.git"
APP_DIR="/opt/tapreview"
SITE="$APP_DIR/site"
ENV_FILE="/etc/tapreview.env"
PGREST_VERSION="v12.2.3"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo bash setup.sh"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say "Файл подкачки (страховка для серверов с 1–2 ГБ памяти)"
if ! swapon --show | grep -q . && [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-tapreview-swap.conf
fi
free -h | head -2

say "Пакеты системы"
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg git ufw xz-utils openssl \
  debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades

say "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
node -v

say "PostgreSQL 17"
if ! command -v /usr/lib/postgresql/17/bin/postgres >/dev/null; then
  apt-get install -y -q postgresql-common
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  apt-get install -y -q postgresql-17
fi

say "Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

say "PostgREST $PGREST_VERSION"
if ! /usr/local/bin/postgrest --version 2>/dev/null | grep -q "${PGREST_VERSION#v}"; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/pgrst.tar.xz" \
    "https://github.com/PostgREST/postgrest/releases/download/${PGREST_VERSION}/postgrest-${PGREST_VERSION}-linux-static-x64.tar.xz"
  tar -xJf "$tmp/pgrst.tar.xz" -C "$tmp"
  install -m 755 "$tmp/postgrest" /usr/local/bin/postgrest
  rm -rf "$tmp"
fi
/usr/local/bin/postgrest --version

say "Пользователь и код сайта"
id tapreview >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin tapreview
if [ ! -d "$SITE/.git" ]; then
  sudo -u tapreview git clone -q "$REPO" "$SITE"
else
  sudo -u tapreview git -C "$SITE" pull -q --ff-only || true
fi

say "База данных"
if [ ! -f /etc/postgrest.conf ]; then
  DB_PASS="$(openssl rand -hex 24)"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
SELECT 'CREATE DATABASE tapreview' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'tapreview')\gexec
\c tapreview
DO \$\$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
DO \$\$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
-- Как у Supabase: сервер сайта работает от service_role, ему не мешают правила доступа (RLS)
DO \$\$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
DO \$\$ BEGIN CREATE ROLE authenticator LOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
ALTER ROLE authenticator PASSWORD '${DB_PASS}';
GRANT service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO service_role;
SQL
  cat > /etc/postgrest.conf <<CONF
db-uri = "postgres://authenticator:${DB_PASS}@127.0.0.1:5432/tapreview"
db-schemas = "public"
db-anon-role = "service_role"
db-pool = 10
server-host = "127.0.0.1"
server-port = 3000
CONF
  chmod 600 /etc/postgrest.conf
fi

say "Настройки сайта ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  read -rp "Email для входа в админку: " ADMIN_EMAIL
  while true; do
    read -rsp "Пароль для админки (не меньше 10 символов): " ADMIN_PW; echo
    [ "${#ADMIN_PW}" -ge 10 ] && break
    echo "Слишком короткий"
  done
  ADMIN_HASH="$(cd "$SITE" && ADMIN_PW="$ADMIN_PW" node --input-type=module -e \
    'import { hashPassword } from "./src/admin-auth.js"; console.log(await hashPassword(process.env.ADMIN_PW));')"
  read -rp "Токен Telegram-бота от @BotFather (Enter — заполню позже): " TG_TOKEN
  cat > "$ENV_FILE" <<ENV
PORT=8787
PUBLIC_BASE_URL=https://${DOMAIN}
DB_URL=http://127.0.0.1:3000
HASH_SALT=$(openssl rand -hex 32)
ADMIN_EMAILS=${ADMIN_EMAIL}
ADMIN_PASSWORD_HASH=${ADMIN_HASH}
ADMIN_SESSION_SECRET=$(openssl rand -hex 32)
ORDERS_DIRECT=1
TG_BOT_TOKEN=${TG_TOKEN}
TG_WEBHOOK_SECRET=$(openssl rand -hex 24)
ENV
  chmod 640 "$ENV_FILE"
  chown root:tapreview "$ENV_FILE"
fi

say "Службы"
cat > /etc/systemd/system/postgrest.service <<'UNIT'
[Unit]
Description=PostgREST (доступ к базе для сайта TapReview)
After=postgresql.service
Requires=postgresql.service
[Service]
ExecStart=/usr/local/bin/postgrest /etc/postgrest.conf
Restart=always
RestartSec=2
User=postgres
[Install]
WantedBy=multi-user.target
UNIT
chown root:postgres /etc/postgrest.conf
chmod 640 /etc/postgrest.conf

cat > /etc/systemd/system/tapreview.service <<UNIT
[Unit]
Description=TapReview (сайт)
After=network-online.target postgrest.service
Wants=network-online.target
[Service]
User=tapreview
WorkingDirectory=${SITE}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${SITE}/server/server.mjs
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT

# Автообновление: раз в 2 минуты забираем изменения из GitHub; если код изменился — перезапуск
cat > /usr/local/bin/tapreview-update <<SCRIPT
#!/usr/bin/env bash
set -e
cd ${SITE}
sudo -u tapreview git fetch -q origin main
if [ "\$(sudo -u tapreview git rev-parse HEAD)" != "\$(sudo -u tapreview git rev-parse origin/main)" ]; then
  sudo -u tapreview git reset -q --hard origin/main
  systemctl restart tapreview
  echo "Обновлено до \$(sudo -u tapreview git rev-parse --short HEAD)"
fi
SCRIPT
chmod 755 /usr/local/bin/tapreview-update
cat > /etc/systemd/system/tapreview-update.service <<'UNIT'
[Unit]
Description=TapReview: обновление из GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/bin/tapreview-update
UNIT
cat > /etc/systemd/system/tapreview-update.timer <<'UNIT'
[Unit]
Description=TapReview: проверять обновления каждые 2 минуты
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT

# Резервная копия базы каждую ночь, храним 14 дней
mkdir -p /var/backups/tapreview
chown postgres:postgres /var/backups/tapreview
chmod 700 /var/backups/tapreview
cat > /etc/systemd/system/tapreview-backup.service <<'UNIT'
[Unit]
Description=TapReview: резервная копия базы
[Service]
Type=oneshot
User=postgres
ExecStart=/bin/bash -c 'pg_dump -Fc tapreview > /var/backups/tapreview/tapreview-$(date +%%F).dump && find /var/backups/tapreview -name "*.dump" -mtime +14 -delete'
UNIT
cat > /etc/systemd/system/tapreview-backup.timer <<'UNIT'
[Unit]
Description=TapReview: резервная копия базы каждую ночь
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT

say "HTTPS (Caddy)"
IP="$(curl -4 -fsS https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
TEST_HOST="${IP//./-}.sslip.io"
cat > /etc/caddy/Caddyfile <<CADDY
# ${TEST_HOST} — временный адрес для проверки до переключения домена
${DOMAIN}, www.${DOMAIN}, ${TEST_HOST} {
	@www host www.${DOMAIN}
	redir @www https://${DOMAIN}{uri} permanent
	encode zstd gzip
	reverse_proxy 127.0.0.1:8787
}
CADDY

say "Брандмауэр"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable --now postgresql postgrest tapreview tapreview-update.timer tapreview-backup.timer >/dev/null
systemctl restart postgrest tapreview caddy

say "Готово"
echo "Сервер:            ${IP}"
echo "Проверочный адрес: https://${TEST_HOST}/"
echo "Дальше: перенос базы — sudo bash ${SITE}/server/migrate-data.sh"
