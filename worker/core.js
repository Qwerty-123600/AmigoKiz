// Прокси myauto.tj → 17Vin. Пароль 17Vin живёт только здесь, в переменных окружения сервера.
// Общая логика для Cloudflare Worker (worker.js) и обычного Node-сервера (server.js).
// Здесь же SMS-коды для регистрации (otp.js): тот же сервер, те же правила CORS.
import { handleOtp } from "./otp.js";

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/** token = MD5(MD5(user) + MD5(pass) + url_parameters), см. en.17vin.com/doc/1003.html */
export async function token17(md5, user, pass, params) {
  return md5((await md5(user)) + (await md5(pass)) + params);
}

const pick = (...xs) => xs.find((x) => x !== undefined && x !== null && String(x).trim() !== "" && x !== "-");

/** Сводит ответ 3001 к короткому виду, одинаковому для сайта и приложения. */
export function normalize(vin, j) {
  const d = j.data || {};
  const list = Array.isArray(d.model_list) ? d.model_list : [];
  const variants = list.slice(0, 12).map((m) => ({
    brand: pick(m.Brand_en, m.Brand),
    model: pick(m.Model_en, m.Model, m.Series_en, m.Series),
    series: pick(m.Series_en, m.Series),
    version: pick(m.Sales_version_en, m.Sales_version, m.Model_detial_en, m.Model_detail),
    year: pick(m.Model_year),
    engine: [pick(m.Cc) && `${m.Cc} л`, pick(m.Engine_no_en, m.Engine_no), pick(m.Air_intake_en, m.Air_intake)].filter(Boolean).join(", ") || undefined,
    fuel: pick(m.Fule_type_en, m.Fuel_type_en, m.Fuel_type),
    transmission: [pick(m.Transmission_detail_en, m.Transmission_detail), pick(m.Gear_num_en, m.Gear_num)].filter(Boolean).join(", ") || undefined,
    drive: pick(m.Driving_mode_en, m.Driving_mode),
    body: pick(m.Body_type),
    doors: pick(m.Door_num),
    seats: pick(m.Seat_num),
    factory: pick(m.Factory_en, m.Factory),
    produced: [pick(m.Date_begin), pick(m.Date_end)].filter(Boolean).join(" — ") || undefined,
    price: pick(m.Price),
  }));
  // Поля, одинаковые во всех подходящих комплектациях: их можно показывать как факт.
  const common = {};
  if (variants.length) {
    for (const k of Object.keys(variants[0])) {
      const v = variants[0][k];
      if (v !== undefined && variants.every((x) => x[k] === v)) common[k] = v;
    }
  }
  // Оригинальные данные EPC производителя: самые надёжные, но структура разная у каждой марки.
  const epc = (d.model_original_epc_list || []).slice(0, 3).map((e) =>
    (e.CarAttributes || [])
      .filter((a) => a.Col_value && (a.Language === "en" || !(e.CarAttributes || []).some((b) => b.Language === "en")))
      .slice(0, 30)
      .map((a) => [a.Col_name, a.Col_value]),
  );
  const imp = (d.model_import_list || []).slice(0, 5).map((m) => ({
    brand: pick(m.Make_en, m.Make_cn), model: pick(m.Model_en, m.Model_cn), body: pick(m.Body_style_en, m.Body_style_cn),
    engine: pick(m.Engine_en, m.Engine_cn, m.Cc_en), trim: pick(m.Trim_en, m.Trim_cn),
    transmission: pick(m.Transmission_en, m.Transmission_cn), drive: pick(m.Driveline_en, m.Driveline_cn),
  }));
  const found = variants.length > 0 || epc.some((x) => x.length) || imp.length > 0;
  return {
    source: "17vin", vin, found,
    exact: d.matching_mode === "exact_match",
    brand: pick(d.brand, common.brand, imp[0] && imp[0].brand),
    year: pick(d.model_year_from_vin, common.year),
    buildDate: pick(d.build_date),
    common, variants, variantCount: list.length, epc: epc.filter((x) => x.length), imported: imp,
  };
}

const json = (body, status, cors) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...cors } });

/**
 * env: V17_USER, V17_PASS (секреты), V17_BASE (по умолчанию https://api.17vin.com:8443),
 *      ALLOWED_ORIGINS (через запятую, "*" для теста), ADMIN_KEY (для /balance).
 *      SMS-коды: см. otp.js (SMS_PROVIDER, OTP_SECRET, ключи провайдера).
 * deps: { md5(str)→hex, cache: {get(key), put(key,val)} | null, + для otp.js: hmac, sha256, digits, store }
 */
export async function handle(req, env, deps) {
  const url = new URL(req.url);
  const origin = req.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const cors = allowed.includes("*") || allowed.includes(origin)
    ? { "access-control-allow-origin": allowed.includes("*") ? "*" : origin, vary: "origin" } : {};
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
  // Браузер с чужого сайта не получит ответ; мобильное приложение заголовка origin не шлёт.
  if (origin && !cors["access-control-allow-origin"]) return json({ error: "origin" }, 403, cors);
  if (url.pathname.startsWith("/otp/")) return handleOtp(req, env, deps, (b, s) => json(b, s, cors));
  if (req.method !== "GET") return json({ error: "method" }, 405, cors);
  if (url.pathname === "/rate") return rate(env, deps, cors);
  if (!env.V17_USER || !env.V17_PASS) return json({ error: "not_configured" }, 503, cors);
  const base = (env.V17_BASE || "https://api.17vin.com:8443").replace(/\/$/, "");

  if (url.pathname === "/balance") {
    if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403, cors);
    const p = "/?action=myapicount";
    const r = await fetch(`${base}${p}&user=${encodeURIComponent(env.V17_USER)}&token=${await token17(deps.md5, env.V17_USER, env.V17_PASS, p)}`);
    return json(await r.json(), 200, cors);
  }

  const m = url.pathname.match(/^\/vin\/([A-Za-z0-9]+)$/);
  if (!m) return json({ error: "not_found" }, 404, cors);
  const vin = m[1].toUpperCase();
  if (!VIN_RE.test(vin)) return json({ error: "bad_vin" }, 400, cors);

  // Каждый запрос к 17Vin списывает баланс, поэтому один и тот же VIN берём из кэша.
  const key = `v17:${vin}`;
  const hit = deps.cache && (await deps.cache.get(key));
  if (hit) return json({ ...hit, cached: true }, 200, cors);

  // Лимиты защищают баланс 17Vin: без них перебор VIN (curl без Origin) спишет его за минуты.
  if (deps.cache) {
    const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "?";
    const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
    for (const [k, max, win] of [[`vinip:${ip}`, +env.VIN_PER_IP || 30, 3600e3], [`vinday:${day}`, +env.VIN_PER_DAY || 300, 86400e3]]) {
      const c = (await deps.cache.get(k)) || { n: 0, since: now };
      if (c.n >= max) return json({ error: "too_many", wait: Math.ceil((c.since + win - now) / 1000) }, 429, cors);
      await deps.cache.put(k, { n: c.n + 1, since: c.since }, Math.max(60, Math.ceil((c.since + win - now) / 1000)));
    }
  }

  const p = `/?vin=${vin}`;
  let j;
  try {
    const r = await fetch(`${base}${p}&user=${encodeURIComponent(env.V17_USER)}&token=${await token17(deps.md5, env.V17_USER, env.V17_PASS, p)}`,
      { signal: AbortSignal.timeout(12000) });
    j = await r.json();
  } catch (e) {
    return json({ error: "upstream_unreachable" }, 502, cors);
  }
  // Коды 17Vin: 1 успех, 0 нет данных, 1003 марка не поддерживается, 1004 неверный токен, 1005 закончился баланс.
  if (j.code === 0 || j.code === 1003) {
    const out = { source: "17vin", vin, found: false, code: j.code };
    if (deps.cache) await deps.cache.put(key, out, 86400);
    return json(out, 200, cors);
  }
  if (j.code !== 1) return json({ error: "upstream", code: j.code, msg: j.msg }, 502, cors);
  const out = normalize(vin, j);
  if (deps.cache) await deps.cache.put(key, out, 60 * 86400);
  return json(out, 200, cors);
}

/** Курс НБТ (сомони за 1 USD и 1 EUR) для калькулятора растаможки, кэш 6 часов. */
export function parseNbt(xml) {
  const val = (code) => {
    const m = xml.match(new RegExp(`<CharCode>\\s*${code}\\s*</CharCode>[\\s\\S]*?<Nominal>\\s*([\\d.,]+)\\s*</Nominal>[\\s\\S]*?<Value>\\s*([\\d.,]+)\\s*</Value>`, "i"));
    if (!m) return null;
    const v = parseFloat(m[2].replace(",", ".")) / (parseFloat(m[1].replace(",", ".")) || 1);
    return v > 0 ? Math.round(v * 10000) / 10000 : null;
  };
  return { usd: val("USD"), eur: val("EUR") };
}

async function rate(env, deps, cors) {
  const hit = deps.cache && (await deps.cache.get("nbt:rate"));
  if (hit) return json({ ...hit, cached: true }, 200, cors);
  // Дата по Душанбе (UTC+5): НБТ публикует курс на календарный день.
  const date = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  const src = (env.NBT_URL || "https://nbt.tj/ru/kurs/export_xml.php?date={date}&export=xmlout").replace("{date}", date);
  try {
    const r = await fetch(src, { signal: AbortSignal.timeout(8000) });
    const out = { ...parseNbt(await r.text()), date, source: "nbt.tj" };
    if (!out.usd) return json({ error: "rate_parse" }, 502, cors);
    if (deps.cache) await deps.cache.put("nbt:rate", out, 6 * 3600);
    return json(out, 200, cors);
  } catch (e) {
    return json({ error: "rate_unreachable" }, 502, cors);
  }
}
