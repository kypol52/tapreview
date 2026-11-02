#!/usr/bin/env bash
# Копия базы TapReview на Яндекс Диск (вне этого сервера), каждую ночь после обычной копии.
#   - берёт свежую копию из /var/backups/tapreview (её делает tapreview-backup.timer в 03:30);
#   - шифрует её паролем шифрования (AES-256): даже с доступом к Диску данные не прочитать;
#   - кладёт в папку TapReview-backups на Диске под именем по дню месяца (tapreview-01 … tapreview-31):
#     старые копии сами заменяются, на Диске всегда ~31 последняя ночь;
#   - при успехе обновляет отметку /var/lib/tapreview-offsite/last-ok (её видит /health и сторож сайта).
# Настройки — /etc/tapreview-offsite.env (создаёт server/offsite-setup.sh).
set -euo pipefail
source /etc/tapreview-offsite.env

latest="$(ls -1t /var/backups/tapreview/*.dump 2>/dev/null | head -n 1 || true)"
[ -n "$latest" ] || { echo "Нет локальной копии базы" >&2; exit 1; }

tmp="$(mktemp /tmp/tapreview-offsite.XXXXXX)"
trap 'rm -f "$tmp"' EXIT
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$latest" -out "$tmp" -pass file:/etc/tapreview-offsite.key

dav="https://webdav.yandex.ru/TapReview-backups"
curl -fsS -u "${YADISK_LOGIN}:${YADISK_PASSWORD}" -X MKCOL "$dav/" -o /dev/null 2>/dev/null || true
curl -fsS --retry 3 -u "${YADISK_LOGIN}:${YADISK_PASSWORD}" -T "$tmp" "$dav/tapreview-$(date +%d).dump.enc" -o /dev/null

mkdir -p /var/lib/tapreview-offsite
chmod 755 /var/lib/tapreview-offsite
touch /var/lib/tapreview-offsite/last-ok
echo "Копия $(basename "$latest") выгружена на Яндекс Диск: TapReview-backups/tapreview-$(date +%d).dump.enc"
