#!/usr/bin/env bash
# Копия базы TapReview на Яндекс Диск (вне этого сервера), каждую ночь после обычной копии.
#   - берёт свежую копию из /var/backups/tapreview (её делает tapreview-backup.timer в 03:30);
#   - шифрует её паролем шифрования (AES-256): даже с доступом к Диску данные не прочитать;
#   - кладёт через REST API Диска в папку приложения («Приложения/<имя приложения>» на Диске)
#     под именем по дню месяца (tapreview-01 … tapreview-31): старые копии сами заменяются;
#   - при успехе обновляет отметку /var/lib/tapreview-offsite/last-ok (её видит /health и сторож сайта).
# WebDAV не используем: для бесплатных аккаунтов Яндекс отвечает 402.
# Настройки — /etc/tapreview-offsite.env (YADISK_TOKEN, создаёт server/offsite-setup.sh).
set -euo pipefail
source /etc/tapreview-offsite.env

latest="$(ls -1t /var/backups/tapreview/*.dump 2>/dev/null | head -n 1 || true)"
[ -n "$latest" ] || { echo "Нет локальной копии базы" >&2; exit 1; }

tmp="$(mktemp /tmp/tapreview-offsite.XXXXXX)"
trap 'rm -f "$tmp"' EXIT
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$latest" -out "$tmp" -pass file:/etc/tapreview-offsite.key

name="tapreview-$(date +%d).dump.enc"
answer="$(curl -sS --retry 3 -H "Authorization: OAuth ${YADISK_TOKEN}" \
  "https://cloud-api.yandex.net/v1/disk/resources/upload?path=app:/${name}&overwrite=true")"
href="$(printf '%s' "$answer" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("href",""))' 2>/dev/null || true)"
[ -n "$href" ] || { echo "Яндекс Диск не дал адрес для загрузки: $answer" >&2; exit 1; }
curl -fsS --retry 3 -T "$tmp" "$href" -o /dev/null

mkdir -p /var/lib/tapreview-offsite
chmod 755 /var/lib/tapreview-offsite
touch /var/lib/tapreview-offsite/last-ok
echo "Копия $(basename "$latest") выгружена на Яндекс Диск: Приложения → ${name}"
