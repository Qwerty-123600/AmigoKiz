# myauto.tj

Витрина myauto.tj: бесплатная расшифровка VIN, калькулятор растаможки и проверка штрафов ГАИ для Таджикистана.

- `prototype/` — полный прототип сайта (объявления, аккаунты, ДТП, админка). Правки сайта делаются здесь.
- `tools/build.py` — собирает витрину из прототипа в `public/index.html` (скрывает объявления, аккаунты, оплату, демо-данные). Запуск: `python3 tools/build.py`.
- `public/` — то, что видят посетители (собранный сайт, favicon, превью, robots, sitemap, заголовки безопасности).
- `worker/` — Cloudflare Worker: VIN-прокси к 17Vin, курс НБТ (`/rate`), SMS-коды (`/otp/*`), штрафы ГАИ (`/fines`, ждёт провайдера). Подробности в `worker/PROXY.md`.
- `wrangler.jsonc` — настройки Worker `myauto`: статика из `public/`, KV `VIN_CACHE`, переменные.

## Деплой
Worker `myauto` подключён к этому репозиторию (Cloudflare → Workers Builds): каждый push в `main` выкладывается автоматически, примерно за минуту.
Секреты (`V17_USER`, `V17_PASS`, `ADMIN_KEY`, `OTP_SECRET`) задаются только в панели Cloudflare, в репозиторий их не класть.

Вручную: `npx wrangler deploy`.
