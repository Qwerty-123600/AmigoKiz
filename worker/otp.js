// Код подтверждения для регистрации, входа и сброса пароля: по SMS или в WhatsApp.
// Ключи провайдеров живут только здесь, в секретах сервера.
//
// Канал выбирает пользователь: /otp/send {channel:"sms"|"whatsapp"}. У каждого канала своя цепочка провайдеров.
// env: SMS_PROVIDER  "osonsms" | "telegram" | "twilio" | "demo" или цепочка через запятую ("telegram,osonsms":
//                    сначала Telegram, если у номера нет Telegram — SMS). Пусто = "demo": код возвращается в ответе.
//      OTP_SECRET    длинная случайная строка, обязательна для настоящей отправки.
//      OSON_LOGIN, OSON_SENDER, OSON_TOKEN (Bearer) и/или OSON_HASH (подпись str_hash), OSON_URL — OsonSMS.
//      TG_GATEWAY_TOKEN — Telegram Gateway. TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM — Twilio.
//      WA_PROVIDER   "whatsapp" | "demo" | "whatsapp,osonsms" (если Meta отказала сразу — SMS). Пусто = "demo".
//      WA_TOKEN, WA_PHONE_ID — WhatsApp Cloud API (Meta): постоянный токен системного пользователя и Phone number ID.
//      WA_TEMPLATE   имя одобренного шаблона категории Authentication (по умолчанию myauto_code), WA_LANG (ru),
//      WA_API_VERSION (v21.0).
//      SMS_TEXT      шаблон, {code} заменяется кодом.
// deps: { hmac(key,msg)→hex, sha256(str)→hex, digits(n)→string, store: {get,put(key,val,ttl),del} }

const LEN = 4;          // сайт и приложение ждут 4 цифры
const TTL = 300;        // код живёт 5 минут
const RESEND = 60;      // повторная отправка не раньше чем через минуту
const MAX_TRIES = 5;    // попыток ввода на один код
const PER_PHONE = 5;    // SMS на номер в час
const PER_IP = 20;      // SMS с одного IP в час
const TICKET_TTL = 900; // подтверждение номера действует 15 минут

/** Таджикский номер в виде 992XXXXXXXXX или null. */
export const phoneOf = (p) => {
  const d = String(p || "").replace(/\D/g, "").replace(/^992(?=\d{9}$)/, "");
  return /^\d{9}$/.test(d) ? "992" + d : null;
};

const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

/** Подпись «номер подтверждён». Будущий /auth/register проверяет её через verifyTicket, а не верит клиенту. */
async function makeTicket(deps, secret, phone, purpose) {
  const body = b64u(JSON.stringify({ phone: "+" + phone, purpose, exp: Math.floor(Date.now() / 1000) + TICKET_TTL }));
  return `${body}.${await deps.hmac(secret, body)}`;
}
export async function verifyTicket(deps, secret, ticket) {
  const [body, sig] = String(ticket || "").split(".");
  if (!body || sig !== (await deps.hmac(secret, body))) return null;
  const t = JSON.parse(unb64u(body));
  return t.exp > Date.now() / 1000 ? t : null;
}

// Каждый провайдер возвращает true, если сообщение принято, иначе бросает ошибку с причиной.
const PROVIDERS = {
  // WhatsApp Cloud API, шаблон Authentication с кнопкой «Скопировать код»: код идёт и в текст, и в кнопку.
  // Meta отвечает 200, даже если у номера нет WhatsApp (это приходит позже вебхуком), поэтому клиент
  // после таймера предлагает «Прислать по SMS».
  async whatsapp(env, deps, phone, text, code) {
    const r = await fetch(`https://graph.facebook.com/${env.WA_API_VERSION || "v21.0"}/${env.WA_PHONE_ID}/messages`, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${env.WA_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "template",
        template: {
          name: env.WA_TEMPLATE || "myauto_code", language: { code: env.WA_LANG || "ru" },
          components: [
            { type: "body", parameters: [{ type: "text", text: code }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
          ],
        },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || !(j.messages && j.messages.length)) throw new Error(`whatsapp: ${(j.error && `${j.error.code} ${j.error.message}`) || r.status}`);
    return true;
  },
  async osonsms(env, deps, phone, text) {
    const txn = `ma${Date.now()}${deps.digits(6)}`;
    const q = new URLSearchParams({ from: env.OSON_SENDER, phone_number: phone, msg: text, login: env.OSON_LOGIN, txn_id: txn });
    if (env.OSON_HASH) q.set("str_hash", await deps.sha256([txn, env.OSON_LOGIN, env.OSON_SENDER, phone, env.OSON_HASH].join(";")));
    const r = await fetch(`${env.OSON_URL || "https://api.osonsms.com/sendsms_v1.php"}?${q}`, {
      headers: env.OSON_TOKEN ? { authorization: `Bearer ${env.OSON_TOKEN}` } : {}, signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`osonsms: ${(j.error && (j.error.msg || j.error.code)) || r.status}`);
    return true;
  },
  async telegram(env, deps, phone, text, code) {
    const r = await fetch("https://gatewayapi.telegram.org/sendVerificationMessage", {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${env.TG_GATEWAY_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ phone_number: "+" + phone, code, ttl: TTL }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram: ${j.error || r.status}`);
    return true;
  },
  async twilio(env, deps, phone, text) {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { authorization: "Basic " + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: "+" + phone, From: env.TWILIO_FROM, Body: text }),
    });
    if (!r.ok) throw new Error(`twilio: ${(await r.json().catch(() => ({}))).message || r.status}`);
    return true;
  },
};

const chainOf = (s) => (s || "demo").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

/** POST /otp/send {phone, purpose, channel} и POST /otp/verify {phone, code}. json(body, status) уже с CORS. */
export async function handleOtp(req, env, deps, json) {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!deps.store) return json({ error: "no_store" }, 503);
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const channel = body.channel === "whatsapp" ? "whatsapp" : "sms";
  const chain = chainOf(channel === "whatsapp" ? env.WA_PROVIDER : env.SMS_PROVIDER);
  const demo = chain.includes("demo");
  if (chain.some((p) => p !== "demo" && !PROVIDERS[p])) return json({ error: "bad_provider" }, 503);
  // Секрет нужен, как только хоть один канал шлёт по-настоящему: иначе демо-канал подписывал бы ticket строкой "demo".
  const live = [env.SMS_PROVIDER, env.WA_PROVIDER].some((c) => chainOf(c).some((p) => p !== "demo"));
  if (live && !env.OTP_SECRET) return json({ error: "not_configured" }, 503);
  // Когда один канал настоящий, демо-канал отключён: он отдаёт код в ответе, и через него можно было бы
  // подтвердить чужой номер. Клиент предлагает выбрать другой способ.
  if (live && demo && new URL(req.url).pathname === "/otp/send") return json({ error: "channel_off", channel }, 503);
  const secret = env.OTP_SECRET || "demo";

  const phone = phoneOf(body.phone);
  if (!phone) return json({ error: "bad_phone" }, 400);
  const key = `otp:${phone}`, now = Date.now();
  const path = new URL(req.url).pathname;

  if (path === "/otp/send") {
    const purpose = ["reset", "login"].includes(body.purpose) ? body.purpose : "register";
    const prev = await deps.store.get(key);
    if (prev && now - prev.sentAt < RESEND * 1000) return json({ error: "too_soon", wait: Math.ceil(RESEND - (now - prev.sentAt) / 1000) }, 429);
    // Лимиты общие для SMS и WhatsApp и защищают баланс: без них бот за минуту разошлёт тысячи платных сообщений.
    const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "?";
    for (const [k, max] of [[`otpn:${phone}`, PER_PHONE], [`otpip:${ip}`, PER_IP]]) {
      const c = (await deps.store.get(k)) || { n: 0, since: now };
      if (c.n >= max) return json({ error: "too_many", wait: Math.ceil((c.since + 3600e3 - now) / 1000) }, 429);
      await deps.store.put(k, { n: c.n + 1, since: c.since }, Math.max(60, Math.ceil((c.since + 3600e3 - now) / 1000)));
    }

    const code = deps.digits(LEN);
    const text = (env.SMS_TEXT || "myauto.tj: код {code}. Никому его не сообщайте.").replace("{code}", code);
    let via = "demo";
    if (!demo) {
      const errors = [];
      for (const p of chain) {
        try { await PROVIDERS[p](env, deps, phone, text, code); via = p; break; } catch (e) { errors.push(String(e.message || e)); }
      }
      if (via === "demo") { console.log("otp send failed", phone.slice(0, 5) + "****", errors); return json({ error: "sms_failed" }, 502); }
    }
    await deps.store.put(key, { h: await deps.hmac(secret, `${phone}:${purpose}:${code}`), purpose, tries: 0, sentAt: now }, TTL);
    return json({ ok: true, via, channel, length: LEN, ttl: TTL, resendIn: RESEND, ...(demo ? { demo: true, code } : {}) }, 200);
  }

  if (path === "/otp/verify") {
    const rec = await deps.store.get(key);
    if (!rec || now - rec.sentAt > TTL * 1000) return json({ error: "expired" }, 400);
    if (rec.tries >= MAX_TRIES) { await deps.store.del(key); return json({ error: "too_many_tries" }, 429); }
    const code = String(body.code || "").replace(/\D/g, "");
    if (rec.h !== (await deps.hmac(secret, `${phone}:${rec.purpose}:${code}`))) {
      await deps.store.put(key, { ...rec, tries: rec.tries + 1 }, Math.max(60, Math.ceil(TTL - (now - rec.sentAt) / 1000)));
      return json({ error: "wrong_code", left: MAX_TRIES - rec.tries - 1 }, 400);
    }
    await deps.store.del(key);
    return json({ ok: true, purpose: rec.purpose, ticket: await makeTicket(deps, secret, phone, rec.purpose) }, 200);
  }

  return json({ error: "not_found" }, 404);
}
