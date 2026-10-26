// Штрафы ГАИ по госномеру и техпаспорту. Своей базы нет: запрос уходит провайдеру из FINES_URL.
// FINES_URL — адрес с подстановкой {plate} (и {doc}, если провайдер всё же требует техпаспорт; сайт его не спрашивает), FINES_KEY (секрет) уходит заголовком Authorization: Bearer.
// Пока FINES_URL не задан, отвечаем not_configured, и сайт честно пишет, что база не подключена.
const PLATE_RE = /^[A-Z0-9]{5,10}$/;
const DOC_RE = /^[A-Z0-9]{6,14}$/;

/** Ответ провайдера → { fines:[{id,date,text,place,amount,paid,camera}] }. Поля провайдера разбираем с запасом на разные имена. */
export function normalizeFines(j) {
  const list = Array.isArray(j) ? j : j && (j.fines || j.items || j.data || j.result);
  if (!Array.isArray(list)) return null;
  const num = (v) => Math.round((parseFloat(String(v ?? "").replace(",", ".")) || 0) * 100) / 100;
  return list.map((f) => ({
    id: String(f.id ?? f.number ?? f.resolution ?? f.uin ?? ""),
    date: String(f.date ?? f.datetime ?? f.violation_date ?? ""),
    text: String(f.text ?? f.article ?? f.description ?? f.violation ?? ""),
    place: String(f.place ?? f.address ?? f.location ?? ""),
    amount: num(f.amount ?? f.sum ?? f.fine),
    paid: !!(f.paid ?? (f.status === "paid")),
    camera: !!(f.camera ?? f.photo),
  }));
}

export async function fines(url, env, deps, ip, json) {
  if (!env.FINES_URL) return json({ error: "not_configured" }, 503);
  const plate = (url.searchParams.get("plate") || "").toUpperCase();
  const doc = (url.searchParams.get("doc") || "").toUpperCase();
  if (!PLATE_RE.test(plate) || (doc && !DOC_RE.test(doc))) return json({ error: "bad_input" }, 400);

  // Ключ кэша — хэш, чтобы номер не лежал в KV открытым текстом.
  const key = `fines:${await deps.sha256(plate + "|" + doc)}`;
  const hit = deps.cache && (await deps.cache.get(key));
  if (hit) return json({ ...hit, cached: true }, 200);

  if (deps.cache) {
    const now = Date.now(), k = `finesip:${ip}`, max = +env.FINES_PER_IP || 20, win = 3600e3;
    const c = (await deps.cache.get(k)) || { n: 0, since: now };
    if (c.n >= max) return json({ error: "too_many", wait: Math.ceil((c.since + win - now) / 1000) }, 429);
    await deps.cache.put(k, { n: c.n + 1, since: c.since }, Math.ceil((c.since + win - now) / 1000));
  }

  let r, j;
  try {
    r = await fetch(env.FINES_URL.replace("{plate}", plate).replace("{doc}", encodeURIComponent(doc)), {
      headers: env.FINES_KEY ? { authorization: `Bearer ${env.FINES_KEY}`, accept: "application/json" } : { accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    j = await r.json();
  } catch (e) {
    return json({ error: "upstream_unreachable" }, 502);
  }
  if (r.status === 404) return json({ error: "not_found" }, 404);
  const list = r.ok && normalizeFines(j);
  if (!list) return json({ error: "upstream", status: r.status }, 502);
  const out = { source: env.FINES_SOURCE || "gai", checked: new Date().toISOString(), fines: list };
  // Штрафы меняются: держим недолго, только чтобы повторное нажатие не стоило запроса.
  if (deps.cache) await deps.cache.put(key, out, 1800);
  return json(out, 200);
}
