import express from "express";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bot, InlineKeyboard, Keyboard } from "grammy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  DATABASE_URL, BOT_TOKEN, ADMIN_ID, ADMIN_PASSWORD, ANTHROPIC_API_KEY,
  RENDER_EXTERNAL_URL, PORT = 3000,
} = process.env;

// ───────────────────────── база ─────────────────────────
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const DEFAULT_STATE = () => ({
  version: 0,
  employees: [],
  roster: {},
  prices: { regular: 3000, premium: 3500, electro: 4000 },
  bowlGrams: { regular: 22, premium: 30, electro: 0 },
  shift: null,
  closedShifts: [],
  ledger: [],
  daily: {},
  inventories: [],
  people: {},    // telegramId → { role: "admin" | "staff", empId, name }
  invites: {},   // код → empId
  requests: [],  // заявки сотрудников на смены
});

async function initDb() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS hookah;
    CREATE TABLE IF NOT EXISTS hookah.kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
async function loadState() {
  const r = await pool.query(`SELECT value FROM hookah.kv WHERE key = 'state'`);
  return r.rows[0] ? { ...DEFAULT_STATE(), ...r.rows[0].value } : DEFAULT_STATE();
}
async function saveState(state) {
  state.version = (state.version || 0) + 1;
  await pool.query(
    `INSERT INTO hookah.kv (key, value, updated_at) VALUES ('state', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [state],
  );
  return state;
}
// изменить состояние атомарно: fn получает свежий стейт и правит его
async function mutate(fn) {
  const s = await loadState();
  const out = await fn(s);
  await saveState(s);
  return out ?? s;
}

// ───────────────────────── логика ─────────────────────────
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 10);
const stockOf = (s) => s.ledger.reduce((a, m) => a + (Number(m.grams) || 0), 0);
const fmt = (n) => Math.round(n).toLocaleString("ru-RU");
const KIND_RU = { regular: "Обычный", premium: "Премиум", electro: "Электронный" };
const SHIFT_RU = { day: "1-я смена", night: "2-я смена" };

function addMove(s, m) {
  const ts = Date.now();
  s.ledger.push({ id: uid(), date: iso(ts), ts, ...m });
}
function openShift(s, kind, empId) {
  if (s.shift) return false;
  s.shift = { openedAt: Date.now(), kind, empId: empId || null, sales: [] };
  return true;
}
function closeShift(s) {
  if (!s.shift) return null;
  const done = { ...s.shift, closedAt: Date.now() };
  s.closedShifts.push(done);
  s.shift = null;
  return done;
}
function sale(s, kind, disc = 0) {
  if (!s.shift) return null;
  const price = Math.round(s.prices[kind] * (1 - disc / 100));
  const rec = { id: uid(), ts: Date.now(), kind, disc, price };
  s.shift.sales.push(rec);
  const g = s.bowlGrams[kind] || 0;
  if (g) addMove(s, { type: "sale", kind, qty: 1, grams: -g, note: `${KIND_RU[kind]} (смена)` });
  return rec;
}
const cashOf = (sh) => sh.sales.reduce((a, x) => a + x.price, 0);

function todaySummary(s) {
  const day = iso(Date.now());
  const sold = s.ledger.filter((m) => m.date === day && m.type === "sale");
  const grams = -sold.reduce((a, m) => a + m.grams, 0);
  const qty = sold.reduce((a, m) => a + (m.qty || 0), 0);
  const cash = (s.shift ? cashOf(s.shift) : 0) + s.closedShifts.filter((c) => iso(c.openedAt) === day).reduce((a, c) => a + cashOf(c), 0);
  return { grams, qty, cash };
}


// ───────── разбор смен из свободного текста ─────────
const DAY_WORDS = { "пн": 1, "понедельник": 1, "вт": 2, "вторник": 2, "ср": 3, "среда": 3, "чт": 4, "четверг": 4, "пт": 5, "пятница": 5, "сб": 6, "суббота": 6, "вс": 0, "воскресенье": 0 };
const translit = (x) => x.toLowerCase().replace(/ё/g, "е");

function dateFromWord(w) {
  const t = translit(w);
  const now = new Date();
  if (t === "сегодня") return iso(now);
  if (t === "завтра") return iso(now.getTime() + 864e5);
  if (t === "послезавтра") return iso(now.getTime() + 2 * 864e5);
  const dm = t.match(/^(\d{1,2})[.\-/](\d{1,2})$/);
  if (dm) { const d = new Date(now.getFullYear(), Number(dm[2]) - 1, Number(dm[1]), 12); return iso(d); }
  if (t in DAY_WORDS) {
    const want = DAY_WORDS[t]; const d = new Date(now); d.setHours(12, 0, 0, 0);
    for (let i = 0; i < 7; i++) { if (d.getDay() === want) return iso(d); d.setDate(d.getDate() + 1); }
  }
  return null;
}
// «вова 1 андрей 2», «сегодня: вова первая, андрей вторая», несколько строк
function parseRoster(text, defaultName = null) {
  const out = []; let day = iso(Date.now());
  for (const rawLine of text.split(/[\n;]+/)) {
    const line = rawLine.trim(); if (!line) continue;
    const tokens = line.split(/[\s,]+/).filter(Boolean);
    let name = null;
    for (const tok of tokens) {
      const t = translit(tok.replace(/[:—-]+$/, ""));
      const d = dateFromWord(t);
      if (d) { day = d; name = null; continue; }
      const isFirst = /^(1|1-?я|первая|первую|перв[а-я]*|день|дневная|дневн[а-я]*|утро|утренн[а-я]*)$/.test(t);
      const isSecond = /^(2|2-?я|вторая|вторую|втор[а-я]*|ночь|ночная|ночн[а-я]*|вечер|вечерн[а-я]*)$/.test(t);
      if (isFirst || isSecond) {
        const who = name || defaultName;
        if (who) { out.push({ day, kind: isFirst ? "day" : "night", name: who }); name = null; }
        continue;
      }
      if (/^[а-яa-z]{2,}$/i.test(t)) name = tok.replace(/[:,]/g, "");
    }
  }
  return out;
}
function applyRoster(s, items) {
  const done = [];
  for (const it of items) {
    let emp = s.employees.find((e) => translit(e.name).startsWith(translit(it.name).slice(0, 4)));
    if (!emp) { emp = { id: uid(), name: it.name[0].toUpperCase() + it.name.slice(1), color: null }; s.employees.push(emp); }
    s.roster[`${it.day}|${it.kind}`] = emp.id;
    done.push({ ...it, name: emp.name });
  }
  return done;
}

// ───────────────────────── распознавание ─────────────────────────
const PROMPT = `Это накладная на поставку табака для кальянной (или лист инвентаризации). Задача — выписать КАЖДУЮ строку с табаком и её вес в граммах. Итог НЕ считай сам — его посчитает программа.

Внимательно, построчно, ничего не пропуская:
- Для каждой строки с табаком укажи название (как в документе) и вес в граммах.
- Если в строке указано количество × вес пачки (например 2 × 250 г или 3 шт по 100 г) — перемножь и запиши итог этой строки, а в поле calc напиши расчёт.
- Если вес в кг — переведи в граммы.
- Если только количество пачек без веса — считай пачку 250 г и отметь assumed: true.
- Угли, жидкости, колбы, аксессуары — не табак, пропусти.
- Если в документе есть напечатанная итоговая сумма веса — запиши её в document_total (число), иначе null.

Ответ — строго JSON без markdown:
{"items":[{"name":"...","grams":250,"calc":"1×250","assumed":false}, ...], "document_total": 7450}`;

async function recognize({ base64, mediaType }) {
  if (!ANTHROPIC_API_KEY) throw new Error("не задан ANTHROPIC_API_KEY");
  const isPdf = mediaType === "application/pdf";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 4000,
      messages: [{ role: "user", content: [
        isPdf ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
              : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: PROMPT },
      ] }],
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "ошибка API");
  const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const m = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
  const items = (m.items || []).map((it, i) => ({ id: i, name: String(it.name || "позиция"), grams: Math.round(Number(it.grams) || 0), calc: it.calc || "", assumed: !!it.assumed }));
  if (!items.length) throw new Error("в файле не нашлось строк с табаком");
  const total = items.reduce((a, it) => a + it.grams, 0);
  return { items, total, docTotal: m.document_total ? Number(m.document_total) : null };
}

// ───────────────────────── HTTP API ─────────────────────────
const app = express();
app.use(express.json({ limit: "25mb" }));

const auth = (req, res, next) => {
  if (!ADMIN_PASSWORD) return next();
  if (req.get("x-token") === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: "unauthorized" });
};
app.get("/api/health", (_, res) => res.json({ ok: true }));
app.post("/api/login", (req, res) => res.json({ ok: !ADMIN_PASSWORD || req.body?.password === ADMIN_PASSWORD }));
app.get("/api/state", auth, async (_, res) => res.json(await loadState()));
app.put("/api/state", auth, async (req, res) => {
  const cur = await loadState();
  const incoming = req.body || {};
  // не даём старой вкладке затереть свежие правки бота
  if ((incoming.version || 0) < cur.version) return res.status(409).json(cur);
  const merged = { ...cur, ...incoming, version: cur.version };
  res.json(await saveState(merged));
});
app.post("/api/recognize", auth, async (req, res) => {
  try { res.json(await recognize(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ───────────────────────── Telegram-бот ─────────────────────────
const BOWLS = [
  ["classic", "Классика", 22],
  ["pro1", "Хука Про 1", 11],
  ["pro2", "Хука Про 2", 22],
  ["fruit", "Фрукты", 30],
];
const BOWL_G = Object.fromEntries(BOWLS.map(([k, , g]) => [k, g]));
const BOWL_NAME = Object.fromEntries(BOWLS.map(([k, n]) => [k, n]));
const INV_KIND = { mid: "Промежуточная", main: "Основная" };
const INV_PERIOD = 30; // дней между инвентаризациями
const DEVIATION = 800; // допустимое отклонение, г
const KIND_LABEL = { day: "1-я", night: "2-я" };

const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const dayAt = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const isoAt = (n) => iso(dayAt(n));
const dt = (day) => new Date(day + "T12:00:00");
const ruDay = (day) => { const d = dt(day); return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${WD[d.getDay()]}`; };
const ruShort = (day) => { const d = dt(day); return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`; };
const daysBetween = (a, b) => Math.round((dt(b) - dt(a)) / 864e5);

// касса за день: новый ключ «|all», старые «|day»/«|night» суммируем
const dayTotals = (s, day) => {
  const all = s.daily?.[`${day}|all`];
  if (all) return { cash: Number(all.cash) || 0, hookahs: Number(all.hookahs) || 0 };
  const a = s.daily?.[`${day}|day`], b = s.daily?.[`${day}|night`];
  if (!a && !b) return null;
  return { cash: (Number(a?.cash) || 0) + (Number(b?.cash) || 0), hookahs: (Number(a?.hookahs) || 0) + (Number(b?.hookahs) || 0) };
};
const setDayTotals = (s, day, rec) => {
  s.daily = s.daily || {};
  delete s.daily[`${day}|day`]; delete s.daily[`${day}|night`];
  s.daily[`${day}|all`] = { cash: Math.round(rec.cash) || 0, hookahs: Math.round(rec.hookahs) || 0 };
};
const clearDayTotals = (s, day) => {
  s.daily = s.daily || {};
  delete s.daily[`${day}|all`]; delete s.daily[`${day}|day`]; delete s.daily[`${day}|night`];
};
const empName = (s, id) => s.employees.find((e) => e.id === id)?.name || null;
const shiftLine = (s, day) =>
  `1-я: ${empName(s, s.roster[`${day}|day`]) || "—"} · 2-я: ${empName(s, s.roster[`${day}|night`]) || "—"}`;

const pushLedger = (s, e) => {
  s.ledger.push({ id: "l" + Date.now() + Math.random().toString(16).slice(2, 5), date: iso(Date.now()), ts: Date.now(), ...e });
};
const lastOf = (s, type, field = "date") => {
  const rows = s.ledger.filter((l) => l.type === type && l[field]);
  if (!rows.length) return null;
  return rows.reduce((m, l) => (l[field] > m ? l[field] : m), rows[0][field]);
};
const lastSalePeriod = (s) => {
  const rows = s.ledger.filter((l) => l.type === "sale" && l.pTo);
  if (!rows.length) return null;
  const to = rows.reduce((m, l) => (l.pTo > m ? l.pTo : m), rows[0].pTo);
  const from = rows.filter((l) => l.pTo === to).reduce((m, l) => (l.pFrom < m ? l.pFrom : m), to);
  return { from, to };
};
const nextPeriod = (s) => {
  const last = lastSalePeriod(s);
  const today = iso(Date.now());
  if (!last) return { from: today, to: today };
  const from = iso(dt(last.to).getTime() + 864e5);
  return { from, to: from > today ? from : today };
};
const periodNote = (p) => (p.from === p.to ? ruShort(p.from) : `${ruShort(p.from)} — ${ruShort(p.to)}`);
const lastInv = (s) => (s.inventories?.length ? s.inventories[s.inventories.length - 1] : null);

// ───────── понимание свободного текста ─────────
const NLU_PROMPT = (s) => `Ты разбираешь сообщения управляющего кальянной, написанные обычными словами, и превращаешь их в команду.

Сегодня: ${iso(Date.now())} (${WD[new Date().getDay()]}).
Сотрудники: ${s.employees.map((e) => e.name).join(", ") || "нет"}.
Виды кальянов: classic — Классика (22 г), pro1 — Хука Про 1 (11 г), pro2 — Хука Про 2 (22 г), fruit — Фрукты (30 г).

Верни СТРОГО JSON без markdown, одно из:
{"action":"roster","items":[{"day":"YYYY-MM-DD","kind":"day|night","name":"Имя"}]}  — кто в какую смену работает (1-я/первая/утро = day, 2-я/вторая/вечер/ночь = night)
{"action":"cash","day":"YYYY-MM-DD","cash":45000,"hookahs":18}  — касса за день; неизвестное поле = null
{"action":"cash_show","day":"YYYY-MM-DD"}  — показать кассу за день
{"action":"supply","grams":null}  — пришла поставка табака; grams только если названо число граммов
{"action":"sale","items":[{"kind":"classic","qty":12}],"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}  — продажи кальянов
{"action":"writeoff","items":[{"kind":"classic","qty":2}],"reason":"перезабивка"}  — списание
{"action":"adjust","grams":-500,"note":"комментарий"}  — ручная правка остатка
{"action":"inventory","kind":"mid|main","actual":7450}  — инвентаризация; actual = null, если число не названо
{"action":"stock"}  — сколько табака на складе
{"action":"week","offset":0}  — график смен (offset 1 — следующая неделя)
{"action":"unknown","hint":"чего не хватает"}  — если непонятно

Даты считай от сегодня: «завтра», «в пятницу», «8.09». Имена бери как написаны.`;

async function askClaude(state, text) {
  if (!ANTHROPIC_API_KEY) return { action: "unknown", hint: "нет ключа ANTHROPIC_API_KEY" };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 700,
      system: NLU_PROMPT(state),
      messages: [{ role: "user", content: text }],
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "ошибка API");
  const out = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").replace(/```json|```/g, "").trim();
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
}

const pending = new Map(); // chatId → распознанная накладная

if (BOT_TOKEN) {
  const bot = new Bot(BOT_TOKEN);
  const adminIds = String(ADMIN_ID || "").split(",").map((x) => x.trim()).filter(Boolean);
  const sess = new Map(); // chatId → шаг диалога
  const getS = (ctx) => sess.get(ctx.chat.id) || null;
  const setS = (ctx, v) => sess.set(ctx.chat.id, v);
  const clrS = (ctx) => sess.delete(ctx.chat.id);

  const menu = new Keyboard()
    .text("📊 Дэшборд").text("💰 Касса").row()
    .text("🗓 График").text("👥 Смены").row()
    .text("📦 Склад").text("📄 Поставка из файла").row()
    .text("👤 Сотрудники").resized();
  const staffMenu = new Keyboard().text("🗓 Мои смены").text("✍️ Заявка на смену").resized();

  // /id работает всегда — им узнают свой Telegram id
  bot.command("id", (ctx) => ctx.reply(`Твой Telegram id: ${ctx.from?.id}\nВпиши его в переменную ADMIN_ID на Render.`));
  bot.command("join", async (ctx) => {
    const code = (ctx.match || "").trim().toUpperCase();
    if (!code) return ctx.reply("Формат: /join КОД (код даёт управляющий).");
    const s0 = await loadState();
    const empId = s0.invites?.[code];
    if (!empId) return ctx.reply("Код не найден или уже использован.");
    const emp = s0.employees.find((e) => e.id === empId);
    const s = await mutate((s) => {
      s.people[String(ctx.from.id)] = { role: "staff", empId, name: emp?.name || ctx.from.first_name };
      delete s.invites[code];
    });
    const admins = Object.entries(s.people).filter(([, p]) => p.role === "admin").map(([id]) => id).concat(adminIds);
    for (const id of new Set(admins)) ctx.api.sendMessage(id, `👤 ${emp?.name} подключился к боту.`).catch(() => {});
    ctx.reply(`Привет, ${emp?.name}! Теперь можно смотреть свои смены и отправлять заявки.`, { reply_markup: staffMenu });
  });

  // роли
  bot.use(async (ctx, next) => {
    const id = String(ctx.from?.id || "");
    const st = await loadState();
    const person = st.people?.[id];
    const isAdmin = adminIds.includes(id) || person?.role === "admin";
    if (!isAdmin && !person) {
      if (!adminIds.length) return ctx.reply("⚠️ ADMIN_ID не заполнен. Узнай свой id командой /id и впиши его на Render.");
      return ctx.reply("Доступ закрыт. Если ты сотрудник — попроси у управляющего код и пришли: /join КОД\nТвой id: " + id);
    }
    ctx.state = { isAdmin, person, st };
    await next();
  });

  // ───── сотрудник ─────
  bot.use(async (ctx, next) => {
    if (ctx.state.isAdmin) return next();
    const p = ctx.state.person;
    const text = ctx.message?.text || "";
    const emp = ctx.state.st.employees.find((e) => e.id === p.empId);
    const myName = emp?.name || p.name;

    if (text === "/start") return ctx.reply(`Привет, ${myName}! Пиши, когда хочешь работать: «завтра 1», «пт 2, сб 1». Заявка уйдёт управляющему.`, { reply_markup: staffMenu });
    if (text === "🗓 Мои смены") {
      const mine = Object.entries(ctx.state.st.roster).filter(([, v]) => v === p.empId)
        .map(([k]) => k.split("|")).filter(([d]) => d >= iso(Date.now())).sort();
      const pend = ctx.state.st.requests.filter((r) => r.empId === p.empId && r.status === "new");
      return ctx.reply(mine.length || pend.length
        ? "🗓 Твои смены:\n" + (mine.map(([d, k]) => `${ruDay(d)} · ${KIND_LABEL[k]}`).join("\n") || "—")
          + (pend.length ? "\n\nНа подтверждении:\n" + pend.flatMap((r) => r.items.map((i) => `${ruDay(i.day)} · ${KIND_LABEL[i.kind]}`)).join("\n") : "")
        : "Смен пока нет. Напиши, например, «завтра 1».");
    }
    if (text === "✍️ Заявка на смену") return ctx.reply("Напиши, когда готов работать: «завтра 1», «пт 2, сб 1».");

    const items = parseRoster(text, myName);
    if (!items.length) return ctx.reply("Не понял. Напиши, например: «завтра 1» или «пт 2, сб 1».");
    const req = { id: uid(), empId: p.empId, name: myName, items, ts: Date.now(), status: "new" };
    await mutate((s) => { s.requests.push(req); });
    const list = items.map((i) => `${ruDay(i.day)} · ${KIND_LABEL[i.kind]}`).join("\n");
    const admins = new Set(adminIds.concat(Object.entries(ctx.state.st.people).filter(([, x]) => x.role === "admin").map(([id]) => id)));
    for (const aid of admins) {
      ctx.api.sendMessage(aid, `✍️ Заявка от ${myName}:\n${list}`, {
        reply_markup: new InlineKeyboard().text("✅ Подтвердить", `req:ok:${req.id}`).text("✖️ Отклонить", `req:no:${req.id}`),
      }).catch(() => {});
    }
    return ctx.reply("Отправил управляющему:\n" + list);
  });

  bot.command("start", (ctx) => { clrS(ctx); ctx.reply(
    "Привет! Я админ кальянной.\n\n" +
    "Кнопки внизу — касса, график, смены, склад.\n" +
    "Можно просто писать словами:\n" +
    "• «завтра Вова 2, Денис 1»\n" +
    "• «касса за сегодня 52000, 21 кальян»\n" +
    "• «пришла поставка табака»\n" +
    "• «продали 14 классики и 3 фрукта»\n" +
    "• «сколько табака на складе»", { reply_markup: menu }); });

  // ═════════ ДЭШБОРД ═════════
  const dashText = (s) => {
    const today = iso(Date.now());
    const now = new Date();
    const mPref = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let cash = 0, hk = 0, days = 0;
    for (let i = 0; i < 62; i++) {
      const d = isoAt(-i);
      if (!d.startsWith(mPref)) continue;
      const t = dayTotals(s, d);
      if (!t) continue;
      cash += t.cash; hk += t.hookahs; days++;
    }
    // расход табака и прогноз
    const gone14 = s.ledger.filter((l) => l.grams < 0 && l.date >= isoAt(-14)).reduce((a, l) => a + Math.abs(l.grams), 0);
    const perDay = Math.round(gone14 / 14);
    const st = stockOf(s);
    const left = perDay > 0 ? Math.floor(st / perDay) : null;

    // не заполненные кассы за последние 7 дней
    const gaps = [];
    for (let i = 1; i <= 7; i++) {
      const d = isoAt(-i);
      if (!dayTotals(s, d) && (s.roster[`${d}|day`] || s.roster[`${d}|night`])) gaps.push(d);
    }
    const pend = (s.requests || []).filter((r) => r.status === "new");
    const t = dayTotals(s, today);

    return `📊 Дэшборд · ${ruDay(today)}\n\n` +
      `Сегодня\n${shiftLine(s, today)}\n` +
      (t ? `Касса: ${fmt(t.cash)} ₽ · ${t.hookahs} кальянов\n` : `Касса: не заполнена\n`) +
      `\nМесяц\nКасса: ${fmt(cash)} ₽ · ${hk} кальянов · ${days} дн.\n` +
      (days ? `В среднем за день: ${fmt(cash / days)} ₽ · ${(hk / days).toFixed(1)} кальянов\n` : "") +
      `\nСклад\nОстаток: ${fmt(st)} г\nРасход: ${perDay ? `${fmt(perDay)} г/день` : "—"}` +
      (left !== null ? ` · хватит на ${left} дн.${left < 7 ? " ⚠️" : ""}` : "") + "\n" +
      (gaps.length ? `\n⚠️ Касса не заполнена: ${gaps.map(ruShort).join(", ")}\n` : "") +
      (pend.length ? `✍️ Заявок на подтверждение: ${pend.length}\n` : "");
  };
  const dashKb = new InlineKeyboard()
    .text("💰 Заполнить кассу", "c:pick:0").text("📦 Склад", "w:show").row()
    .text("🗓 График", "g:0");

  bot.hears("📊 Дэшборд", async (ctx) => { clrS(ctx); ctx.reply(dashText(await loadState()), { reply_markup: dashKb }); });

  // ═════════ КАССА ═════════
  const cashText = (s, day) => {
    const t = dayTotals(s, day);
    const head = `💰 Касса за ${ruDay(day)}\n${shiftLine(s, day)}\n\n`;
    return t
      ? head + `Касса: ${fmt(t.cash)} ₽\nКальянов: ${t.hookahs}`
      : head + "Не заполнена.";
  };
  const cashKb = (s, day) => {
    const t = dayTotals(s, day);
    const kb = new InlineKeyboard();
    if (t) kb.text("✏️ Изменить", `c:set:${day}`).text("🗑 Удалить", `c:del:${day}`).row();
    else kb.text("✍️ Ввести кассу", `c:set:${day}`).row();
    return kb.text("← Другой день", "c:pick:0");
  };
  const dayListKb = (prefix, page = 0, back = null) => {
    const kb = new InlineKeyboard();
    for (let i = 0; i < 14; i++) {
      const d = isoAt(-(page * 14 + i));
      kb.text(page === 0 && i === 0 ? `Сегодня · ${ruShort(d)}` : ruDay(d), `${prefix}${d}`);
      if (i % 2 === 1) kb.row();
    }
    kb.row();
    if (page > 0) kb.text("← Ближе", `c:pick:${page - 1}`);
    kb.text("Раньше →", `c:pick:${page + 1}`);
    if (back) kb.row().text("← Назад", back);
    return kb;
  };

  bot.hears("💰 Касса", async (ctx) => {
    clrS(ctx);
    const s = await loadState();
    const today = iso(Date.now());
    ctx.reply(cashText(s, today), {
      reply_markup: new InlineKeyboard()
        .text(dayTotals(s, today) ? "✏️ Изменить за сегодня" : "✍️ Ввести за сегодня", `c:set:${today}`).row()
        .text("📅 Другой день", "c:pick:0"),
    });
  });
  bot.callbackQuery(/^c:pick:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.editMessageText("За какой день?", { reply_markup: dayListKb("c:day:", Number(ctx.match[1])) });
  });
  bot.callbackQuery(/^c:day:(.+)$/, async (ctx) => {
    const day = ctx.match[1];
    const s = await loadState();
    await ctx.answerCallbackQuery();
    ctx.editMessageText(cashText(s, day), { reply_markup: cashKb(s, day) });
  });
  bot.callbackQuery(/^c:set:(.+)$/, async (ctx) => {
    const day = ctx.match[1];
    setS(ctx, { flow: "cash", day });
    await ctx.answerCallbackQuery();
    ctx.reply(`Касса за ${ruDay(day)}. Напиши сумму и число кальянов через пробел, например: 52000 21`);
  });
  bot.callbackQuery(/^c:del:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.editMessageText(`Удалить кассу за ${ruDay(ctx.match[1])}?`, {
      reply_markup: new InlineKeyboard().text("🗑 Да, удалить", `c:delok:${ctx.match[1]}`).text("Отмена", `c:day:${ctx.match[1]}`),
    });
  });
  bot.callbackQuery(/^c:delok:(.+)$/, async (ctx) => {
    const day = ctx.match[1];
    await mutate((s) => clearDayTotals(s, day));
    await ctx.answerCallbackQuery("Удалено");
    ctx.editMessageText(`🗑 Касса за ${ruDay(day)} удалена.`);
  });

  // ═════════ ГРАФИК ═════════
  const weekText = (s, offset) => {
    const today = iso(Date.now());
    const mon = dayAt(-((new Date().getDay() + 6) % 7) + offset * 7);
    const days = Array.from({ length: 7 }, (_, i) => iso(new Date(mon.getTime() + i * 864e5)));
    const shown = offset === 0 ? days.filter((d) => d >= today) : days;
    const head = offset === 0 ? "🗓 Эта неделя — с сегодняшнего дня" : "🗓 Следующая неделя";
    const rows = shown.map((d) => `${d === today ? "▶️" : "  "} ${ruDay(d)}   ${shiftLine(s, d)}`);
    const empty = shown.reduce((n, d) => n + (s.roster[`${d}|day`] ? 0 : 1) + (s.roster[`${d}|night`] ? 0 : 1), 0);
    return `${head}\n\n${rows.join("\n") || "Дней не осталось"}\n\n${empty ? `⚠️ Без сотрудника: ${empty} смен` : "✅ Все смены закрыты"}`;
  };
  const weekKb = (offset) => new InlineKeyboard()
    .text(offset === 0 ? "Следующая неделя →" : "← Эта неделя", `g:${offset === 0 ? 1 : 0}`).row()
    .text("👥 Изменить смены", "sh:list");

  bot.hears("🗓 График", async (ctx) => { clrS(ctx); ctx.reply(weekText(await loadState(), 0), { reply_markup: weekKb(0) }); });
  bot.callbackQuery(/^g:(0|1)$/, async (ctx) => {
    const off = Number(ctx.match[1]);
    await ctx.answerCallbackQuery();
    ctx.editMessageText(weekText(await loadState(), off), { reply_markup: weekKb(off) });
  });

  // ═════════ СМЕНЫ ═════════
  const shiftDaysKb = () => {
    const kb = new InlineKeyboard();
    for (let i = 0; i < 14; i++) {
      const d = isoAt(i);
      kb.text(i === 0 ? `Сегодня · ${ruShort(d)}` : i === 1 ? `Завтра · ${ruShort(d)}` : ruDay(d), `sh:d:${d}`);
      if (i % 2 === 1) kb.row();
    }
    return kb;
  };
  const dayShiftKb = (day) => new InlineKeyboard()
    .text("1-я смена", `sh:k:${day}:day`).text("2-я смена", `sh:k:${day}:night`).row()
    .text("← Другой день", "sh:list");
  const empKb = (s, day, kind) => {
    const kb = new InlineKeyboard();
    s.employees.forEach((e, i) => { kb.text(e.name, `sh:e:${day}:${kind}:${e.id}`); if (i % 2 === 1) kb.row(); });
    return kb.row().text("✍️ Замена — вписать имя", `sh:new:${day}:${kind}`).row()
      .text("✖️ Убрать", `sh:e:${day}:${kind}:none`).text("← Назад", `sh:d:${day}`);
  };

  bot.hears("👥 Смены", async (ctx) => { clrS(ctx); ctx.reply("На какой день ставим смены?", { reply_markup: shiftDaysKb() }); });
  bot.callbackQuery("sh:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.editMessageText("На какой день ставим смены?", { reply_markup: shiftDaysKb() });
  });
  bot.callbackQuery(/^sh:d:(.+)$/, async (ctx) => {
    const day = ctx.match[1];
    const s = await loadState();
    await ctx.answerCallbackQuery();
    ctx.editMessageText(`${ruDay(day)}\n${shiftLine(s, day)}\n\nКакую смену меняем?`, { reply_markup: dayShiftKb(day) });
  });
  bot.callbackQuery(/^sh:k:(.+):(day|night)$/, async (ctx) => {
    const [, day, kind] = ctx.match;
    const s = await loadState();
    await ctx.answerCallbackQuery();
    ctx.editMessageText(`${ruDay(day)} · ${KIND_LABEL[kind]} смена\nСейчас: ${empName(s, s.roster[`${day}|${kind}`]) || "—"}\n\nКто работает?`, { reply_markup: empKb(s, day, kind) });
  });
  bot.callbackQuery(/^sh:e:(.+):(day|night):(.+)$/, async (ctx) => {
    const [, day, kind, empId] = ctx.match;
    const s = await mutate((s) => {
      if (empId === "none") delete s.roster[`${day}|${kind}`];
      else s.roster[`${day}|${kind}`] = empId;
    });
    await ctx.answerCallbackQuery("Записал");
    ctx.editMessageText(`✅ ${ruDay(day)}\n${shiftLine(s, day)}`, { reply_markup: dayShiftKb(day) });
  });
  bot.callbackQuery(/^sh:new:(.+):(day|night)$/, async (ctx) => {
    const [, day, kind] = ctx.match;
    setS(ctx, { flow: "empname", day, kind });
    await ctx.answerCallbackQuery();
    ctx.reply(`Кто выходит на замену ${ruDay(day)} в ${KIND_LABEL[kind]} смену? Напиши имя.`);
  });

  // ═════════ СКЛАД ═════════
  const stockText = (s) => {
    const st = stockOf(s);
    const sup = lastOf(s, "supply");
    const sale = lastSalePeriod(s);
    const wo = lastOf(s, "writeoff");
    const inv = lastInv(s);
    const invLine = inv
      ? `Инвентаризация: ${INV_KIND[inv.kind]} ${ruShort(inv.date)}, факт ${fmt(inv.actual)} г · следующая через ${Math.max(0, INV_PERIOD - daysBetween(inv.date, iso(Date.now())))} дн.`
      : "Инвентаризация: ещё не проводилась";
    return `📦 На складе: ${fmt(st)} г\n\n` +
      `Продажи внесены по: ${sale ? periodNote(sale) : "—"}\n` +
      `Последняя поставка: ${sup ? ruShort(sup) : "—"}\n` +
      `Последнее списание: ${wo ? ruShort(wo) : "—"}\n` +
      invLine;
  };
  const stockKb = new InlineKeyboard()
    .text("🎯 Продажи кальянов", "w:sale").text("➖ Списание", "w:wo").row()
    .text("✏️ Ручная корректировка", "w:adj").text("📋 Инвентаризация", "w:inv").row()
    .text("📄 Поставка из файла", "w:file");

  bot.hears("📦 Склад", async (ctx) => { clrS(ctx); ctx.reply(stockText(await loadState()), { reply_markup: stockKb }); });
  bot.callbackQuery("w:show", async (ctx) => { await ctx.answerCallbackQuery(); ctx.reply(stockText(await loadState()), { reply_markup: stockKb }); });

  // ручная корректировка
  bot.callbackQuery("w:adj", async (ctx) => {
    setS(ctx, { flow: "adjust" });
    await ctx.answerCallbackQuery();
    ctx.reply("Напиши, на сколько поправить остаток:\n500 — добавит, -500 — уберёт.\nМожно с комментарием: «-300 просыпали»");
  });

  // продажи и списания — по видам подряд
  const startQty = async (ctx, mode) => {
    const s = await loadState();
    const p = nextPeriod(s);
    setS(ctx, { flow: "qty", mode, i: 0, q: {}, from: p.from, to: p.to });
    const last = lastSalePeriod(s);
    await ctx.reply(
      (mode === "sale" ? "🎯 Продажи кальянов" : "➖ Списание") + "\n" +
      (last ? `Последние продажи внесены по ${periodNote(last)}.\n` : "") +
      `Период: ${periodNote(p)}`,
      { reply_markup: new InlineKeyboard().text("✅ Этот период", "q:go").text("✍️ Другой период", "q:period") });
  };
  const askQty = async (ctx) => {
    const st = getS(ctx);
    const [k, name, g] = BOWLS[st.i];
    await ctx.reply(`${name} · ${g} г — сколько штук?\nНапиши число (0 — если не было).`);
  };
  const qtySummary = (st) => {
    const rows = BOWLS.filter(([k]) => st.q[k] > 0).map(([k, name, g]) => `• ${name}: ${st.q[k]} шт · ${st.q[k] * g} г`);
    const grams = BOWLS.reduce((a, [k, , g]) => a + (st.q[k] || 0) * g, 0);
    return { rows, grams };
  };
  const finishQty = async (ctx) => {
    const st = getS(ctx);
    const { rows, grams } = qtySummary(st);
    if (!grams) { clrS(ctx); return ctx.reply("Пусто — ничего не записал."); }
    if (st.mode === "wo" && !st.reason) {
      setS(ctx, { ...st, step: "reason" });
      return ctx.reply("Причина списания?", {
        reply_markup: new InlineKeyboard().text("Перезабивка", "q:r:перезабивка").text("Брак", "q:r:брак").row().text("✍️ Своя причина", "q:r:own"),
      });
    }
    const s = await loadState();
    await ctx.reply(
      `${st.mode === "sale" ? "🎯 Продажи" : "➖ Списание"} за ${periodNote(st)}\n\n${rows.join("\n")}\n\nИтого −${fmt(grams)} г\n` +
      `Остаток станет ${fmt(stockOf(s) - grams)} г` + (st.reason ? `\nПричина: ${st.reason}` : ""),
      { reply_markup: new InlineKeyboard().text("✅ Записать", "q:save").text("✖️ Отмена", "q:cancel") });
  };
  bot.callbackQuery("w:sale", async (ctx) => { await ctx.answerCallbackQuery(); startQty(ctx, "sale"); });
  bot.callbackQuery("w:wo", async (ctx) => { await ctx.answerCallbackQuery(); startQty(ctx, "wo"); });
  bot.callbackQuery("q:go", async (ctx) => { await ctx.answerCallbackQuery(); askQty(ctx); });
  bot.callbackQuery("q:period", async (ctx) => {
    setS(ctx, { ...getS(ctx), step: "period" });
    await ctx.answerCallbackQuery();
    ctx.reply("Напиши период: «5.09» или «1.09 - 5.09»");
  });
  bot.callbackQuery(/^q:r:(.+)$/, async (ctx) => {
    const r = ctx.match[1];
    await ctx.answerCallbackQuery();
    if (r === "own") { setS(ctx, { ...getS(ctx), step: "reasonOwn" }); return ctx.reply("Напиши причину."); }
    setS(ctx, { ...getS(ctx), reason: r, step: null });
    finishQty(ctx);
  });
  bot.callbackQuery("q:cancel", async (ctx) => { clrS(ctx); await ctx.answerCallbackQuery(); ctx.editMessageText("Отменено."); });
  bot.callbackQuery("q:save", async (ctx) => {
    const st = getS(ctx);
    await ctx.answerCallbackQuery();
    if (!st?.q) return ctx.editMessageText("Данные устарели, начни заново.");
    const s = await mutate((s) => {
      for (const [k, name, g] of BOWLS) {
        const qty = st.q[k] || 0;
        if (!qty) continue;
        if (st.mode === "sale") pushLedger(s, { type: "sale", kind: k, qty, grams: -qty * g, date: st.to, pFrom: st.from, pTo: st.to, note: `${name} · ${periodNote(st)}` });
        else pushLedger(s, { type: "writeoff", kind: k, qty, grams: -qty * g, date: st.to, note: `${name} · ${st.reason || "списание"} · ${periodNote(st)}` });
      }
    });
    clrS(ctx);
    ctx.editMessageText(`✅ Записал. На складе ${fmt(stockOf(s))} г`);
  });

  // инвентаризация
  bot.callbackQuery("w:inv", async (ctx) => {
    const s = await loadState();
    const inv = lastInv(s);
    await ctx.answerCallbackQuery();
    const info = inv
      ? `Последняя: ${INV_KIND[inv.kind]}, ${ruDay(inv.date)} — факт ${fmt(inv.actual)} г (расхождение ${inv.diff > 0 ? "+" : ""}${fmt(inv.diff)} г).\nПрошло ${daysBetween(inv.date, iso(Date.now()))} дн. из ${INV_PERIOD}.`
      : "Инвентаризацию ещё не проводили.";
    ctx.reply(`📋 Инвентаризация\n\n${info}\nРасчётный остаток сейчас: ${fmt(stockOf(s))} г\n\nКакую проводим?`, {
      reply_markup: new InlineKeyboard().text("Промежуточная", "w:invk:mid").text("Основная", "w:invk:main"),
    });
  });
  bot.callbackQuery(/^w:invk:(mid|main)$/, async (ctx) => {
    setS(ctx, { flow: "inv", kind: ctx.match[1] });
    await ctx.answerCallbackQuery();
    ctx.reply(`${INV_KIND[ctx.match[1]]} инвентаризация. Сколько граммов насчитали по факту? Напиши число.`);
  });
  const invConfirm = async (ctx, kind, actual) => {
    const s = await loadState();
    const calc = stockOf(s), diff = Math.round(actual - calc);
    setS(ctx, { flow: "inv", kind, actual, calc, diff, step: "confirm" });
    await ctx.reply(
      `📋 ${INV_KIND[kind]}\nРасчёт: ${fmt(calc)} г\nФакт: ${fmt(actual)} г\nРасхождение: ${diff > 0 ? "+" : ""}${fmt(diff)} г\n\n` +
      (Math.abs(diff) > DEVIATION ? "⚠️ Отклонение больше нормы — стоит пересчитать." : "✅ Отклонение в пределах нормы."),
      { reply_markup: new InlineKeyboard().text("✅ Сохранить", "inv:save").text("✖️ Отмена", "q:cancel") });
  };
  bot.callbackQuery("inv:save", async (ctx) => {
    const st = getS(ctx);
    await ctx.answerCallbackQuery();
    if (!st?.actual && st?.actual !== 0) return ctx.editMessageText("Данные устарели, начни заново.");
    const s = await mutate((s) => {
      s.inventories = s.inventories || [];
      s.inventories.push({ id: "i" + Date.now(), date: iso(Date.now()), kind: st.kind, actual: st.actual, calc: st.calc, diff: st.diff });
      if (st.diff) pushLedger(s, { type: "inventory", grams: st.diff, note: `${INV_KIND[st.kind].toLowerCase()} инвентаризация (расчёт ${st.calc} г)` });
    });
    clrS(ctx);
    ctx.editMessageText(`✅ Инвентаризация сохранена. Остаток на складе: ${fmt(stockOf(s))} г`);
  });

  // ═════════ ПОСТАВКА ИЗ ФАЙЛА ═════════
  const askFile = (ctx) => { setS(ctx, { flow: "supply" }); return ctx.reply("Пришли фото или PDF накладной — посчитаю граммы.\nИли напиши число граммов, если считать не надо."); };
  bot.hears("📄 Поставка из файла", (ctx) => askFile(ctx));
  bot.callbackQuery("w:file", async (ctx) => { await ctx.answerCallbackQuery(); askFile(ctx); });

  const handleFile = async (ctx, fileId, mediaType) => {
    const wait = await ctx.reply("Читаю накладную… это может занять до минуты");
    const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);
    try {
      const f = await ctx.api.getFile(fileId);
      const buf = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`)).arrayBuffer());
      const r = await recognize({ base64: buf.toString("base64"), mediaType });
      pending.set(ctx.chat.id, r);
      clrS(ctx);
      const lines = r.items.map((it) => `• ${it.name}${it.assumed ? " *" : ""} — ${it.grams} г${it.calc ? ` (${it.calc})` : ""}`).join("\n");
      const warn = r.docTotal !== null && r.docTotal !== r.total ? `\n\n⚠️ В документе напечатано ${fmt(r.docTotal)} г, по строкам ${fmt(r.total)} г — проверь.` : "";
      const s = await loadState();
      const kb = new InlineKeyboard()
        .text(`✅ Верно · поставка +${fmt(r.total)} г`, "file:add").row()
        .text(`📋 Это инвентаризация → ${fmt(r.total)} г`, "file:replace").row();
      if (r.docTotal !== null && r.docTotal !== r.total) kb.text(`Взять итог документа ${fmt(r.docTotal)} г`, "file:doc").row();
      kb.text("✍️ Ввести вручную", "file:manual").text("Отмена", "cancel");
      await ctx.api.editMessageText(ctx.chat.id, wait.message_id,
        `Нашёл ${r.items.length} строк, итого ${fmt(r.total)} г\n\n${lines}${warn}\n\nСейчас на складе ${fmt(stockOf(s))} г. Всё верно?`, { reply_markup: kb });
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat.id, wait.message_id, "Не удалось распознать: " + e.message + "\nМожно ввести вручную — напиши число граммов.").catch(() => {});
      setS(ctx, { flow: "supply" });
    } finally { clearInterval(typing); }
  };
  bot.on("message:document", (ctx) => {
    const d = ctx.message.document;
    const mt = d.mime_type || "";
    if (mt === "application/pdf" || /^image\/(jpeg|png|webp)$/.test(mt)) return handleFile(ctx, d.file_id, mt);
    ctx.reply("Пришли PDF или фото (jpg/png).");
  });
  bot.on("message:photo", (ctx) => handleFile(ctx, ctx.message.photo.at(-1).file_id, "image/jpeg"));

  bot.callbackQuery(/^file:(add|replace|doc)$/, async (ctx) => {
    const r = pending.get(ctx.chat.id);
    await ctx.answerCallbackQuery();
    if (!r?.items) return ctx.editMessageText("Файл уже обработан или устарел — пришли заново.");
    pending.delete(ctx.chat.id);
    const mode = ctx.match[1];
    const total = mode === "doc" ? r.docTotal : r.total;
    const s = await mutate((s) => {
      if (mode === "replace") {
        const diff = total - stockOf(s);
        s.inventories = s.inventories || [];
        s.inventories.push({ id: "i" + Date.now(), date: iso(Date.now()), kind: "main", actual: total, calc: stockOf(s), diff });
        if (diff) pushLedger(s, { type: "inventory", grams: diff, note: "инвентаризация по файлу (бот)" });
      } else pushLedger(s, { type: "supply", grams: total, note: "накладная (бот)" });
    });
    ctx.editMessageText(mode === "replace" ? `📋 Остаток установлен: ${fmt(stockOf(s))} г` : `➕ Поставка ${fmt(total)} г записана. На складе ${fmt(stockOf(s))} г`);
  });
  bot.callbackQuery("file:manual", async (ctx) => {
    pending.delete(ctx.chat.id);
    setS(ctx, { flow: "supply" });
    await ctx.answerCallbackQuery();
    ctx.reply("Напиши, сколько граммов пришло.");
  });
  bot.callbackQuery("cancel", async (ctx) => { pending.delete(ctx.chat.id); clrS(ctx); await ctx.answerCallbackQuery(); ctx.editMessageText("Отменено."); });

  // ═════════ СОТРУДНИКИ ═════════
  bot.hears("👤 Сотрудники", async (ctx) => {
    clrS(ctx);
    const s = await loadState();
    const linked = Object.values(s.people).filter((p) => p.role === "staff");
    const kb = new InlineKeyboard();
    s.employees.forEach((e) => {
      const on = linked.some((p) => p.empId === e.id);
      kb.text(`${on ? "✅" : "➕"} ${e.name}`, `emp:${e.id}`).row();
    });
    kb.text("➕ Добавить сотрудника", "emp:add");
    ctx.reply(s.employees.length
      ? "Штат. ✅ — подключён к боту.\nНажми на имя, чтобы выдать код доступа или удалить."
      : "Штат пуст. Добавь первого сотрудника.", { reply_markup: kb });
  });
  bot.callbackQuery("emp:add", async (ctx) => {
    setS(ctx, { flow: "newemp" });
    await ctx.answerCallbackQuery();
    ctx.reply("Как зовут нового сотрудника? Напиши имя.");
  });
  bot.callbackQuery(/^empdel:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const s0 = await loadState();
    const emp = s0.employees.find((e) => e.id === id);
    await ctx.answerCallbackQuery();
    ctx.editMessageText(`Удалить ${emp?.name} из штата? Смены, где он записан, останутся пустыми.`, {
      reply_markup: new InlineKeyboard().text("🗑 Да, удалить", `empdelok:${id}`).text("Отмена", `emp:${id}`),
    });
  });
  bot.callbackQuery(/^empdelok:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    let name = "";
    const s = await mutate((s) => {
      name = s.employees.find((e) => e.id === id)?.name || "";
      s.employees = s.employees.filter((e) => e.id !== id);
      for (const k of Object.keys(s.roster)) if (s.roster[k] === id) delete s.roster[k];
      for (const [tg, p] of Object.entries(s.people)) if (p.empId === id) delete s.people[tg];
    });
    await ctx.answerCallbackQuery("Удалён");
    ctx.editMessageText(`🗑 ${name} удалён из штата. В штате ${s.employees.length} чел.`);
  });
  bot.callbackQuery(/^emp:(.+)$/, async (ctx) => {
    const empId = ctx.match[1];
    const s = await loadState();
    const emp = s.employees.find((e) => e.id === empId);
    if (!emp) { await ctx.answerCallbackQuery(); return ctx.editMessageText("Сотрудник не найден."); }
    const linked = Object.values(s.people).some((p) => p.empId === empId);
    const soon = Object.entries(s.roster).filter(([k, v]) => v === empId && k.split("|")[0] >= iso(Date.now()))
      .map(([k]) => k.split("|")).sort().slice(0, 5).map(([d, kk]) => `${ruDay(d)} · ${KIND_LABEL[kk]}`);
    await ctx.answerCallbackQuery();
    ctx.editMessageText(`👤 ${emp.name}\n${linked ? "Подключён к боту ✅" : "К боту не подключён"}\n\nБлижайшие смены:\n${soon.join("\n") || "—"}`, {
      reply_markup: new InlineKeyboard()
        .text(linked ? "🔑 Новый код доступа" : "🔑 Код доступа", `empcode:${empId}`).row()
        .text("🗑 Удалить из штата", `empdel:${empId}`),
    });
  });
  bot.callbackQuery(/^empcode:(.+)$/, async (ctx) => {
    const empId = ctx.match[1];
    const code = Math.random().toString(36).slice(2, 7).toUpperCase();
    const s = await mutate((s) => { s.invites[code] = empId; });
    const emp = s.employees.find((e) => e.id === empId);
    await ctx.answerCallbackQuery();
    ctx.reply(`Код для ${emp?.name}: ${code}\n\nПусть откроет бота и пришлёт:\n/join ${code}`);
  });

  // заявки сотрудников
  bot.callbackQuery(/^req:(ok|no):(.+)$/, async (ctx) => {
    const [, verdict, id] = ctx.match;
    let req = null;
    const s = await mutate((s) => {
      req = s.requests.find((r) => r.id === id);
      if (!req || req.status !== "new") return;
      req.status = verdict === "ok" ? "ok" : "no";
      if (verdict === "ok") applyRoster(s, req.items);
    });
    await ctx.answerCallbackQuery();
    if (!req) return ctx.editMessageText("Заявка уже обработана.");
    const list = req.items.map((i) => `${ruShort(i.day)} · ${KIND_LABEL[i.kind]}`).join(", ");
    await ctx.editMessageText(`${verdict === "ok" ? "✅ Подтверждено" : "✖️ Отклонено"} · ${req.name}: ${list}`);
    const tg = Object.entries(s.people).find(([, p]) => p.empId === req.empId);
    if (tg) ctx.api.sendMessage(tg[0], verdict === "ok" ? `✅ Смены подтверждены: ${list}` : `✖️ Заявку отклонили: ${list}`).catch(() => {});
  });

  // ═════════ СВОБОДНЫЙ ТЕКСТ ═════════
  const num = (t) => Number(String(t).replace(/\s|₽|руб\.?/gi, "").replace(",", ".").replace("−", "-"));
  const parsePeriod = (t) => {
    const parts = t.split(/[-–—]|по/).map((x) => x.trim()).filter(Boolean);
    const a = dateFromWord(parts[0] || ""), b = parts[1] ? dateFromWord(parts[1]) : null;
    return a ? { from: a, to: b || a } : null;
  };

  const applyRosterReply = async (ctx, items) => {
    const s = await mutate((s) => { applyRoster(s, items); });
    const done = items.map((it) => `${ruDay(it.day)} · ${KIND_LABEL[it.kind]} — ${empName(s, s.roster[`${it.day}|${it.kind}`]) || it.name}`);
    await ctx.reply("🗓 Поставил в смену:\n" + done.join("\n"), { reply_markup: new InlineKeyboard().text("🗓 Показать график", "g:0") });
  };

  const runIntent = async (ctx, a) => {
    const s = await loadState();
    switch (a.action) {
      case "roster": {
        const items = (a.items || []).filter((i) => i.day && i.kind && i.name);
        if (!items.length) return ctx.reply("Не понял, кого и когда ставить. Напиши, например: «завтра Вова 1, Денис 2».");
        return applyRosterReply(ctx, items);
      }
      case "cash": {
        const day = a.day || iso(Date.now());
        if (a.cash == null || a.hookahs == null) {
          setS(ctx, { flow: "cash", day, cash: a.cash ?? null, hookahs: a.hookahs ?? null });
          return ctx.reply(a.cash == null
            ? `Касса за ${ruDay(day)} — какая сумма?`
            : `Касса за ${ruDay(day)}: ${fmt(a.cash)} ₽. Сколько было кальянов?`);
        }
        const s2 = await mutate((st) => setDayTotals(st, day, { cash: a.cash, hookahs: a.hookahs }));
        return ctx.reply(`💰 Записал за ${ruDay(day)}: ${fmt(a.cash)} ₽ · ${a.hookahs} кальянов\n${shiftLine(s2, day)}`);
      }
      case "cash_show": {
        const day = a.day || iso(Date.now());
        return ctx.reply(cashText(s, day), { reply_markup: cashKb(s, day) });
      }
      case "supply": {
        if (a.grams > 0) {
          const s2 = await mutate((st) => pushLedger(st, { type: "supply", grams: Math.round(a.grams), note: "поставка (бот)" }));
          return ctx.reply(`➕ Поставка ${fmt(a.grams)} г. На складе ${fmt(stockOf(s2))} г`);
        }
        setS(ctx, { flow: "supply" });
        return ctx.reply("Пришла поставка. Загрузить из файла или ввести вручную?", {
          reply_markup: new InlineKeyboard().text("📄 Из файла", "w:file").text("✍️ Вручную", "file:manual"),
        });
      }
      case "sale":
      case "writeoff": {
        const mode = a.action === "sale" ? "sale" : "wo";
        const p = a.from ? { from: a.from, to: a.to || a.from } : nextPeriod(s);
        const q = {};
        for (const it of a.items || []) if (BOWL_G[it.kind] && it.qty > 0) q[it.kind] = Math.round(it.qty);
        if (!Object.keys(q).length) { await startQty(ctx, mode); return; }
        setS(ctx, { flow: "qty", mode, i: BOWLS.length, q, from: p.from, to: p.to, reason: a.reason || (mode === "wo" ? "списание" : null) });
        return finishQty(ctx);
      }
      case "adjust": {
        if (!a.grams) return ctx.reply("На сколько граммов поправить? Например: «-300 просыпали».");
        const s2 = await mutate((st) => pushLedger(st, { type: "adjust", grams: Math.round(a.grams), note: a.note || (a.grams > 0 ? "ручное добавление" : "ручное уменьшение") }));
        return ctx.reply(`${a.grams > 0 ? "+" : ""}${fmt(a.grams)} г. На складе ${fmt(stockOf(s2))} г`);
      }
      case "inventory": {
        const kind = a.kind || "mid";
        if (a.actual == null) { setS(ctx, { flow: "inv", kind }); return ctx.reply(`${INV_KIND[kind]} инвентаризация. Сколько граммов по факту?`); }
        return invConfirm(ctx, kind, Math.round(a.actual));
      }
      case "stock": return ctx.reply(stockText(s), { reply_markup: stockKb });
      case "week": return ctx.reply(weekText(s, a.offset === 1 ? 1 : 0), { reply_markup: weekKb(a.offset === 1 ? 1 : 0) });
      default:
        return ctx.reply(
          `Не понял${a.hint ? `: ${a.hint}` : ""}. Попробуй иначе или нажми кнопку.\n\n` +
          "Что я умею словами:\n" +
          "• «завтра Вова 2, Денис 1» — поставить смены\n" +
          "• «касса за вчера 48000, 19 кальянов»\n" +
          "• «пришла поставка табака»\n" +
          "• «продали 14 классики и 3 фрукта за 1-5 сентября»\n" +
          "• «списать 2 классики перезабивка»\n" +
          "• «инвентаризация 7450»\n" +
          "• «сколько на складе», «график на следующую неделю»",
          { reply_markup: menu });
    }
  };

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const st = getS(ctx);

    // шаги диалогов
    if (st?.flow === "cash") {
      const nums = (text.replace(/(\d)[ \u00a0](?=\d{3}\b)/g, "$1").match(/-?\d+/g) || []).map(Number);
      let cash = st.cash ?? null, hookahs = st.hookahs ?? null;
      if (cash == null && nums.length) cash = nums.shift();
      if (hookahs == null && nums.length) hookahs = nums.shift();
      if (cash == null) return ctx.reply("Нужна сумма кассы числом, например 52000.");
      if (hookahs == null) { setS(ctx, { ...st, cash }); return ctx.reply(`Касса ${fmt(cash)} ₽. Сколько было кальянов?`); }
      const day = st.day;
      const s = await mutate((s) => setDayTotals(s, day, { cash, hookahs }));
      clrS(ctx);
      return ctx.reply(`💰 Записал за ${ruDay(day)}: ${fmt(cash)} ₽ · ${hookahs} кальянов\n${shiftLine(s, day)}`,
        { reply_markup: new InlineKeyboard().text("✏️ Изменить", `c:set:${day}`).text("🗑 Удалить", `c:del:${day}`) });
    }

    if (st?.flow === "newemp") {
      const name = text.replace(/[^\p{L}\s-]/gu, "").trim();
      if (!name) return ctx.reply("Напиши имя словами.");
      const s0 = await loadState();
      if (s0.employees.some((e) => translit(e.name) === translit(name))) { clrS(ctx); return ctx.reply(`${name} уже есть в штате.`); }
      const s = await mutate((s) => { s.employees.push({ id: uid(), name: name[0].toUpperCase() + name.slice(1), color: null }); });
      clrS(ctx);
      return ctx.reply(`✅ ${name[0].toUpperCase() + name.slice(1)} добавлен. В штате ${s.employees.length} чел.`,
        { reply_markup: new InlineKeyboard().text("👥 Поставить в смену", "sh:list") });
    }

    if (st?.flow === "empname") {
      const name = text.replace(/[^\p{L}\s-]/gu, "").trim();
      if (!name) return ctx.reply("Напиши имя словами.");
      const s = await mutate((s) => { applyRoster(s, [{ day: st.day, kind: st.kind, name }]); });
      clrS(ctx);
      return ctx.reply(`✅ ${ruDay(st.day)}\n${shiftLine(s, st.day)}`, { reply_markup: dayShiftKb(st.day) });
    }

    if (st?.flow === "adjust") {
      const m = text.match(/^\s*(-?\d+)\s*(.*)$/);
      if (!m) return ctx.reply("Нужно число, например 500 или -500.");
      const grams = Number(m[1]);
      const s = await mutate((s) => pushLedger(s, { type: "adjust", grams, note: m[2].trim() || (grams > 0 ? "ручное добавление" : "ручное уменьшение") }));
      clrS(ctx);
      return ctx.reply(`${grams > 0 ? "+" : ""}${fmt(grams)} г. На складе ${fmt(stockOf(s))} г`);
    }

    if (st?.flow === "supply") {
      const g = Math.round(num(text));
      if (!(g > 0)) return ctx.reply("Пришли фото/PDF накладной или напиши число граммов.");
      const s = await mutate((s) => pushLedger(s, { type: "supply", grams: g, note: "поставка (бот)" }));
      clrS(ctx);
      return ctx.reply(`➕ Поставка ${fmt(g)} г. На складе ${fmt(stockOf(s))} г`);
    }

    if (st?.flow === "inv") {
      if (st.step === "confirm") return ctx.reply("Нажми «Сохранить» или «Отмена».");
      const g = Math.round(num(text));
      if (!(g >= 0)) return ctx.reply("Нужно число граммов, например 7450.");
      return invConfirm(ctx, st.kind, g);
    }

    if (st?.flow === "qty") {
      if (st.step === "period") {
        const p = parsePeriod(text);
        if (!p) return ctx.reply("Не понял период. Напиши «5.09» или «1.09 - 5.09».");
        setS(ctx, { ...st, from: p.from, to: p.to, step: null });
        return askQty(ctx);
      }
      if (st.step === "reasonOwn") { setS(ctx, { ...st, reason: text, step: null }); return finishQty(ctx); }
      const n = Math.round(num(text));
      if (!(n >= 0)) return ctx.reply("Нужно число, например 12 или 0.");
      const q = { ...st.q, [BOWLS[st.i][0]]: n };
      const i = st.i + 1;
      setS(ctx, { ...st, q, i });
      if (i < BOWLS.length) return askQty(ctx);
      return finishQty(ctx);
    }

    // свободный текст: сначала быстрый разбор смен, потом Claude
    const quick = parseRoster(text);
    if (quick.length && /\d|перв|втор|ноч|вечер|утр|день/i.test(text)) return applyRosterReply(ctx, quick);

    const think = await ctx.reply("Секунду…");
    try {
      const a = await askClaude(ctx.state.st, text);
      await ctx.api.deleteMessage(ctx.chat.id, think.message_id).catch(() => {});
      return runIntent(ctx, a);
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat.id, think.message_id,
        "Не разобрал сообщение. Напиши проще — например «завтра Вова 1» или «касса 52000, 21 кальян» — либо нажми кнопку внизу.").catch(() => {});
    }
  });

  bot.catch((e) => console.error("bot error", e.error));

  const hookPath = `/tg/${BOT_TOKEN.split(":")[0]}`;
  // отвечаем Telegram сразу, обработку делаем в фоне: распознавание длится дольше таймаута вебхука
  let botReady = bot.init().then(() => console.log("bot ready"));
  app.post(hookPath, (req, res) => {
    res.sendStatus(200);
    botReady.then(() => bot.handleUpdate(req.body)).catch((e) => console.error("update error", e));
  });
  if (RENDER_EXTERNAL_URL) {
    bot.api.setWebhook(`${RENDER_EXTERNAL_URL}${hookPath}`, { drop_pending_updates: true })
      .then(() => console.log("webhook set")).catch((e) => console.error("webhook", e.message));
  } else {
    bot.start();
  }
} else {
  console.warn("BOT_TOKEN не задан — бот выключен");
}

initDb().then(() => app.listen(PORT, () => console.log("listening on", PORT))).catch((e) => { console.error(e); process.exit(1); });
