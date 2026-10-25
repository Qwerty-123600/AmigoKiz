# myauto.tj: общая модель данных (сайт и приложение)

Пока бэкенда нет, сайт хранит всё локально (localStorage, ключ `myauto.db`) за слоем `API`, который потом заменится HTTP-запросами. Поля и правила ниже одинаковые для сайта и приложения.

## Модели
- **User** `{id, phone, name, city, type: "private"|"dealer", role: "user"|"staff"|"admin", createdAt}`. `role` по умолчанию `user`. `staff` — модератор (объявления, ДТП, жалобы на отзывы), `admin` — ещё подтверждение оплат и выдача ролей. Роль хранится только на сервере, см. «Роли и доступ». Код `STAFF-2026` убран. Телефон в формате `+992XXXXXXXXX`, уникальный. Пароль хранится только как хеш (на сервере: bcrypt/argon2; в прототипе SHA-256).
- **Listing** `{id, sellerId, status: "pending"|"active"|"rejected"|"sold"|"archived", b, m, g, y, km, usd, city, fuel, eng, hp, box, drive, body, cus, vin, photos: string[], desc, createdAt, submittedAt, approvedAt?, modBy?, modAt?, modReason?, modNote?, bumpedAt?, topUntil?, vipUntil?}`. Поля как у `CARS` сайта.
  - `modReason`: photos, price, contacts, dup, data, banned, other (тексты в `MOD_REASONS` сайта и приложения). `modNote` — комментарий модератора автору, до 300 символов.
  - `bumpedAt`, `topUntil`, `vipUntil` (мс) ставит только сервер при подтверждении оплаты.
- **Order** (платная услуга) `{id, userId, listingId, service: "up"|"top"|"vip", amount, currency: "TJS", method: "alif"|"dc"|"km", payRef, receipt?, status: "pending"|"confirmed"|"rejected", createdAt, decidedBy?, decidedAt?, startsAt?, endsAt?, rejectReason?: "notfound"|"amount"|"reused"|"other", rejectNote?}`.
  - Цены в прототипе: up 10 сом. (разово), top 40 сом. / 7 дней, vip 90 сом. / 7 дней. Это заглушки, меняются в `SERVICES`; на сервере цена берётся из его таблицы, сумме от клиента не верим.
- **AuditLog** `{at, by, act, target, note}`; `act`: approve, reject, block, pay_ok, pay_no, role, rev_hide, rev_keep. Пишется на каждое действие модератора и админа, не удаляется.
- **Review** `{id, sellerId, authorId, listingId?, rating: 1..5, deal: "bought"|"viewed"|"other", text, reply?: {text, at}, createdAt}`.

- **Incident** (ДТП и повреждения, основа будущей автотеки) `{id, vin, plate?: "0123AB01" (госномер латиницей без пробелов, необязательно; поиск по нему, но номер могут перевесить, главный ключ — VIN), kind, date: "YYYY-MM-DD", city, place, severity, parts: string[], airbags, repaired, evidence, docNo, desc, photos: string[], reporterId, reporterRole: "user"|"staff", status: "pending"|"verified"|"rejected", verifiedBy, verifiedAt, rejectReason, disputes: [{userId, text, at, closed}], createdAt, updatedAt?}`.
  - `kind`: accident (ДТП), damage, flood, fire, hail, theft, other. `severity`: minor, medium, severe.
  - `parts`: bumper_f, hood, fender_fl, fender_fr, door_fl, door_fr, door_rl, door_rr, fender_rl, fender_rr, roof, trunk, bumper_r (как схема кузова в карточке), плюс glass, frame, under, engine.
  - `airbags` и `repaired`: yes, no, unknown. `evidence`: none, photos, police (справка ГАИ), insurance, inspection (осмотр сотрудником, ставит только staff).
  - В прототипе хранится отдельно: сайт `localStorage["myauto.dtp"]`, приложение AsyncStorage `myauto.dtp`.

## Роли и доступ
- Роль никогда не приходит от клиента: `PATCH /me` поле `role` игнорирует, каждый `/admin/*` проверяет роль по токену в базе.
- Первого администратора задаёт владелец: переменная окружения сервера `OWNER_PHONES` (через запятую, формат `+992XXXXXXXXX`). Аккаунт с таким телефоном получает `admin` при регистрации и входе, снять эту роль из панели нельзя.
- Остальным роли выдаёт администратор: `PATCH /admin/users/:id {role}`. Нельзя снять роль с последнего администратора.
- Прототип без сервера (на сайте `APP_API` пуст): все данные в браузере, поэтому на странице `#admin` есть кнопки «Я администратор (демо)». Когда `APP_API` задан, кнопок нет, роль берётся из `GET /me`.

## Правила
- Подать объявление, написать продавцу и оставить отзыв можно только после входа.
- Один отзыв на продавца от одного автора (повторная отправка редактирует). Себе отзыв оставить нельзя.
- Текст отзыва от 10 символов. Отвечать на отзыв может только продавец, один ответ.
- Рейтинг продавца = среднее `rating` и число отзывов, округление до 0,1.
- VIN в объявлении необязателен; если указан: 17 символов, без I, O, Q.

### Модерация объявлений
- Новое объявление создаётся со `status: "pending"`. Любое изменение автором снова ставит `pending` (и уже одобренное объявление скрывается до повторной проверки).
- Покупатели видят только `active`. `pending` и `rejected` видят автор и модераторы, по прямой ссылке остальным «Объявление недоступно».
- Модератор одобряет (`active`, `approvedAt`) или отклоняет с причиной (`rejected`, `modReason`, `modNote`); активное может снять с публикации так же. Автор видит причину в кабинете, исправляет и отправляет снова.
- Сам автор переключает только `active` ↔ `sold` ↔ `archived`. Демо-объявления сайта (12 машин) модерацию не проходят.
- Подсказки модератору (не блокируют): телефон или ссылка в описании, нет VIN или неверная контрольная цифра, цена ниже $1500, похожее объявление у того же продавца, тот же VIN у другого продавца.

### Платные услуги
- Заказать можно только для своего `active` объявления. Пользователь платит переводом (Alif, DC Wallet, Корти Милли) и вводит номер операции из чека, по желанию скриншот. Создаётся `Order` со `status: "pending"`, услуга ещё не действует.
- Номер операции уникален в пределах способа оплаты (кроме отклонённых заказов). Одна ожидающая заявка на пару объявление + услуга.
- Подтверждает только `admin`, после того как нашёл платёж в выписке банка или кошелька. При подтверждении: `up` → `bumpedAt = now`; `top`/`vip` → `topUntil`/`vipUntil = max(now, текущий срок) + 7 дней`. Отклонение — с причиной, пользователь видит её в кабинете.
- Порядок в поиске по умолчанию: VIP, затем топ, затем по свежести (`bumpedAt` или `approvedAt`).
- Когда подключат эквайринг с вебхуком, `POST /payments/webhook` сможет подтверждать заказ сам; ручная проверка останется для переводов.

### Жалобы на отзывы
- `POST /reviews/:id/report` ставит отзыв в очередь модератора. Модератор скрывает отзыв (`hidden`) или закрывает жалобу.

### ДТП и повреждения
- Добавлять записи можно только после входа, анонимных нет. VIN обязателен: 17 символов, без I, O, Q, с верной контрольной цифрой там, где она обязательна.
- Дата не в будущем и не раньше 1980 года. Описание от 10 символов, фото до 6.
- Запись пользователя создаётся со `status: "pending"` и показывается всем с пометкой «Не проверено». Запись сотрудника сразу `verified`.
- Сотрудник подтверждает (`verified`) или отклоняет с причиной (`rejected`). Отклонённые видят только автор и сотрудники.
- Автор правит свою запись, пока она `pending`, и удаляет, пока она не `verified`. Сотрудник правит и удаляет любые.
- Один автор: одна запись на пару VIN + дата. Любой вошедший (кроме автора) может один раз оспорить запись; открытые возражения попадают в очередь сотрудника.
- Отсутствие записей по VIN никогда не показывается как «ДТП не было», только как «записей нет».

## Эндпоинты (для будущего сервера)
- `POST /otp/send {phone, purpose: "register"|"reset"}` → `{ok, via, resendIn}` и `POST /otp/verify {phone, code}` → `{ok, ticket}` — уже написаны, /vin-proxy/otp.js (README там же). Пока сервер в демо-режиме, `/otp/send` возвращает `demo:true, code`, и клиент показывает код на экране.
- `POST /auth/register {phone,name,city,password,ticket}` → `{user, token}`; сервер принимает только с действующим `ticket` от `/otp/verify` (`verifyTicket` в otp.js). Так же `POST /auth/reset {phone,password,ticket}`.
- `POST /auth/login {phone,password}` → `{user, token}`
- `GET /me`, `PATCH /me`
- `GET /listings?brand&city&...`, `GET /listings/:id`, `POST /listings`, `PATCH /listings/:id`, `DELETE /listings/:id` (только владелец)
- `GET /sellers/:id` → `{user, rating, count, listings}`
- `GET /sellers/:id/reviews`, `POST /sellers/:id/reviews`, `POST /reviews/:id/reply`, `POST /reviews/:id/report`

- `GET /incidents?vin=` (без `rejected`, кроме своих), `GET /incidents/:id`, `POST /incidents`, `PATCH /incidents/:id`, `DELETE /incidents/:id`
- `POST /incidents/:id/verify`, `POST /incidents/:id/reject {reason}` (только staff или admin), `POST /incidents/:id/dispute {text}`
- `GET /incidents/queue` (staff): `pending` и записи с открытыми возражениями. Выгрузка всей базы для переноса: JSON `{format: "myauto.incidents/1", items}`.

## Демо-данные
VIN Toyota Camry (объявление 1) теперь `4T1B11HK8KU123456` (контрольная цифра 8). Демо-продавцы: id `s1`…`s6`, демо-отзывы помечены `demo: true`.
Демо-записей о ДТП нет и не будет: база ДТП начинается пустой, чтобы не выдумывать историю.

## Эндпоинты модерации и оплат
- `GET /admin/listings?status=pending|active|rejected|sold|archived` (staff), `POST /admin/listings/:id/approve`, `POST /admin/listings/:id/reject {reason, note}`
- `POST /orders {listingId, service, method, payRef, receipt?}` → `Order`; `GET /orders/mine`
- `GET /admin/orders?status=pending` (admin), `POST /admin/orders/:id/confirm`, `POST /admin/orders/:id/reject {reason, note}`
- `GET /admin/reports` (staff), `POST /admin/reviews/:id/hide`, `POST /admin/reports/:id/dismiss`
- `GET /admin/users` и `PATCH /admin/users/:id {role}` (admin), `GET /admin/log` (staff)
- В прототипе всё это лежит в `localStorage["myauto.db"]`: `listings`, `orders`, `log`, `reports`, `hidden`, `dismissed`.
