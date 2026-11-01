#!/usr/bin/env bash
# TapReview: перенос базы из Supabase на этот сервер.
#   sudo bash /opt/tapreview/site/server/migrate-data.sh
# Нужна строка подключения: Supabase → Project → кнопка «Connect» → «Session pooler» → URI
# (вида postgresql://postgres.xxxx:ПАРОЛЬ@aws-0-....pooler.supabase.com:5432/postgres).
# Повторный запуск ЗАМЕНЯЕТ данные на этом сервере свежей копией из Supabase.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo bash migrate-data.sh"; exit 1; }

read -rsp "Строка подключения к Supabase (Session pooler URI): " SRC; echo
DUMP="$(mktemp --suffix=.dump)"
chmod 644 "$DUMP"

echo "== Копирую данные из Supabase…"
/usr/lib/postgresql/17/bin/pg_dump "$SRC" --schema=public --no-owner --no-privileges --format=custom -f "$DUMP"

echo "== Загружаю в базу этого сервера…"
systemctl stop tapreview
sudo -u postgres psql -q -d tapreview -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
sudo -u postgres /usr/lib/postgresql/17/bin/pg_restore --no-owner --no-privileges -d tapreview "$DUMP" || \
  echo "(предупреждения выше обычно не страшны — проверьте счётчики ниже)"

echo "== Права для сайта"
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d tapreview <<'SQL'
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;
SQL
rm -f "$DUMP"

systemctl restart postgrest
sleep 2
systemctl start tapreview

echo "== Проверка: сколько строк перенесено"
sudo -u postgres psql -d tapreview -c "
SELECT 'заведения' AS таблица, count(*) FROM businesses
UNION ALL SELECT 'карты', count(*) FROM cards
UNION ALL SELECT 'события статистики', count(*) FROM click_events
UNION ALL SELECT 'ссылки статистики', count(*) FROM stats_links
UNION ALL SELECT 'коды подарков', count(*) FROM bonus_codes;"
echo "== Проверка через сайт:"
curl -s -o /dev/null -w "главная: %{http_code}\n" http://127.0.0.1:8787/
curl -s -o /dev/null -w "страница кафе /b/yarik: %{http_code}\n" -H "User-Agent: Mozilla/5.0" http://127.0.0.1:8787/b/yarik
echo "Готово."
