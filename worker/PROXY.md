# Сервер myauto.tj: прокси 17Vin, коды по SMS и WhatsApp

Сайт и приложение не знают пароля 17Vin. Они спрашивают этот прокси: `GET /vin/<VIN>`, а прокси считает токен и ходит в 17Vin.

## Как устроен запрос в 17Vin
- Сервер: `https://api.17vin.com:8443` (или `http://api.17vin.com:8080`).
- Расшифровка VIN (док. 3001): `/?vin=<VIN>&user=<логин>&token=<токен>`.
- Токен (док. 1003): `MD5( MD5(логин) + MD5(пароль) + "/?vin=<VIN>" )`. Формула проверена на примере из документации (`92882f5ad20cf8f3330e970af12b4214`).
- Баланс (док. 1002): `/?action=myapicount`, токен с `"/?action=myapicount"`.
- Коды: 1 успех, 0 нет данных, 1003 марка не поддерживается, 1004 неверный токен, 1005 закончился лимит.
- Каждый запрос списывает баланс, поэтому прокси кэширует ответ по VIN (60 дней).

## Ответ прокси
```json
{ "source":"17vin", "vin":"...", "found":true, "exact":true, "brand":"...", "year":"2015", "buildDate":"",
  "common": { "brand","model","series","version","engine","fuel","transmission","drive","body","factory","produced" },
  "variants": [ ...до 12 комплектаций... ], "variantCount": 2, "epc": [[["Col_name","Col_value"]]], "imported": [] }
```
`common` содержит только поля, одинаковые во всех подходящих комплектациях. Их сайт показывает как факт с меткой «17Vin».

## Вариант 1: Cloudflare Workers (бесплатно до 100 000 запросов в день)
```
npm i -g wrangler
wrangler login
wrangler secret put V17_USER      # international_myauto
wrangler secret put V17_PASS      # пароль от 17Vin
wrangler secret put ADMIN_KEY     # любая длинная строка, для /balance
wrangler kv namespace create VIN_CACHE   # id вписать в wrangler.toml
wrangler deploy
```
Если HTTPS-порт 8443 у 17Vin не ответит, раскомментируйте `V17_BASE = "http://api.17vin.com:8080"` в wrangler.toml.

## Вариант 2: любой VPS с Node 18+
```
V17_USER=... V17_PASS=... ALLOWED_ORIGINS=https://myauto.tj ADMIN_KEY=... PORT=8787 node server.js
```

## Подключение
- Сайт: в `myauto-site/index.html` вписать адрес в `const VIN_API="https://myauto-vin.<аккаунт>.workers.dev";`
- Приложение: в `.env` строка `EXPO_PUBLIC_VIN_API=https://...`
- Баланс: `GET /balance?key=<ADMIN_KEY>`

`ALLOWED_ORIGINS` ограничивает, какие сайты могут спрашивать прокси из браузера. Приложение заголовок origin не шлёт и проходит всегда.

## SMS-код при регистрации и сбросе пароля (otp.js)
Сайт и приложение не знают ключа SMS-сервиса: они просят код у этого сервера.
- `POST /otp/send {"phone":"+992931234567","purpose":"register"|"reset"}` → `{ok, via, length:4, ttl:300, resendIn:60}`; в демо-режиме ещё `demo:true, code`.
- `POST /otp/verify {"phone":"+992931234567","code":"1234"}` → `{ok, purpose, ticket}`. `ticket` — подпись «номер подтверждён» на 15 минут; будущий `/auth/register` проверяет её функцией `verifyTicket` из otp.js.
- Ошибки: `bad_phone`, `too_soon` / `too_many` (+`wait` в секундах), `sms_failed`, `wrong_code` (+`left`), `expired`, `too_many_tries`, `not_configured`.
- Защита баланса: код живёт 5 минут, 5 попыток ввода, повтор не чаще раза в минуту, не больше 5 SMS на номер и 20 с одного IP в час. Код хранится только как HMAC.

Провайдер выбирается переменной `SMS_PROVIDER` (можно цепочкой через запятую, следующий пробуется, если предыдущий не смог):
| Значение | Что нужно | Секреты |
|---|---|---|
| `demo` (по умолчанию) | ничего, код приходит в ответе и показывается на экране | — |
| `osonsms` | аккаунт на osonsms.com, одобренное имя отправителя (например `myauto.tj`), пополненный баланс | `OSON_LOGIN`, `OSON_SENDER`, `OSON_TOKEN` (Bearer-токен из кабинета) и/или `OSON_HASH` (хеш для подписи `str_hash`) |
| `telegram` | аккаунт на gateway.telegram.org, пополненный баланс; код придёт в Telegram | `TG_GATEWAY_TOKEN` |
| `twilio` | аккаунт Twilio, номер или Sender ID с разрешением на Таджикистан | `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` |

Для настоящей отправки обязателен `OTP_SECRET` (любая длинная случайная строка). Пример для Cloudflare:
```
wrangler secret put OTP_SECRET
wrangler secret put OSON_LOGIN
wrangler secret put OSON_SENDER
wrangler secret put OSON_TOKEN     # или OSON_HASH
# в wrangler.toml: SMS_PROVIDER = "osonsms"   (или "telegram,osonsms": дешевле, SMS только тем, у кого нет Telegram)
```
SMS-коды хранятся в том же KV `VIN_CACHE` (ключи `otp:*`), поэтому в Worker он обязателен. На VPS всё лежит в памяти процесса.
Проверено локально (Node, демо-режим и OsonSMS через заглушку); настоящий OsonSMS не проверялся: нужен аккаунт.

### Вход только через Telegram (добавлено 03.11.2026)
На сайте и в приложении нет пароля, SMS и WhatsApp: человек вводит номер и код, который пришёл в Telegram (Telegram Gateway). Есть аккаунт с этим номером — это вход, нет — после кода спрашиваем имя и город.
- `POST /otp/send {..., "channel":"whatsapp"|"telegram"|"sms"}` (без `channel` — `"sms"`, для старых клиентов). В ответе есть `channel` и `via`. `purpose`: `"login"` или `"register"` (`"reset"` больше не нужен).
- У каждого канала своя цепочка: `WA_PROVIDER`, `TG_PROVIDER`, `SMS_PROVIDER`. Значения: `demo` (по умолчанию), `whatsapp`, `telegram`, `osonsms`, `twilio`; через запятую — запасной провайдер при мгновенном отказе.
- **WhatsApp** (Cloud API от Meta, сейчас не используется клиентами, код оставлен на будущее): секреты `WA_TOKEN` (постоянный токен системного пользователя, право `whatsapp_business_messaging`), `WA_PHONE_ID` (Phone number ID). Переменные `WA_TEMPLATE` (`myauto_code`), `WA_LANG` (`ru`), `WA_API_VERSION` (`v21.0`). Шаблон в WhatsApp Manager: категория **Authentication**, русский, кнопка «Скопировать код». Meta отвечает «принято», даже если у номера нет WhatsApp.
- **Telegram** (Telegram Gateway, gateway.telegram.org): секрет `TG_GATEWAY_TOKEN`, баланс в кабинете. Код приходит в чат «Verification Codes». В `wrangler.jsonc` уже стоит `TG_PROVIDER: "telegram"`, поэтому до деплоя в Cloudflare должны быть секреты `TG_GATEWAY_TOKEN` и `OTP_SECRET`, иначе вход отвечает `not_configured`.
- Если хоть один канал настоящий, а выбранный остался `demo`, сервер отвечает `503 {error:"channel_off", channel}`: демо отдаёт код в ответе, и через него можно было бы войти в чужой аккаунт. Лимиты (5 в час на номер, 20 с IP, повтор раз в минуту) общие для всех каналов.
```
wrangler secret put OTP_SECRET
wrangler secret put TG_GATEWAY_TOKEN
```
Проверено локально с заглушками Graph API и Telegram Gateway; настоящие WhatsApp и Telegram не проверялись: нужны аккаунты.

## Лимиты и курс НБТ (добавлено 23.10.2026)
- `/vin/:vin` без кэша: не больше `VIN_PER_IP` (30) запросов с одного IP в час и `VIN_PER_DAY` (300) всего в сутки, иначе `429 {error:"too_many", wait}`. Повторный VIN из кэша лимит не тратит. Нужен KV `VIN_CACHE`.
- `GET /rate` → `{usd, eur, date, source:"nbt.tj"}`: курс НБТ на сегодня (по Душанбе), кэш 6 часов. Адрес выгрузки можно сменить переменной `NBT_URL` (`{date}` = ГГГГ-ММ-ДД). Разбор XML проверен только на образце: сайт nbt.tj недоступен из облачной среды разработки.

## Общая база сайта (worker/store.js, добавлено 03.11.2026)
Аккаунты, объявления, фото, отзывы, жалобы, заказы услуг, журнал модерации, ДТП и избранное лежат в одном Durable Object `Store` (SQLite, бесплатный план). Все запросы идут в один экземпляр "main" по очереди, поэтому одновременные изменения не теряются.
- `POST /auth/login {phone, ticket}` → `{token, state}` или `404 {error:"no_user"}`; `POST /auth/register {phone, ticket, name, city, type}` → `{token, state}`. `ticket` — из `/otp/verify`, без него войти нельзя.
- `GET /api/state` (заголовок `Authorization: Bearer <token>`) → то, что видно этому пользователю: активные объявления всех, свои любые, модератору все; телефон есть только у продавцов с активными объявлениями (админу — у всех).
- `POST /api/op {op, args}` → `{ok, result, state}`. Операции: updateMe, favs, saveListing, setStatus, removeListing, saveReview, reply, report, approve, reject, order, confirm, decline, hideReview, keepReview, setRole, dtpSave, dtpVerify, dtpReject, dtpRemove, dtpDispute. Права и правила проверяет сервер, роль берётся только из базы.
- Фото приходят как `data:image/...`, сервер сохраняет их отдельно и отдаёт по `/photo/<id>`.
- Первый администратор: переменная `OWNER_PHONES` (через запятую, `+992XXXXXXXXX`) в `wrangler.jsonc`. Такой аккаунт получает роль admin при входе, снять её нельзя.
- Сайт: `APP_API` в `public/index.html` подставляет `tools/build.py` (тот же адрес). В прототипе `APP_API` пуст, и всё по-прежнему хранится в браузере.
