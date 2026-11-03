# myauto.tj

Витрина myauto.tj: бесплатная расшифровка VIN и калькулятор растаможки для Таджикистана.

- `prototype/` — полный прототип сайта (объявления, аккаунты, ДТП, админка). Правки сайта делаются здесь.
- `tools/build.py` — собирает сайт из прототипа в `public/index.html`: полный сайт (объявления, вход через Telegram, кабинет, ДТП, штрафы). Урезанная витрина (только VIN и растаможка): `python3 tools/build.py --showcase`.
- `public/` — то, что видят посетители (собранный сайт, favicon, превью, robots, sitemap, заголовки безопасности).
- `worker/` — Cloudflare Worker: VIN-прокси к 17Vin, курс НБТ (`/rate`), SMS-коды (`/otp/*`). Подробности в `worker/PROXY.md`.
- `wrangler.jsonc` — настройки Worker `myauto`: статика из `public/`, KV `VIN_CACHE`, переменные.

## Деплой
Worker `myauto` подключён к этому репозиторию (Cloudflare → Workers Builds): каждый push в `main` выкладывается автоматически, примерно за минуту.
Секреты (`V17_USER`, `V17_PASS`, `ADMIN_KEY`, `OTP_SECRET`) задаются только в панели Cloudflare, в репозиторий их не класть.

Вручную: `npx wrangler deploy`.
