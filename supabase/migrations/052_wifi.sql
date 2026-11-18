-- 052: Wi-Fi заведения на странице карты (src/wifi.js)
--   businesses.wifi_name     — название сети (SSID), до 32 символов; пусто — кнопки «Wi-Fi» нет
--   businesses.wifi_password — пароль, до 63 символов; пусто — открытая сеть без пароля
-- Пароль видит только гость, открывший страницу с карты (NFC или QR), — не по пересланной ссылке и не роботы превью.
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/052_wifi.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1

alter table public.businesses
  add column if not exists wifi_name text check (char_length(wifi_name) between 1 and 32),
  add column if not exists wifi_password text check (char_length(wifi_password) between 1 and 63);
