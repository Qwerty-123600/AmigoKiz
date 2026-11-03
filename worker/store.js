// Общая база myauto.tj: аккаунты, объявления, отзывы, жалобы, заказы услуг, журнал модерации, ДТП, избранное.
// Один Durable Object "main" на весь сайт: запросы выполняются строго по очереди, поэтому гонок нет.
// Правила те же, что в прототипе (prototype/index.html, DATA-CONTRACT.md), но решает сервер:
// роль берётся только из базы, сумма услуги — из SERVICES ниже, номер телефона — только из подтверждённого кода.
//
// Маршруты (все ответы JSON, кроме /photo/*):
//   POST /auth/login    {phone, ticket}                 → {token, state} | {error:"no_user"}
//   POST /auth/register {phone, ticket, name, city, type} → {token, state}
//   POST /auth/logout                                    → {ok}
//   GET  /api/state                                      → state (что видно этому пользователю)
//   POST /api/op        {op, args}                       → {ok, result, state} | {error}
//   GET  /photo/<id>                                     → image/jpeg
// Токен: заголовок Authorization: Bearer <token>, живёт 90 дней.
import { verifyTicket, phoneOf } from "./otp.js";

const SERVICES = { up: { price: 10, days: 0 }, top: { price: 40, days: 7 }, vip: { price: 90, days: 7 } };
const PAYM = ["alif", "dc", "km"];
const MOD_REASONS = ["photos", "price", "contacts", "dup", "data", "banned", "other"];
const PAY_REASONS = ["notfound", "amount", "reused", "other"];
const ROLES = ["user", "staff", "admin"];
const CITY = ["dushanbe", "khujand", "bokhtar", "kulob", "hisor", "tursunzoda", "vahdat", "khorog"];
const DTP = {
  kind: ["accident", "damage", "flood", "fire", "hail", "theft", "other"],
  sev: ["minor", "medium", "severe"],
  evid: ["none", "photos", "police", "insurance", "inspection"],
  rep: ["unknown", "yes", "no"],
  bag: ["unknown", "yes", "no"],
  part: ["bumper_f", "hood", "fender_fl", "fender_fr", "door_fl", "door_fr", "door_rl", "door_rr", "fender_rl", "fender_rr", "roof", "trunk", "bumper_r", "glass", "frame", "under", "engine"],
};
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const TOKEN_TTL = 90 * 864e5;
const MAX_PHOTOS = 12;
const COLLS = ["users", "listings", "reviews", "reports", "orders", "log", "hidden", "dismissed", "incidents", "favs"];

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
const str = (v, n) => String(v ?? "").trim().slice(0, n);
const today = () => new Date(Date.now() + 5 * 36e5).toISOString().slice(0, 10); // Душанбе, UTC+5
const rnd = (n = 16) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const FN_LAT = { "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "Y" };
const plateClean = (s) => String(s || "").toUpperCase().replace(/[АВЕКМНОРСТХУ]/g, (c) => FN_LAT[c]).replace(/[^A-Z0-9]/g, "");
class Fail extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
const fail = (code, status) => { throw new Fail(code, status); };

export class Store {
  constructor(state, env) {
    this.st = state.storage;
    this.env = env;
    this.D = null;
  }

  async load() {
    if (this.D) return this.D;
    const got = await this.st.get(COLLS.map((k) => "c:" + k));
    const D = {};
    for (const k of COLLS) D[k] = got.get("c:" + k) ?? (k === "favs" ? {} : []);
    D.next = (await this.st.get("next")) || 1000;
    this.D = D;
    return D;
  }
  // Пишем только изменённые коллекции: у каждой свой ключ (лимит значения 2 МБ, фото лежат отдельно).
  async persist(keys) {
    const D = this.D, put = {};
    for (const k of keys) put["c:" + k] = D[k];
    put.next = D.next;
    await this.st.put(put);
  }

  owners() { return String(this.env.OWNER_PHONES || "").split(",").map((p) => phoneOf(p)).filter(Boolean).map((p) => "+" + p); }

  async session(req) {
    const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!/^[0-9a-f]{48}$/.test(t)) return null;
    const s = await this.st.get("tok:" + t);
    if (!s || s.exp < Date.now()) return null;
    const u = this.D.users.find((x) => x.id === s.uid);
    if (!u || u.blocked) return null;
    return { token: t, user: u };
  }
  async newToken(uid) {
    const t = rnd(24);
    await this.st.put("tok:" + t, { uid, exp: Date.now() + TOKEN_TTL });
    return t;
  }

  async ticketPhone(body) {
    const secret = this.env.OTP_SECRET || "demo";
    const deps = {
      hmac: async (k, s) => {
        const e = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", e.encode(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, e.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
      },
    };
    const t = await verifyTicket(deps, secret, String(body.ticket || ""));
    const p = phoneOf(body.phone);
    if (!t || !p || t.phone !== "+" + p) fail("bad_ticket", 401);
    return "+" + p;
  }

  // ---------- что видит пользователь ----------
  view(me) {
    const D = this.D, mod = me && ["staff", "admin"].includes(me.role), adm = me && me.role === "admin";
    const sellers = new Set(D.listings.filter((l) => l.status === "active").map((l) => l.sellerId));
    const users = D.users.map((u) => {
      const pub = { id: u.id, name: u.name, city: u.city, type: u.type, createdAt: u.createdAt };
      if (adm || (me && u.id === me.id) || sellers.has(u.id)) pub.phone = u.phone;
      if (mod || (me && u.id === me.id)) pub.role = u.role || "user";
      return pub;
    });
    const listings = D.listings.filter((l) => mod || l.status === "active" || (me && l.sellerId === me.id));
    const reviews = D.reviews.filter((r) => mod || !D.hidden.includes(r.id));
    const reports = mod ? [...new Set(D.reports.map((r) => r.id))] : me ? D.reports.filter((r) => r.by === me.id).map((r) => r.id) : [];
    const orders = adm ? D.orders : me ? D.orders.filter((o) => o.userId === me.id) : [];
    const incidents = D.incidents.filter((r) => mod || r.status !== "rejected" || (me && r.reporterId === me.id));
    return {
      me: me ? me.id : null, users, listings, reviews, reports, orders,
      log: mod ? D.log.slice(0, 500) : [], hidden: mod ? D.hidden : [], dismissed: mod ? D.dismissed : [],
      incidents, favs: me ? D.favs[me.id] || [] : [], at: Date.now(),
    };
  }

  // ---------- фото: data:image/... → /photo/<id> ----------
  async photos(list, max) {
    const out = [];
    for (const p of (Array.isArray(list) ? list : []).slice(0, max)) {
      if (typeof p !== "string") continue;
      if (/^\/photo\/[0-9a-f]{32}$/.test(p)) { out.push(p); continue; }
      const m = p.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) continue;
      if (m[2].length > 1.4e6) fail("photo_big");
      const id = rnd(16);
      await this.st.put("ph:" + id, { type: "image/" + m[1], b64: m[2] });
      out.push("/photo/" + id);
    }
    return out;
  }

  // ---------- операции ----------
  async op(me, name, a) {
    const D = this.D, now = Date.now();
    const need = () => { if (!me) fail("auth", 401); };
    const isMod = () => me && ["staff", "admin"].includes(me.role), isAdm = () => me && me.role === "admin";
    const log = (act, target, note) => { D.log.unshift({ at: now, by: me.id, act, target: String(target), note: note || "" }); if (D.log.length > 2000) D.log.length = 2000; };
    const listing = (id) => D.listings.find((l) => l.id === +id);
    const okId = (id, re, coll) => (re.test(String(id || "")) && !coll.some((x) => x.id === id) ? id : null);

    switch (name) {
      case "updateMe": {
        need();
        if (a.name !== undefined) { const n = str(a.name, 60); if (n.length < 2) fail("name"); me.name = n; }
        if (a.city !== undefined && CITY.includes(a.city)) me.city = a.city;
        if (a.type !== undefined && ["private", "dealer"].includes(a.type)) me.type = a.type;
        return { keys: ["users"] };
      }
      case "favs": {
        need();
        D.favs[me.id] = [...new Set((a.ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 500);
        return { keys: ["favs"] };
      }
      case "saveListing": {
        need();
        const l = a.listing || {};
        const c = {
          b: str(l.b, 40), m: str(l.m, 60), g: str(l.g, 40), y: +l.y | 0, km: Math.max(0, +l.km | 0), usd: Math.max(0, +l.usd | 0),
          city: CITY.includes(l.city) ? l.city : "dushanbe", fuel: str(l.fuel, 30), eng: str(l.eng, 30) || "—", box: str(l.box, 30),
          drive: str(l.drive, 30), body: str(l.body, 40), cus: str(l.cus, 30), hp: +l.hp | 0 || "", vin: str(l.vin, 17).toUpperCase(), desc: str(l.desc, 3000),
        };
        if (!c.b || !c.m) fail("model");
        if (c.y < 1950 || c.y > new Date().getFullYear() + 1) fail("year");
        if (c.usd < 300) fail("price");
        if (c.vin && !VIN_RE.test(c.vin)) fail("vin");
        c.photos = await this.photos(l.photos, MAX_PHOTOS);
        if (!c.photos.length) fail("photos");
        if (l.id && listing(l.id)) {
          const old = listing(l.id);
          if (old.sellerId !== me.id) fail("owner", 403);
          Object.assign(old, c, { updatedAt: now, status: "pending", submittedAt: now });
          return { keys: ["listings"], result: old };
        }
        const id = Number.isInteger(+l.id) && +l.id > 12 && !listing(l.id) ? +l.id : ++D.next;
        const n = { ...c, id, sellerId: me.id, status: "pending", createdAt: now, submittedAt: now };
        D.listings.push(n);
        return { keys: ["listings"], result: n };
      }
      case "setStatus": {
        need();
        const l = listing(a.id), ok = ["active", "sold", "archived"];
        if (!l || l.sellerId !== me.id) fail("owner", 403);
        if (!ok.includes(l.status) || !ok.includes(a.status)) fail("state");
        if (a.status === "active" && l.status !== "active" && !l.approvedAt) fail("state");
        l.status = a.status;
        return { keys: ["listings"] };
      }
      case "removeListing": {
        need();
        const l = listing(a.id);
        if (!l || (l.sellerId !== me.id && !isMod())) fail("owner", 403);
        D.listings = D.listings.filter((x) => x !== l);
        return { keys: ["listings"] };
      }
      case "saveReview": {
        need();
        const sid = str(a.sellerId, 40), rating = +a.rating | 0, text = str(a.text, 1500);
        if (!sid || sid === me.id) fail("self");
        if (!/^s[1-6]$/.test(sid) && !D.users.some((u) => u.id === sid)) fail("seller");
        if (rating < 1 || rating > 5) fail("rating");
        if (text.length < 10) fail("text");
        const deal = ["bought", "viewed", "other"].includes(a.deal) ? a.deal : "other";
        const listingId = a.listingId ? +a.listingId || null : null;
        const ex = D.reviews.find((r) => r.sellerId === sid && r.authorId === me.id);
        if (ex) Object.assign(ex, { rating, deal, listingId, text, editedAt: now });
        else D.reviews.push({ id: okId(a.id, /^r[0-9a-z]{6,20}$/, D.reviews) || "r" + rnd(6), sellerId: sid, authorId: me.id, rating, deal, listingId, text, createdAt: now, reply: null });
        return { keys: ["reviews"] };
      }
      case "reply": {
        need();
        const r = D.reviews.find((x) => x.id === a.id), text = str(a.text, 1000);
        if (!r || r.sellerId !== me.id || r.reply) fail("no");
        if (text.length < 2) fail("text");
        r.reply = { text, at: now };
        return { keys: ["reviews"] };
      }
      case "report": {
        need();
        if (!D.reports.some((r) => r.id === a.id && r.by === me.id)) D.reports.push({ id: str(a.id, 40), by: me.id, at: now });
        return { keys: ["reports"] };
      }
      // ---- модерация ----
      case "approve": {
        if (!isMod()) fail("role", 403);
        const l = listing(a.id);
        if (!l || l.status !== "pending") fail("state");
        Object.assign(l, { status: "active", approvedAt: now, modBy: me.id, modAt: now, modReason: null, modNote: "" });
        log("approve", l.id);
        return { keys: ["listings", "log"] };
      }
      case "reject": {
        if (!isMod()) fail("role", 403);
        const l = listing(a.id);
        if (!l || !["pending", "active"].includes(l.status)) fail("state");
        if (!MOD_REASONS.includes(a.reason)) fail("reason");
        const note = str(a.note, 300);
        if (a.reason === "other" && note.length < 5) fail("note");
        const act = l.status === "active" ? "block" : "reject";
        Object.assign(l, { status: "rejected", modBy: me.id, modAt: now, modReason: a.reason, modNote: note });
        log(act, l.id, str(a.logNote, 400));
        return { keys: ["listings", "log"] };
      }
      case "order": {
        need();
        const l = listing(a.listingId);
        if (!l || l.sellerId !== me.id) fail("owner", 403);
        if (l.status !== "active") fail("inactive");
        if (!SERVICES[a.service]) fail("service");
        if (!PAYM.includes(a.method)) fail("method");
        const ref = String(a.payRef || "").replace(/\s+/g, "").toUpperCase().slice(0, 40);
        if (ref.length < 4) fail("ref");
        if (D.orders.some((o) => o.status !== "rejected" && o.method === a.method && o.payRef === ref)) fail("reused");
        if (D.orders.some((o) => o.status === "pending" && o.listingId === l.id && o.service === a.service)) fail("dup");
        const receipt = a.receipt ? (await this.photos([a.receipt], 1))[0] || null : null;
        const o = { id: okId(a.id, /^o[0-9a-z]{6,20}$/, D.orders) || "o" + rnd(6), userId: me.id, listingId: l.id, service: a.service,
          amount: SERVICES[a.service].price, currency: "TJS", method: a.method, payRef: ref, receipt, status: "pending", createdAt: now };
        D.orders.push(o);
        return { keys: ["orders"], result: o };
      }
      case "confirm": {
        if (!isAdm()) fail("role", 403);
        const o = D.orders.find((x) => x.id === a.id);
        if (!o || o.status !== "pending") fail("state");
        const l = listing(o.listingId), s = SERVICES[o.service];
        if (l) {
          if (o.service === "up") { l.bumpedAt = now; o.startsAt = now; }
          else { const k = o.service + "Until", from = Math.max(now, l[k] || 0); l[k] = from + s.days * 864e5; o.startsAt = from; o.endsAt = l[k]; }
        }
        Object.assign(o, { status: "confirmed", decidedBy: me.id, decidedAt: now });
        log("pay_ok", o.id, str(a.logNote, 400));
        return { keys: ["orders", "listings", "log"] };
      }
      case "decline": {
        if (!isAdm()) fail("role", 403);
        const o = D.orders.find((x) => x.id === a.id);
        if (!o || o.status !== "pending") fail("state");
        if (!PAY_REASONS.includes(a.reason)) fail("reason");
        const note = str(a.note, 300);
        if (a.reason === "other" && note.length < 5) fail("note");
        Object.assign(o, { status: "rejected", decidedBy: me.id, decidedAt: now, rejectReason: a.reason, rejectNote: note });
        log("pay_no", o.id, str(a.logNote, 400));
        return { keys: ["orders", "log"] };
      }
      case "hideReview": {
        if (!isMod()) fail("role", 403);
        if (!D.hidden.includes(a.id)) D.hidden.push(str(a.id, 40));
        log("rev_hide", a.id);
        return { keys: ["hidden", "log"] };
      }
      case "keepReview": {
        if (!isMod()) fail("role", 403);
        if (!D.dismissed.includes(a.id)) D.dismissed.push(str(a.id, 40));
        log("rev_keep", a.id);
        return { keys: ["dismissed", "log"] };
      }
      case "setRole": {
        if (!isAdm()) fail("role", 403);
        const u = D.users.find((x) => x.id === a.id);
        if (!u || !ROLES.includes(a.role)) fail("bad");
        if (this.owners().includes(u.phone) && a.role !== "admin") fail("owner_role");
        if (u.role === "admin" && a.role !== "admin" && D.users.filter((x) => x.role === "admin").length < 2) fail("last");
        u.role = a.role;
        log("role", u.id, str(a.logNote, 200));
        return { keys: ["users", "log"] };
      }
      // ---- ДТП ----
      case "dtpSave": {
        need();
        const rec = a.rec || {}, staff = isMod();
        const vin = str(rec.vin, 17).toUpperCase();
        if (!VIN_RE.test(vin)) fail("vin");
        if (!DTP.kind.includes(rec.kind)) fail("kind");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.date || "") || rec.date > today() || rec.date < "1980-01-01") fail("date");
        const desc = str(rec.desc, 1500);
        if (desc.length < 10) fail("desc");
        const ev = DTP.evid.includes(rec.evidence) ? rec.evidence : "none";
        if (ev === "inspection" && !staff) fail("evid");
        const plate = plateClean(rec.plate);
        if (plate && !/^[A-Z0-9]{4,10}$/.test(plate)) fail("plate");
        const c = { vin, plate, kind: rec.kind, date: rec.date, city: CITY.includes(rec.city) ? rec.city : "", place: str(rec.place, 120),
          severity: DTP.sev.includes(rec.severity) ? rec.severity : "medium", parts: [...new Set(rec.parts || [])].filter((k) => DTP.part.includes(k)),
          airbags: DTP.bag.includes(rec.airbags) ? rec.airbags : "unknown", repaired: DTP.rep.includes(rec.repaired) ? rec.repaired : "unknown",
          evidence: ev, docNo: str(rec.docNo, 60), desc, photos: await this.photos(rec.photos, 6) };
        const old = rec.id && D.incidents.find((r) => r.id === rec.id);
        if (old) {
          if (!(staff || (old.reporterId === me.id && old.status === "pending"))) fail("owner", 403);
          Object.assign(old, c, { updatedAt: now, updatedBy: me.id });
          return { keys: ["incidents"], result: old };
        }
        if (D.incidents.some((r) => r.vin === vin && r.date === c.date && r.reporterId === me.id && r.status !== "rejected")) fail("dup");
        const n = { ...c, id: okId(rec.id, /^i[0-9a-z]{6,20}$/, D.incidents) || "i" + rnd(6), reporterId: me.id, reporterRole: staff ? "staff" : "user",
          status: staff ? "verified" : "pending", verifiedBy: staff ? me.id : null, verifiedAt: staff ? now : null, rejectReason: null, disputes: [], createdAt: now };
        D.incidents.push(n);
        return { keys: ["incidents"], result: n };
      }
      case "dtpVerify":
      case "dtpReject": {
        if (!isMod()) fail("staff", 403);
        const r = D.incidents.find((x) => x.id === a.id);
        if (!r) fail("no");
        if (name === "dtpVerify") Object.assign(r, { status: "verified", verifiedBy: me.id, verifiedAt: now, rejectReason: null });
        else Object.assign(r, { status: "rejected", verifiedBy: me.id, verifiedAt: now, rejectReason: str(a.reason, 300) });
        (r.disputes || []).forEach((d) => (d.closed = true));
        return { keys: ["incidents"] };
      }
      case "dtpRemove": {
        need();
        const r = D.incidents.find((x) => x.id === a.id);
        if (!r) return { keys: [] };
        if (!(isMod() || (r.reporterId === me.id && r.status !== "verified"))) fail("owner", 403);
        D.incidents = D.incidents.filter((x) => x !== r);
        return { keys: ["incidents"] };
      }
      case "dtpDispute": {
        need();
        const r = D.incidents.find((x) => x.id === a.id), text = str(a.text, 600);
        if (!r || r.reporterId === me.id) fail("own");
        if (text.length < 10) fail("text");
        if ((r.disputes || []).some((d) => d.userId === me.id)) fail("dup");
        (r.disputes = r.disputes || []).push({ userId: me.id, text, at: now, closed: false });
        return { keys: ["incidents"] };
      }
    }
    fail("bad_op");
  }

  async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    await this.load();
    try {
      const ph = path.match(/^\/photo\/([0-9a-f]{32})$/);
      if (ph) {
        const p = await this.st.get("ph:" + ph[1]);
        if (!p) return new Response("not found", { status: 404 });
        return new Response(Uint8Array.from(atob(p.b64), (c) => c.charCodeAt(0)), { headers: { "content-type": p.type, "cache-control": "public, max-age=31536000, immutable" } });
      }
      const s = await this.session(req);
      if (path === "/api/state" && req.method === "GET") return json(this.view(s && s.user));
      if (req.method !== "POST") return json({ error: "method" }, 405);
      let body = {};
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

      if (path === "/auth/login" || path === "/auth/register") {
        const phone = await this.ticketPhone(body);
        let u = this.D.users.find((x) => x.phone === phone);
        if (path === "/auth/login" && !u) return json({ error: "no_user" }, 404);
        if (path === "/auth/register") {
          if (u) return json({ error: "exists" }, 409);
          const name = str(body.name, 60);
          if (name.length < 2) fail("name");
          u = { id: "u" + rnd(6), phone, name, city: CITY.includes(body.city) ? body.city : "dushanbe", type: body.type === "dealer" ? "dealer" : "private", role: "user", createdAt: Date.now() };
          this.D.users.push(u);
        }
        if (u.blocked) fail("blocked", 403);
        if (this.owners().includes(u.phone) && u.role !== "admin") u.role = "admin";
        await this.persist(["users"]);
        return json({ token: await this.newToken(u.id), state: this.view(u) });
      }
      if (path === "/auth/logout") { if (s) await this.st.delete("tok:" + s.token); return json({ ok: true }); }
      if (path === "/api/op") {
        const me = s && s.user;
        const r = await this.op(me, String(body.op || ""), body.args || {});
        if (r.keys.length) await this.persist(r.keys);
        return json({ ok: true, result: r.result ?? null, state: this.view(me) });
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      if (e instanceof Fail) return json({ error: e.code }, e.status);
      this.D = null; // при неожиданной ошибке перечитаем базу, чтобы не держать полуизменённое состояние
      console.log("store error", String(e && e.stack || e));
      return json({ error: "server" }, 500);
    }
  }
}
