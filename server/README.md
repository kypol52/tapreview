# TapReview на своём сервере в России

Тот же код сайта (`src/`), что работал на Cloudflare, запускается на обычном сервере:

```
Интернет → Caddy (HTTPS, tapreview.ru) → Node.js: server/server.mjs → src/index.js
                                                         ↓
                                     PostgREST (127.0.0.1:3000) → PostgreSQL (база)
```

| Файл | Что делает |
|---|---|
| `server/setup.sh` | Установка на чистый Ubuntu 24.04: база, PostgREST, Node.js, Caddy, брандмауэр, автообновление, резервные копии |
| `server/migrate-data.sh` | Перенос базы из Supabase (можно повторять — заменяет данные свежей копией) |
| `server/server.mjs` | Запуск сайта: файлы, код, отчёт по понедельникам |
| `server/make-password.mjs` | Новый хеш пароля админки (если пароль нужно сменить) |

## Настройки — `/etc/tapreview.env`

| Переменная | Что это |
|---|---|
| `DB_URL` | `http://127.0.0.1:3000` — база на этом сервере |
| `PUBLIC_BASE_URL` | `https://tapreview.ru` |
| `HASH_SALT` | секрет для обезличенного счёта посетителей |
| `ADMIN_EMAILS`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET` | вход в админку |
| `ORDERS_DIRECT=1` | форма заявок пишет прямо в базу этого сервера (она в России) |
| `TG_BOT_TOKEN`, `TG_WEBHOOK_SECRET` | Telegram-бот |

После изменения: `sudo systemctl restart tapreview`.

## Полезные команды

```
sudo systemctl status tapreview          # работает ли сайт
sudo journalctl -u tapreview -n 50       # последние сообщения сайта
sudo /usr/local/bin/tapreview-update     # забрать обновление из GitHub сейчас
ls /var/backups/tapreview                # резервные копии базы (14 дней)
```

Восстановить базу из копии:
`sudo -u postgres pg_restore --clean --if-exists -d tapreview /var/backups/tapreview/tapreview-ДАТА.dump`

## Обновления сайта

Как и раньше: загрузить файлы на GitHub. Сервер сам проверяет GitHub каждые 2 минуты и перезапускается,
если что-то изменилось. Миграции базы (`supabase/migrations/*.sql`) — запускать на сервере:
`sudo -u postgres psql -d tapreview -f /opt/tapreview/site/supabase/migrations/ФАЙЛ.sql`
