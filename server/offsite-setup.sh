#!/usr/bin/env bash
# Один раз: включить копии базы на Яндекс Диск. Запуск: sudo bash /opt/tapreview/site/server/offsite-setup.sh
# Нужен OAuth-токен Яндекс Диска с доступом только к папке приложения (как получить — server/README.md).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
SITE=/opt/tapreview/site

read -rsp "Токен Яндекс Диска (ввод не виден): " token; echo
token="$(printf '%s' "$token" | tr -d '[:space:]')"
[ -n "$token" ] || { echo "Пустой токен"; exit 1; }

umask 077
printf 'YADISK_TOKEN=%q\n' "$token" > /etc/tapreview-offsite.env

# Пароль шифрования копий создаётся один раз и больше не меняется
if [ ! -s /etc/tapreview-offsite.key ]; then
  openssl rand -base64 33 | tr -d '\n' > /etc/tapreview-offsite.key
fi

cat > /etc/systemd/system/tapreview-offsite.service <<UNIT
[Unit]
Description=TapReview: копия базы на Яндекс Диск
After=tapreview-backup.service
[Service]
Type=oneshot
ExecStart=/bin/bash ${SITE}/server/offsite-backup.sh
UNIT
cat > /etc/systemd/system/tapreview-offsite.timer <<'UNIT'
[Unit]
Description=TapReview: копия базы на Яндекс Диск каждую ночь
[Timer]
OnCalendar=*-*-* 03:45:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now tapreview-offsite.timer >/dev/null

echo "Делаю свежую копию и выгружаю…"
systemctl start tapreview-backup.service
if systemctl start tapreview-offsite.service; then
  journalctl -u tapreview-offsite.service -n 1 --no-pager -o cat
  OK=1
else
  echo "Не получилось. Причина:"
  journalctl -u tapreview-offsite.service -n 3 --no-pager -o cat | grep -v systemd || true
fi

# Пароль шифрования показываем, пока не было ни одной удачной выгрузки с ним (отметка .shown)
if [ ! -e /etc/tapreview-offsite.key.shown ]; then
  [ "${OK:-}" = 1 ] && touch /etc/tapreview-offsite.key.shown
  echo
  echo "=============================================================="
  echo " ПАРОЛЬ ШИФРОВАНИЯ КОПИЙ (без него копию не открыть):"
  echo
  echo "   $(cat /etc/tapreview-offsite.key)"
  echo
  echo " Сохраните его в менеджер паролей или запишите на бумаге."
  echo " НЕ отправляйте его в чаты. Если сервер пропадёт — он понадобится."
  echo "=============================================================="
fi
