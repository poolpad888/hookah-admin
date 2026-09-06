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
const pending = new Map(); // chatId → { total, items, docTotal }

if (BOT_TOKEN) {
  const bot = new Bot(BOT_TOKEN);
  const adminIds = String(ADMIN_ID || "").split(",").map((x) => x.trim()).filter(Boolean);
  // /id работает всегда — им узнают свой Telegram id, чтобы вписать в ADMIN_ID
  bot.command("id", (ctx) => ctx.reply(`Твой Telegram id: ${ctx.from?.id}\nВпиши его в переменную ADMIN_ID на Render.`));
  // приглашение сотрудника: /join КОД
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

  // роли: админ из ADMIN_ID или из базы, сотрудник — из базы
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
        ? "🗓 Твои смены:\n" + (mine.map(([d, k]) => `${d.slice(8)}.${d.slice(5, 7)} · ${KIND_LABEL[k]}`).join("\n") || "—")
          + (pend.length ? "\n\nНа подтверждении:\n" + pend.flatMap((r) => r.items.map((i) => `${i.day.slice(8)}.${i.day.slice(5, 7)} · ${KIND_LABEL[i.kind]}`)).join("\n") : "")
        : "Смен пока нет. Напиши, например, «завтра 1».");
    }
    if (text === "✍️ Заявка на смену") return ctx.reply("Напиши, когда готов работать: «завтра 1», «пт 2, сб 1».");

    const items = parseRoster(text, myName);
    if (!items.length) return ctx.reply("Не понял. Напиши, например: «завтра 1» или «пт 2, сб 1».");
    const req = { id: uid(), empId: p.empId, name: myName, items, ts: Date.now(), status: "new" };
    await mutate((s) => { s.requests.push(req); });
    const list = items.map((i) => `${i.day.slice(8)}.${i.day.slice(5, 7)} · ${KIND_LABEL[i.kind]}`).join("\n");
    const admins = new Set(adminIds.concat(Object.entries(ctx.state.st.people).filter(([, x]) => x.role === "admin").map(([id]) => id)));
    for (const aid of admins) {
      ctx.api.sendMessage(aid, `✍️ Заявка от ${myName}:\n${list}`, {
        reply_markup: new InlineKeyboard().text("✅ Подтвердить", `req:ok:${req.id}`).text("✖️ Отклонить", `req:no:${req.id}`),
      }).catch(() => {});
    }
    return ctx.reply("Отправил управляющему:\n" + list);
  });

  const KIND_LABEL = { day: "1-я", night: "2-я" };
  const staffMenu = new Keyboard().text("🗓 Мои смены").text("✍️ Заявка на смену").resized();
  const menu = new Keyboard()
    .text("📦 Остаток").text("📊 Сегодня").row()
    .text("▶️ Открыть смену").text("⏹ Закрыть смену").row()
    .text("🎯 Продажа").text("➕ Поставка").text("➖ Списание").row()
    .text("🗓 График").text("👥 Сотрудники").resized();

  const stockText = (s) => {
    const st = stockOf(s);
    const last = s.ledger.slice(-5).reverse().map((m) => `${m.date.slice(5)} · ${m.grams > 0 ? "+" : ""}${m.grams} г · ${m.note || m.type}`).join("\n");
    return `📦 На складе: *${fmt(st)} г*\n\nПоследние движения:\n${last || "—"}`;
  };

  bot.command("start", (ctx) => ctx.reply("Привет! Я админ кальянной.\n\n• Пришли фото или PDF накладной — посчитаю граммы.\n• График смен пиши текстом, например:\n  «завтра Вова 1, Андрей 2»\n  «пт Вова первая Лена вторая»\n• Кнопки ниже — смены, склад, продажи.", { reply_markup: menu }));

  bot.hears("👥 Сотрудники", async (ctx) => {
    const s = await loadState();
    const linked = Object.values(s.people).filter((p) => p.role === "staff");
    const kb = new InlineKeyboard();
    s.employees.forEach((e) => {
      const on = linked.some((p) => p.empId === e.id);
      kb.text(`${on ? "✅" : "➕"} ${e.name}`, `inv:${e.id}`).row();
    });
    ctx.reply(s.employees.length
      ? "Кому выдать доступ в бот? ✅ — уже подключён.\nНажми на имя, я дам код для сотрудника."
      : "Штат пуст. Сначала добавь сотрудников — например, напиши «завтра Вова 1».", { reply_markup: kb });
  });
  bot.callbackQuery(/^inv:(.+)$/, async (ctx) => {
    const empId = ctx.match[1];
    const code = Math.random().toString(36).slice(2, 7).toUpperCase();
    const s = await mutate((s) => { s.invites[code] = empId; });
    const emp = s.employees.find((e) => e.id === empId);
    await ctx.answerCallbackQuery();
    ctx.reply(`Код для ${emp?.name}: \`${code}\`\n\nПусть откроет бота и пришлёт:\n/join ${code}`, { parse_mode: "Markdown" });
  });

  // подтверждение заявок
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
    const list = req.items.map((i) => `${i.day.slice(8)}.${i.day.slice(5, 7)} · ${KIND_LABEL[i.kind]}`).join(", ");
    await ctx.editMessageText(`${verdict === "ok" ? "✅ Подтверждено" : "✖️ Отклонено"} · ${req.name}: ${list}`);
    const tg = Object.entries(s.people).find(([, p]) => p.empId === req.empId);
    if (tg) ctx.api.sendMessage(tg[0], verdict === "ok" ? `✅ Смены подтверждены: ${list}` : `✖️ Заявку отклонили: ${list}`).catch(() => {});
  });

  bot.hears("🗓 График", (ctx) => { pending.set(ctx.chat.id, { ask: "roster" }); ctx.reply("Пиши смены текстом. Примеры:\n«Вова 1 Андрей 2» — на сегодня\n«завтра Вова 1, Лена 2»\n«пт Вова первая; сб Андрей вторая»\nМожно несколько строк сразу."); });
  bot.hears("📦 Остаток", async (ctx) => ctx.reply(stockText(await loadState()), { parse_mode: "Markdown" }));
  bot.hears("📊 Сегодня", async (ctx) => {
    const s = await loadState(); const t = todaySummary(s);
    const cur = s.shift ? `Открыта ${SHIFT_RU[s.shift.kind]} с ${new Date(s.shift.openedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}, кальянов: ${s.shift.sales.length}, касса ${fmt(cashOf(s.shift))} ₽` : "Смена не открыта";
    ctx.reply(`📊 Сегодня\nКальянов: ${t.qty}\nТабака ушло: ${fmt(t.grams)} г\nКасса: ${fmt(t.cash)} ₽\n\n${cur}`);
  });

  bot.hears("▶️ Открыть смену", async (ctx) => {
    const s = await loadState();
    if (s.shift) return ctx.reply(`Уже открыта ${SHIFT_RU[s.shift.kind]}. Сначала закрой её.`);
    const kb = new InlineKeyboard().text("1-я (11:00–23:00)", "open:day").text("2-я (16:00–02:00)", "open:night");
    ctx.reply("Какую смену открыть?", { reply_markup: kb });
  });
  bot.callbackQuery(/^open:(day|night)$/, async (ctx) => {
    const kind = ctx.match[1];
    const ok = await mutate((s) => openShift(s, kind));
    await ctx.answerCallbackQuery();
    ctx.editMessageText(ok === false ? "Смена уже открыта." : `▶️ ${SHIFT_RU[kind]} открыта.`);
  });
  bot.hears("⏹ Закрыть смену", async (ctx) => {
    const s = await loadState();
    if (!s.shift) return ctx.reply("Открытой смены нет.");
    const kb = new InlineKeyboard().text(`Закрыть — касса ${fmt(cashOf(s.shift))} ₽`, "close").text("Отмена", "cancel");
    ctx.reply(`Закрыть ${SHIFT_RU[s.shift.kind]}? Кальянов: ${s.shift.sales.length}`, { reply_markup: kb });
  });
  bot.callbackQuery("close", async (ctx) => {
    const done = await mutate((s) => closeShift(s));
    await ctx.answerCallbackQuery();
    ctx.editMessageText(done && done.sales ? `⏹ ${SHIFT_RU[done.kind]} закрыта. Кальянов: ${done.sales.length}, касса ${fmt(cashOf(done))} ₽` : "Открытой смены нет.");
  });

  bot.hears("🎯 Продажа", async (ctx) => {
    const s = await loadState();
    if (!s.shift) return ctx.reply("Сначала открой смену.");
    const kb = new InlineKeyboard();
    for (const k of ["regular", "premium", "electro"]) kb.text(`${KIND_RU[k]} ${fmt(s.prices[k])}`, `sale:${k}:0`);
    kb.row();
    for (const d of [10, 15, 20, 30]) kb.text(`Обычный −${d}%`, `sale:regular:${d}`);
    ctx.reply("Что продали?", { reply_markup: kb });
  });
  bot.callbackQuery(/^sale:(regular|premium|electro):(\d+)$/, async (ctx) => {
    const [, kind, disc] = ctx.match;
    const rec = await mutate((s) => sale(s, kind, Number(disc)));
    await ctx.answerCallbackQuery(rec ? "Записано" : "Смена не открыта");
    if (rec) {
      const s = await loadState();
      ctx.reply(`✅ ${KIND_RU[kind]}${disc > 0 ? ` −${disc}%` : ""} · ${fmt(rec.price)} ₽. Касса смены ${fmt(cashOf(s.shift))} ₽, склад ${fmt(stockOf(s))} г`);
    }
  });

  bot.hears("➕ Поставка", (ctx) => { pending.set(ctx.chat.id, { ask: "supply" }); ctx.reply("Сколько граммов пришло? Напиши число (или пришли фото/PDF накладной)."); });
  bot.hears("➖ Списание", (ctx) => { pending.set(ctx.chat.id, { ask: "writeoff" }); ctx.reply("Сколько граммов списать? Напиши число, можно с причиной: `60 перезабивка`", { parse_mode: "Markdown" }); });

  // число в ответ на «Поставка» / «Списание»
  const replyRoster = async (ctx, text) => {
    const cur = await loadState();
    const items = parseRoster(text, cur.employees);
    if (!items.length) return false;
    const s = await mutate((s) => { applyRoster(s, items); });
    const done = items.map((it) => {
      const emp = s.employees.find((e) => s.roster[`${it.day}|${it.kind}`] === e.id);
      return `${it.day.slice(8)}.${it.day.slice(5, 7)} · ${KIND_LABEL[it.kind]} — ${emp ? emp.name : it.name}`;
    });
    await ctx.reply("🗓 Записал:\n" + done.join("\n"));
    return true;
  };

  bot.on("message:text", async (ctx, next) => {
    const p = pending.get(ctx.chat.id);
    if (p?.ask === "roster") { pending.delete(ctx.chat.id); if (await replyRoster(ctx, ctx.message.text)) return; return ctx.reply("Не разобрал. Формат: «Вова 1 Андрей 2»"); }
    if (!p?.ask) {
      // текст вида «вова 1 андрей 2» — ставим смены и без нажатия кнопки
      if (/\d|перв|втор|ноч|день/i.test(ctx.message.text) && /[а-яё]{3,}/i.test(ctx.message.text) && !/^\s*\d+\s*$/.test(ctx.message.text)) {
        if (await replyRoster(ctx, ctx.message.text)) return;
      }
      return next();
    }
    const m = ctx.message.text.match(/^\s*(\d+)\s*(.*)$/);
    if (!m) return ctx.reply("Нужно число граммов, например 1500.");
    const grams = Number(m[1]); const note = m[2].trim();
    pending.delete(ctx.chat.id);
    const s = await mutate((s) => {
      if (p.ask === "supply") addMove(s, { type: "supply", grams, note: note || "поставка (бот)" });
      else addMove(s, { type: "writeoff", grams: -grams, note: note || "списание (бот)" });
    });
    ctx.reply(`${p.ask === "supply" ? "➕" : "➖"} ${grams} г. На складе ${fmt(stockOf(s))} г`);
  });

  // файл → распознать → предложить действие
  const handleFile = async (ctx, fileId, mediaType) => {
    const wait = await ctx.reply("Читаю накладную… это может занять до минуты");
    const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);
    try {
      const f = await ctx.api.getFile(fileId);
      const buf = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`)).arrayBuffer());
      const r = await recognize({ base64: buf.toString("base64"), mediaType });
      pending.set(ctx.chat.id, r);
      const lines = r.items.map((it) => `• ${it.name}${it.assumed ? " *" : ""} — ${it.grams} г${it.calc ? ` (${it.calc})` : ""}`).join("\n");
      const warn = r.docTotal !== null && r.docTotal !== r.total ? `\n\n⚠️ В документе напечатано ${fmt(r.docTotal)} г, по строкам ${fmt(r.total)} г — проверь.` : "";
      const s = await loadState();
      const kb = new InlineKeyboard()
        .text(`➕ Поставка +${fmt(r.total)} г`, "file:add").row()
        .text(`📋 Инвентаризация → ${fmt(r.total)} г (сейчас ${fmt(stockOf(s))})`, "file:replace").row();
      if (r.docTotal !== null && r.docTotal !== r.total) kb.text(`Взять итог документа ${fmt(r.docTotal)} г`, "file:doc").row();
      kb.text("Отмена", "cancel");
      await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `Нашёл ${r.items.length} строк, итого *${fmt(r.total)} г*\n\n${lines}${warn}\n\nЧто с этим сделать?`, { parse_mode: "Markdown", reply_markup: kb });
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat.id, wait.message_id, "Не удалось распознать: " + e.message).catch(() => {});
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
      if (mode === "add") addMove(s, { type: "supply", grams: total, note: "накладная (бот)" });
      else { const diff = total - stockOf(s); if (diff) addMove(s, { type: "adjust", grams: diff, note: "инвентаризация по файлу (бот)" }); }
    });
    ctx.editMessageText(mode === "add" ? `➕ Поставка ${fmt(total)} г записана. На складе ${fmt(stockOf(s))} г` : `📋 Остаток установлен: ${fmt(stockOf(s))} г`);
  });
  bot.callbackQuery("cancel", async (ctx) => { pending.delete(ctx.chat.id); await ctx.answerCallbackQuery(); ctx.editMessageText("Отменено."); });

  bot.catch((e) => console.error("bot error", e.error));

  const hookPath = `/tg/${BOT_TOKEN.split(":")[0]}`;
  // отвечаем Telegram сразу, а обновление обрабатываем в фоне:
  // распознавание накладной занимает больше 10 сек, и вебхук успевал отвалиться по таймауту
  let botReady = bot.init().then(() => console.log("bot ready"));
  app.post(hookPath, (req, res) => {
    res.sendStatus(200);
    botReady.then(() => bot.handleUpdate(req.body)).catch((e) => console.error("update error", e));
  });
  if (RENDER_EXTERNAL_URL) {
    bot.api.setWebhook(`${RENDER_EXTERNAL_URL}${hookPath}`, { drop_pending_updates: true })
      .then(() => console.log("webhook set")).catch((e) => console.error("webhook", e.message));
  } else {
    bot.start(); // локально — long polling
  }
} else {
  console.warn("BOT_TOKEN не задан — бот выключен");
}

initDb().then(() => app.listen(PORT, () => console.log("listening on", PORT))).catch((e) => { console.error(e); process.exit(1); });
