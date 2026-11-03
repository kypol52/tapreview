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
| `APP_BOT_TOKEN` | токен бота Mini App для гостей (секрет: им проверяется подпись входа) |
| `APP_BOT_USERNAME`, `APP_SHORT_NAME` | имя бота без @ и короткое имя приложения из @BotFather — для ссылок t.me/бот/приложение |

После изменения: `sudo systemctl restart tapreview`.

## Полезные команды

```
sudo systemctl status tapreview          # работает ли сайт
sudo journalctl -u tapreview -n 50       # последние сообщения сайта
sudo /usr/local/bin/tapreview-update     # забрать обновление из GitHub сейчас
ls /var/backups/tapreview                # резервные копии базы (14 дней)
curl -s 127.0.0.1:8787/health            # база жива? сколько часов назад копия ушла на Яндекс Диск
```

Восстановить базу из копии:
`sudo -u postgres pg_restore --clean --if-exists -d tapreview /var/backups/tapreview/tapreview-ДАТА.dump`

## Копии на Яндекс Диске (если сервер пропал)

Токен (один раз, срок около года — потом получить заново и снова запустить offsite-setup.sh):
1. oauth.yandex.ru → «Создать приложение»: название «TapReview backup», платформа «Веб-сервисы»,
   Redirect URI `https://oauth.yandex.ru/verification_code`, доступ «Яндекс Диск REST API → Доступ к папке
   приложения на Диске». Скопировать ClientID.
2. Открыть `https://oauth.yandex.ru/authorize?response_type=token&client_id=CLIENTID` → «Разрешить» → токен.

Включить: `sudo bash /opt/tapreview/site/server/offsite-setup.sh` (спросит токен). Каждую ночь в 03:45
зашифрованная копия кладётся на Диск в «Приложения → TapReview backup» (`tapreview-ДД.dump.enc`, ДД — день месяца).
Сторож сайта пишет в Telegram, если копия старше 2 суток. (WebDAV не подходит: бесплатным аккаунтам Яндекс отвечает 402.)

Восстановить на новом сервере (после `setup.sh`): скачать файл с Диска, затем
```
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in tapreview-ДД.dump.enc -out tapreview.dump   # спросит пароль шифрования
sudo -u postgres pg_restore --clean --if-exists -d tapreview tapreview.dump
```

## Обновления сайта

Как и раньше: загрузить файлы на GitHub. Сервер сам проверяет GitHub каждые 2 минуты и перезапускается,
если что-то изменилось. Миграции базы (`supabase/migrations/*.sql`) — запускать на сервере:
`sudo cat /opt/tapreview/site/supabase/migrations/ФАЙЛ.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1`
(не `-f`: у пользователя postgres нет доступа к папке сайта — будет «Permission denied»)
