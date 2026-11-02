#!/usr/bin/env bash
# Один раз: включить копии базы на Яндекс Диск. Запуск: sudo bash /opt/tapreview/site/server/offsite-setup.sh
# Нужен пароль приложения Яндекса (id.yandex.ru → Безопасность → Пароли приложений → Файлы / WebDAV).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
SITE=/opt/tapreview/site

read -rp "Логин Яндекса (без @yandex.ru): " login
read -rsp "Пароль приложения (не основной пароль, ввод не виден): " pass; echo

umask 077
printf 'YADISK_LOGIN=%q\nYADISK_PASSWORD=%q\n' "$login" "$pass" > /etc/tapreview-offsite.env

# Пароль шифрования копий создаётся один раз и больше не меняется
if [ ! -s /etc/tapreview-offsite.key ]; then
  openssl rand -base64 33 | tr -d '\n' > /etc/tapreview-offsite.key
  NEW_KEY=1
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
systemctl start tapreview-offsite.service && journalctl -u tapreview-offsite.service -n 1 --no-pager -o cat

if [ "${NEW_KEY:-}" = 1 ]; then
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
