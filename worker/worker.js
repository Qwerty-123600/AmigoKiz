// Cloudflare Worker. Секреты: wrangler secret put V17_USER / V17_PASS / ADMIN_KEY / OTP_SECRET / ключи SMS-провайдера.
import { handle } from "./core.js";

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
// В Workers crypto.subtle поддерживает MD5 (нестандартное расширение Cloudflare).
const md5 = async (s) => hex(await crypto.subtle.digest("MD5", enc.encode(s)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const hmac = async (k, s) =>
  hex(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", enc.encode(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(s)));
// Цифры без перекоса: отбрасываем байты ≥ 250.
const digits = (n) => {
  let out = "";
  while (out.length < n) for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) if (b < 250 && out.length < n) out += b % 10;
  return out;
};
const kv = (ns) => ns && {
  get: (k) => ns.get(k, "json"),
  put: (k, v, ttl) => ns.put(k, JSON.stringify(v), { expirationTtl: Math.max(60, ttl) }),
  del: (k) => ns.delete(k),
};

export default {
  async fetch(req, env) {
    // KV-хранилище VIN_CACHE необязательно для VIN (без него каждый запрос идёт в 17Vin),
    // но обязательно для SMS-кодов: код и счётчики попыток хранятся там (ключи otp:*).
    const cache = kv(env.VIN_CACHE);
    return handle(req, env, { md5, sha256, hmac, digits, cache, store: cache });
  },
};
