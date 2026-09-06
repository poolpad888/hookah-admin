import express from "express";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bot, InlineKeyboard, Keyboard, webhookCallback } from "grammy";

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
  bot.use(async (ctx, next) => {
    if (adminIds.length && !adminIds.includes(String(ctx.from?.id))) return ctx.reply("Доступ закрыт. Твой id: " + ctx.from?.id);
    await next();
  });

  const menu = new Keyboard()
    .text("📦 Остаток").text("📊 Сегодня").row()
    .text("▶️ Открыть смену").text("⏹ Закрыть смену").row()
    .text("🎯 Продажа").text("➕ Поставка").text("➖ Списание").resized();

  const stockText = (s) => {
    const st = stockOf(s);
    const last = s.ledger.slice(-5).reverse().map((m) => `${m.date.slice(5)} · ${m.grams > 0 ? "+" : ""}${m.grams} г · ${m.note || m.type}`).join("\n");
    return `📦 На складе: *${fmt(st)} г*\n\nПоследние движения:\n${last || "—"}`;
  };

  bot.command("start", (ctx) => ctx.reply("Привет! Я админ кальянной. Пришли фото или PDF накладной — посчитаю граммы. Кнопки ниже — смены и склад.", { reply_markup: menu }));
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
  bot.on("message:text", async (ctx, next) => {
    const p = pending.get(ctx.chat.id);
    if (!p?.ask) return next();
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
    const wait = await ctx.reply("Читаю накладную…");
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
      await ctx.api.editMessageText(ctx.chat.id, wait.message_id, "Не удалось распознать: " + e.message);
    }
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
  app.use(hookPath, webhookCallback(bot, "express"));
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
