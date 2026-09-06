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

// ───────────────────────── PWA: манифест, иконки, service worker ─────────────────────────
const ICON192 = "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";
const ICON512 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAABSlBMVEVa68ZN5r9B4rk33rQv2a4l1akhy6AlwJkssY8VsIoooIIXnHsRnHogiW8OgmYVY1AMVUMPUkIMUUEMTj4LUD8TSj0MSzwMSjsMSDoNRTgMRzgMRDcLRzgQQTUMQjUMQDMLQzULQDQMPzILPzIMPTEKQDMJQDMKPjEMPDAKPTAMOy8JOy8LOi8LOi4JOiwMOS4LOC0MNywLNisLNSsJOC0KNywJNisJNSoINikMMykLNCoKMykLMigMMScKMScMLycJNCkJMigIMygIMScLLyYJMCYIMCUILyQLLCQKKSEJLCMJJx8ILSQILCMIKyIIKSAHLCMHKiEHKB8KJh8JJR4JJB0IJR4IJBwJIxwIIxwIIhsIIBoHJR0HIxwHIhsHIBkHHxgGHxkHHhcGHRcFHBYGGhQGFxEFGBMFGBIFGBAFFxIBGRYFFhEAAADnB/uIAABxB0lEQVR42u2d+V9Vx9KvmWQzb1DjEIgBUQEBAZkOiCOgkVEBQYzTiZqT5IT//9e719hV3VXV1WuvTTz38/a9b0xMTgafZ32ruld3r6az8xi/bD189PDhw8ePH9V+qP3/tdpYWXm4Eo3az69wY5Uc83Dcvz9v/TExmJ/Gf4k1av+gB9lI/8H5H6+Z8Ygcm5sbZvxSG9mP5HiZj/3a/9/ej37YPjgXMmdNjf3bD208fFwDH/86PMzGGuAv4p/30LfI3a9jzBNjORrAggdoeCTYhA54FDD8k7Edj/3jw5dvDv6HBfjl8aPooa8NhD99/FfSx5/FnzyEHvo5ORfpXDzq5Z+NB+QQHSiuwDYch0cn/4MC1KjX2Cf8HzqPv8H/UMCf8F8h8SNyYeznJP73Gf5RFKyuyhK4/AkF/GXA4h87sH343/8hAX55nDz3gD/5+Hvwz7MPv1TcGfZz1l+AB/X8py5A/qseBwj+yIFfxJEbsO2Ow9o42v6fEOBp9F8K8GP+uvSfd/mrCr3Nfs6Qn5PGvHfI/FMHHpERoFZga0tW4Kg23n7nAuwk/5nw8ef484//vMN/XoEfs58LGfOa4eEfKWDhRw74Fdjakg04iseb0rvC8gR49RDgB/x1+Fcx/vmVgIcfwZ8LH/5+EFjwQB0CQQpsJUNQ4CgdJ2+/SwEep/hx/LP8nfk+xk88/Rr6c4VGwNSgQCHQKbBlCyCFwNs3350AptdFj/9D7eO/ivHPK/HXD18jxDz+VyElqP3X8TFgzwdcBVz+ogG18eE7EuDgcSB/d7kvWfbJ8M+rsh+wmit10EGA/pVcCeJpQPK7j8hmYGODN2CLEoAvA7EBJ4ffiQCPAf40+B/b/KXmfzXhv2oHLUEfsJmV6M/OzjJsZ60R2hPAfzPOAXdJIE6BjQ1bga0tm3+QAW+OD74DAV4B/BsPUfln+K+Q/O1fZRJ/RiYix8A3YGcF7jJ/bALdCDASrEmrQrYBEXDHgC3RgKwRTBUooxDUJcAB+i96iOKfWfolXvZg/PMkfvBk5vjZx3smhzsrDm09mJckSP4LPG8Iar86VBvgN+AlsRgADXjzjwrwi4Y/xE++61tZtX5p89+dc5f3EmwC/ZnaYInPoEGZYP+xMCfIHEj/K1akGIh/gaiZQFAIHMYLgpYBJ/+YAA83yuFvej/wg4t/Lsc/Z+O38M46DszQY9Y35nwTQ7RaGaLAC9j/SQaANwOHh6QBdaZAU90TP8j/sZ4/nujZPzr45+4zmS0+3DPSmPUPclrAK5DNA8hXRJkCG64CfC8I3g0eHjbEgKZSHn/A3y7/Kxr+9nA7fBI/h9nLXkXfWMCvEeEXVrX/LuOA2wpgBV44CmwxCkADtkkDDs5ZgEc2/oeB8U/jv8/hD6KvGrN6JdgFQ2rDQuwAigE0GWAUUIaAkAFvFs5TgI1S+a9ae7tC8AdBnzZjRp8P4hKBhZ6IAXthGCqwufliRxECOgMOz02Arcdq/gGPfxar6QwP4Z81v++jT8GlwIuZD/8KaZ3IKQLGAaPAI0qBuBuMfiOFAOgEt+0+wFXg7dtzEmBjo0z+q5i/M8GHENLfY+m7Dzf7wM+GDc/yAOFAWgliD8iNYvkrIjYEyLkga8Db2jg8BwGeP9bxZ+Ofe/wN/zlyVp4v8NH07Wdcm/UhRtgOMJMBGAPp6rD9bhAasLOzw4UAuRpAG/A2GQ0X4OFGg/jPEY8/+HVPf495+C36NHp//Q+TgH5PkDmQzgoJBdJXg4C/q0CQAYD/29MGC/BY4P9Qz9/FP6fA76EP/oj+C6aSUX8eEI2A40C6xUVQAAkQbsA2NOBtPsJ7wQAB/rXB8NeWf/pcB+Av4Scn94g+1wJMwVFSPeBWhpACK4UU4DrBl7wBb8E4bJgAj8vhTzz+cxx+mPosfRI+gT7jPy0Onv/0D9XqDzPMOrHggDFgjRSACAHmvQBTBd68QQa8bZAApfJfhY//3Jwz70+efvSCR6BfAwv5k+zvxiP5C70KUDHwQ29XbfT+gIKJdsCcZ7BSIF0WWl/fFBTYUrwatPhjA940RAAtf678M/Gf11O39U9Tn5/w5fQNf4L9XTBS/lPs8PFPDED/qrwDpAIx/3VbAScEMv6iAXAeCA04PShfgMePy+DPPv4k/hn/fN9wm05+nkOf8lcP24CplD/MAOGdcVYDKAXW08EpsEUvBbgG4JWAogY0FVv9qYO/9Pib4p88hOLDD5/buz74Gf+78nBaxSwAuvLR+xOxLiC+IkACPH36lOBvDNgyTcDLl5IBR0e8AQGNQNM/z5/GP8Pjj38P5HYN3LTM/u74+PhdxQCJgnrK2WoXMGCKWhsCChCviCD/WIHNTcaArWSHADCA2SByJBmg3yfS1Pj6T8f/HMN/LluLl/DbzzoPfzwbwfxRUwgF6KrO0lsP+beEK7YBm9RwDdgqbMDbD+UJEPD8Bz7+cy7+OfvBn/bSz8Cx7Ovin4wfoABdP6BlIcsB4gXBWlYEHsgKgBAQDHipM+BtWQKUzh/u8mIef/DQ8/ghOIl9zH+c/nnSEcKD8V4oQO8t+GYCO0AsCET085fEkgEvXsAQ8DUCR0dlGNBUYv4H8/fjn8b4p6lKPyXCv5WMce9gEoGMgCqoAbgWkK8JVxIFzB4BRoEX2IBfOANc/sRygNKApnN4/unyb/Ov/eCWfISfbPTGefi3zCjCH2hQ++dXmSIA/vVRG+AqYPYJPUoVWOcM2JINsKcBnAEf6xeA5f9Qw196/A3/ZMHXfvzzh97BzzX3DHuW/wQY4/7+ABnQi98O5S64a0LOnuF0OUgOgS23FQw34N279/UK8Lhx/OcQfxL/NFjjJ/DDB1eAf2tc+pPkX0or0Mv1gbkDc/AqEu5qgXRFcE0XAkwrqDHgXTTqE+ARFQDl8k9+7Sz+2QTMi99p7Tj2QdWALAtTUz/1chEAOkFyZdg6TLwmhsALuCDAGbDtNyDm/+7XegR4XBb/VZk//fhPzfDhDwhx8O2fHS888k4ANYI/sbtFyN3jxKVCWQjQc0GqEQgx4F06PhQX4GG5zz+Df45+/Kec2k8t7tD0Ff1/WvnJPyIliP8VeqnVIFKBOaxAdMfQA10I7OyUYkDG/93bwgL8S+L/WMVfEf9zDP67HP4UrqfdJxN/QvvMT9C1YOonWAOm7RdGc+gwEVQgvWaMDYF1yH9TMkBeDDAGvHunNaApaAJQLv85jv/03bsy/lsSfacSmIfb3//hmLB7ATgT+CH+VxQUyAd92aQJAfBqKMLuhEC4Ae/g+FRMgMc0/8dl8c92+5KP/10BP9Pc0YQnNL2/3CLAKSLsAqpZkfIdKVxaWqIiIFcAvx2u14CI/+k7PIoIUDZ/dfwnL/emzaqfi5/JeQvpWPzzt3TD0wTmIdALa4B5XeTEAFBgKR7pTYN0CNgG7NRnwOmpZcCHcAGoCUBh/rr4T3frRL/M4PEn8NsPu0t/7FbgUM0Fo9+tUgJME83AXLbbZTERYGmVuVwq3STGlwE4HVQZcHrqGPA1WACO/8Mg/qsB8T+VP/53ifS323rMzoV/8+ZNH/Sb6K9RLhHDGnDzLnxhTO0cr/1mcTExgLteLNsnCreIkAYIS4LYgJMTwoBQAR5r+a8V5z/jPv4x/rtu+tsTepn+zZs3Gf43raEMBGgAqAE/xGFlNo7gE+Xp8x+PmH9tMkBdLpYbYM0FKQM0LwZPTsIMIAXYVPF/WDL/5PGfdtLfDnwm+scQ4ls3BfA6DbAIrgADyc9MM5fOpM9/YgB3vRw4QL7pNYB/M2yWA45PAg1o0hWAx9oGwF//k3xE6T+VP/6150nEf2ucfvjHHM48+1E8xuCQLcACVM3LQsKBSIHFXIAlSQHhuEioAScnnABvAgRoJP/08Weqv8OfmcS59InHWuZO8mdNyB0AXWA1MmKK20Za+w9dBENjwCPOAKkGIANOTngD9AI8Lz4BKM4/rafE4+/D7414kb/kAqVA1UoAsDfVFgDAFxXwGiB1gciA45Nj3oAPagEeF54AuPznfPzR4z/tPv4e/GNK/Ib/SDIUKpAR4JQA4MA0zT9TwDKAmAq4BmzqDajxPy5gQJOyADSUf4r/rg5/OP0a/xE8FHmAVxQnXAEGiCMnhv/CIhpOCJBTAa4VVBlwfOwYgAT4+EolgNAA1M1/juQ/jfiL6W/hp1D/7PxEbYyE80caTOTvC9E0EG9MTfaOZfxrY9EJgVyBVfaSeduAF5YArAHHyYjYHwe0AUoBcANALgDo+LPxj0/uePHTD3+Ntc0e8x8tNHIDJuD7wJ8S8NbewUSBhQXHAFQHwJuhdLc4WwZeWAIwBhwDAUIawSbvJgBlA+jj74v/u378nuyPWTvwE/5WB8ANuSOoCTAAloLdXcn52vDCAmWAqQPw3eCaZMCO0oCkAyCKADZgwS9A0QagIP/88ffxBz81xtLP+AP4Pyf9nwI2++fgtKBKCABiwGtAEgL49bBkADUToPcJqwx46xWgaANQjP8Uxd/z+FP4De2fbyL20Qh62H2Tw15rGcA5nOAo8NMPP/xkhYBtwIO6DchnAdgAR4BfP3gEOJAKwIaG/6qO/9SUefM7jQ730PwF/D+Tg+3/DH+9Djn/n7uQAOg9AanAVDUeMzAE0tfDtgEPdAbssRdHAAOYCPj11189Apwbf1D+0eEudvfGWAB+uv/TD96CAbgjyHlVNDWFBIgMqKYD14HMADMZdMoAu0WQMMCcFZQbwRr/X9+JAnwQGoANvgC4n/gJ5n9X5h/3YC5+H/1C/POGgHAAtgBgfZhV4KdMgB9cA5bQFhHGgB1yRZi5PIprAwD/X9/9VxJAaAA29A2Aiv8Uw594h5vw1+B3fnak8Eg0sA2ALQBaIGQU+CEToPoTkQF4RdAyQHgnZF0mvS0ZYCLg13QIAjzmC8DGRgD/+y7/GYr/NOZPPv43b96K2m8HP/3s45+4MVLnsPnD7SAD9msipMCULUDVTAjup68Hl2UDHskRsOVcJ8+2AYj/r5/0ApgCUDp/8/hD/tQWjnQOrsh+DP/GjZ/rAk/VALgp+Cf3PYF7vPwnI8AP1sIg2CHSCANAG4D52xHQxE8BXP5sA1APf/HxH6X4/+wZEXz8/A9Ho/5mEG4JHXO2HtsKRAYYAaozC+7rYSsEsAGbmyoD9rEBbhGw+FsGNHkCoGT+dvun4D/qx19jDegnCtyA7AvxdyxAm8KjntC8KOAUuMlEQLpNkDBg7UFdBuA24DgqAXYCsAJwDcCGUADK40/hj/jf9OM3/HP6Mf9hOEbsQHCHzwJYAa4n0wL0oig/RQYUAF2A0wVyBqT0/Qbs+dsApwesjVNagE2mAGyoGgByAaB+/t7GP2Zt6N/IBgV3WB7eKIAVII8FcMdAlgHo6qoqMRFYAgbMOwY8WtMYsFf7/3veNuA0nwVwEdDkC4CNoAKg45/t/+XjP17BHxvV4L/h0nf5K4a3GNgVIFsewgrAW4siAUwf+AN4/rO1ABAC4CMzKgNq/BkDTBE4PT2lIuATJcDjMgqAlv9dFX/f438j4w+Sv3H8R9wKkC0SuzeNTBkFTATcgwYsMgag9WDJgL09YwDTBpye0ga88wugKgAK/nPk9N/iT+If9Tz+GWvn4S/GX6EBVQHytwR5BthXl02ZLsC8HFwyIeAasIYN2KAN2NvzGnByigz4lTQgE+CVvwCQDQDbANbLX4f/xs8O/Xr4SyJcpyqApYA9EYj/C00TsLBwTzRgVWkA4L/HN4JRC/CGKQKuAHUXgLL4U48/iz82oAH8KQ2oCoAdmCDmgtGZcjMRXEAhwGRA1gWaL8+7BuzuWgIQbYBpAqUiQAoQVgDoCYCG/zjHX3z8b8gDMxwszQJyDoAUAEtC0AAswALXCJgAoA2AAuymAryUigAS4JSLgFSAHbkAhDcA5fEPw1/i829JAF8EOXuGRrNt5BNuCFgC8Aagm0MkA3Z3d0EE6AzgIqCJCwBPASiHf3j8a/kPli4AfBHkrBPHC5bkmwEowCzeKGY3Ag/qNsAV4MQXAYwAgTOAMvnXg/9GA+Cn/OEqwA0kwFhWBexXA9m9MrkAM9Z2YWRAvkEo3AD3O9NH3iJwgAR47gTABsX/IdMAUA0gP/8fL8r/hoa/Q39wcLCMLgDuBXFeE4yNosNkuA6YWcCMbQBoBcEWMeuj47YBu8gAqg1IPifiKQJIAIq/K8BDXQGwF4AK8w/FfwPTr4EfjIelAxro5yUHCAFqCty+fRvPBFwFzDTwZnx0TDBg9QFrwCaVAVwRSD4o5CkCogAe/ish/KeU/A3+n4vx50DT5IkhNpFV1AOm43Y8KAWMAWYteDo9PMgZgN8J8UuCu942IPmgkBwBH4EADv8NYhPIw4fFGwAv/5sO/+DH/wbzlKvY5/zZ2QQlwO3b0ABGgR+AANCABXsysLwqG7CRJ8Curw1IrwsABpxwEWALkPF3AuChtgH4J/gPGmKDRYdnTkkIcNsSwK4D6YHybAxMiQYsL/sNyPOfbwPgnTFyEQACPEYCxL8tXABE/ne9/H8m+Gvw36iPvmQCJ8BtMCgFkqVhsyXkB/N9Q8KAeBpgG2BNBUAHwLUB+HMychGgEiDjDwWgCoCyASjIPzj9E0qDpQ7r7w4FGLb5uwpkG0VABbh5lzEATARFA+xNwkQbsP0Sf0/IHwFNdgBsqAtAqfxv1st/sAED/hPgLCCy7bYzRslXxOZt8NRdaMBssAFoFsC1AdtkBJyQAhy4AiQfCKU6QOUrIFQA7P2fpfMfNPO/wPHjj6G1AB4Kuk4bgJrBlP/PsALEK8OUAfOUAWvYAOuNENsIskXghIyAJlwBNuorALgBoBYAXf6jAn8dfovb9esC92wENwPX4NvgpC0gFRjDCoCjIfEmEduAbIswa0C2JOjsDHHbAPKzgjgCUBPwyRHgsYmBBhUAL//w+HfwX5fRq/lbEvRaNUCqA6YKmAqQXYCBDDBbhHkD8GlRvg3A/Mk+EB4SMwng8HcDgJkB4AJQH3/3aE8B/NevE/x/dEeRVqCqioBYAbNHBOwIzDeK5Y1AdpHUkt8A6vYwqwjY/I0B7pVBqQBfEgGczWCeAHAKwH1TAMz9n+fC36V/3QtfGELxwE1A73WWf22A+wRABbgbZABuBOk7JFEReMkLcAyPiNkRQAtg+D8UO0Cb/9y58B9k8efN3fVg+F4RbvQ6EXCbiQAjAKgAdx0DzGVyHgPWhUtEd5EB25IBnABSADwUAsDiP4vu/84nAOXxH/Thz8I9MaGeQbWSN/AHpIU+0BQBMAcYh9+wT1rBWcuAbGeAbYD9cTm6CHgjwOX/65+RAEOWAHAKGLH3dID3QQDM4lfA5vx3KoCav9j0O/izhz8ml5lQJ39iQnENfTt0gOsDYRsIKoD58pDGANgGuF8XdAyIm4B90YBaANQUcLeFNEkB8NBfAO6zBcDlP14H/7QVIx7/6wB5GfTtFtFIUCUNkBQwFQB+eyo2IL9RjjAANYLr60/ZCIgNyJvAfb4InNg3hfACOPzFAnBf0QCo+P+s4i/j/7EM+sIs4VovbcAwa4B5ETRuGWD4ewyIviklGBCNmP/rVICXggCnjgG2ACgAHvoDIJsH0g1AafzxogyH/8ey8LMW4AjI+gBeAdMC/DSBDcBfmuEMiPnLBuxmCfBaMoC4LIgTwOGPBFgBL4EB/7nk27kgAJILwErjTz/+18tJ/AALcASADHAUSM6T5wKMTWADrI9NsQY8Sz4wHFvAGJC1AK9fUkUg+Y5Utg7gRMAnLAAIgIi/EwAr1hIQ5M80AGXzN/QHzwG/LcFVbEAv2oTkKjBgBBjD54aUBjx59swXAcgAJgLevGFWgmoRYAlgjoLZARDxX2ELwCzTAEyREwDz/sfmr8Vf5Om/VoIDA2wRoMoAFGAMhwBpwBI2YPXJkydpBEhFIDMgLwJCBBAC/EJ3AIkAqABY/OdBAZgFBaAR/Aftx/962Fz/WjTM72V/UMCBKi+Aa4DpAceAAWlpZA2YzyaDT554DditNwLOmra0AVD7PyjA/BzkTxQAyH+8Lv723C8M/zVqoD+n+tsM1YZjQNXaOGgZYAmgNSCNgCeJAKANIATYpSLAfSUUGUAJ8BkmgBwAKyuoA5wHBWCWaQDK5V8k/a8FDR//xIGqIMAwI8APY+EGPHkCDfBFwC7TBx4aAUgDXjWJAYD4r8LnHxSAWaYAZMejC/Mn41+P/9q1RvCHBvQSJwmkBMgMyCbIkgHLy7kBUhHYlYtAckREiIB/N+kCYGUFdQDzQgAk3342NyRwEwB7/Y95/Afdx3+wAfT1/IEBA9QREiAAbgLTLQJxFwgMMN8Zsq8Sdg1Ac8EdoQiYBPBEwKcmVQA4/FEAkA3AFFMA6uKvfPyv1TV8/GtzgXg22DtAHCZC20XNOgDcKHj3rm2AOxlcRgIwbcBOQAS8YSLAJEBAAMzPgw6QKQBT/gagQfxlulevhlswBEa6zSCCen2QOE+GNoxfN03AKNgn6DFgiTHAKQK+CDgUIyCtAXkTqA+AebYAIP5TZfEP6v4k9PEID4IhPAa544VEBpiXQdGrgfwqKZ8By44BT9UGwAg4VERAU3AAzLMFYDovAFN0AxDA/4bD/7qCP/fIXw2lDxQYcoZHARACRoDrAQbU4DMGYAF2dtwiENAF2AJE/B+LAZBPA3wBMCU0AI3gf42nf5Vmf9UdjARD5PArYHWBVbRZXDQggu/0gUQRAGuBVgTs4wg4kiKgCZ0IqjcAkhnAFFcATAMo8k/jX8s/eVQF+jJ42YQhbqgMGKnaSwHoPsH8k4nAgLQH5IvAumMA3Qfa+8OdCEhWgprARqDH/gBYnWc7wLwATPsKQDj/6zz/JKr99K+GDD9/jwJZGQARcF1nQNYDKooAEwF2H2gEABFwikuALwCy8F9FAUAXgBmmAIAG4KYkQBD/pFTzya+AT/xpFX9LgWGyEbgB7osf5AyARcDMAtgisE5vDSsYAUAATwDEn7x1A8DqANPvv4sNgJb/YDH+mGTgc6+vAdgA926ixAAQAdWf/QaAeSBXBNYpAdg+8NAjwKcmcCbUFwCrigCYmeEKQN4AlMY/6dKE7o6jf8WMq4p2UKMAc7XQ7WEgQHXMZ8AiXAggDVjnDdgFu0NVERDxTwTQBcCqGwAB/G+Wzf+a3PXXMAeT5y3wK0DcThcbAD4YYDWCiQFwKgBvD+OLgC8CXu/vayPgUy6AIgBWpQDwFQBwBDiM/3Wa/zXPpO8qIhzxVnIvMB9I3hB1XKENGAFFYGCMNSD9ziAygHsnQG8LMQK8FiMATAQ/pQJYLeCKLUDG3xsA02IBIK7/oub/Kv4+/NRDT+WANWQJeAEGOpqaOrgyAAQYlQywro7i2gB6YxCIgNdZBKQLQU4EZPw/fswF2PDPAUEA3GemgCn/OgKgOH/64bfBigWA/pP+UjB4rbcpGr1MGbgB3gjwBkw5V0i6RSBOgKfczrD8iEgaAe7m4GQmaPinAmgCYBUEwH0mAGpFbPo8+GvxY57g9z3VQHbA5V9taUrGQNoJsAaAQ2POkmD2uWmhCKQrAY+ECNhLBdgHH5S0IiCrAB8/xgY0qVrAVTYAZiF/VQEQG4B6+dsPP/h9O/sLdwOYf5T+6aiQswFjwI0x14AsAswHx9kikE0DhQhIbwpIIgAKYCLgbSrAByiA2AJG/Fe4AJg1FWA6tANk3/8F8ifwA8Yk/JAmQFTgSlcTGL2cASM/DAz8cPv2KG8AIwAqApkAT7kIyO6KSCJgm4qAt2+TJjDhHwvgD4BVJgCipYv8JQAfAPH3v0riH4AfpPmVwOFxwPDvbW5Co5pPCAet7w2k+4QZAyZZA0IiYC+/LMStAdsgAWoCfPjwMY2AJn8ArLIBkPOfnrECwCoAY94CUDd/jN/T7ReVAPMH6Z+O5iuOAdatsqQBU5NeAxQRsLeXXxcTXRsNviqdR0CtCYwioFb/P+QlgGgBcQCssgEwmwswgwLAKQBj3gLg7P/Q8XdbPxz9dQ5SAfbxj0bXoG2Ada/w2Jhzk9x47ZctNYAtAngliBQggr9rukCyDXzzJo6AD5kAnzIB+AqwugoEuI8CAPCfETvAMUUBqJN/AP5Lly7VI0EWAf0dTdTodRaGbQOcCJiejAwQIwDvDSQjYDcRYJcSIDcgFuDth6gAxDUgEUCcA66yAWAEmBEDoGH8WfwS+0tK/levSMsCQ9eoxz8uAgMeA5wiUHv4J6f4IhBFQJ4AQgTs7poIeM1FQCTAm9NIgDwCmjwtIBsAc4D/jNQBjukKQN38M1oi+0v6559eGkr+2dVKEzc6BgMNmCQMwBGQLwRIEbAlRgCoASe1EoAEkF8DUALMogqQdQFMAIz5A8Cc/+Hf/7DxfwVP/Hz0DX/yJxUO1P7R3ONvZgKD5IfH3EbQRIBQBPImEETAI08E7NsRAF8GfEhbwHgW4AgQGAAzcgDcAt//FgtAGH/68ffTr6G+JA7BgewfWW1rkkYyE0AKjLAGTJgImOKLgBsBuAjseCMg2xh4FF8XZQvwmBUgYr9CBMAcuhBCCIBb0cXZvgAozt+L/1KRwToQ/8PEx9/MBKRGMDbAdIFiEViGi8F0BKCLAnAE2GcE0wvjoACqCpDxv2/ug5mFN8KwU4D44nRFA3DDaQD0/MulT5YDo8BAR5N3VJmt4s5UIHshEBnARECNvT8CdlAE0DNBcGtoPA/MRlNwBUg+CssHwC0mAKQGoBB/6fG/VBi/3A7kL35A5Le2tbWin26+Sh8ZsxvBCSiAXQTyBEAR8ESIgK04AqgacGi+JJcY8BEJAOcAmjngnDYAxm+B519ZAPz8FfF/qY4hTQuu9DY32wWgpS0erXYR8BsADorgIoA+JlEwAtBM8PAwFuDYfFEYC9CgAKj97tgtbwBYt78E8i8bv2hBtdLsCNDclo4WuwhwBmRtAHwpzBeBgAjYYiMgFuDw+PiYiIAmTwvoCpDzn5UDIObvCwC6ANTD/1JZw/k797Y0NzsGtFUyA1As/Og1AG8L4PvAOAKWPBEAawA1E4wMOIYCnJICmAqwxgbA/VyAWRMAM0QAZL8bFABa/mz8l4b/6uDwIPr7X+pozgYMgEouQLOzIiwZcGfMjQCrCGTzQDYCNqkIsGeC234Baug3cACssRUg55/XACEAdPwHJf4/Cvwb+fgPxU/pNZMDSfxTAlQoAZoGuMMiiQFjY4QBVh8I1gHICHiqiABXgJMTXAOaogDYwAKsrXEt4H0gQAkB4H3+w/hfKi/+k5geuZLVgmpLczNlQEslN6CZWBHmDKjRv3NHKgJQADYCnIPCW1QbGBtwfJwZkApwCgUw/B8m/LkKUOM/m10MCAQoHAA3CAG+B/6XrqXn+6+mAvQ2N9MCtBoB/CvCuQG37xgDhD7QEwGbzjFRsg20BDh2BHi4IQeAEeB+HgBzYD9wHR0AUQAK8w8CfJkcoALcuZ3VgNoY6GhuZgyoVDIDWu3p4ZBwZHA0gu8WASICFtkIqHF3TohYEQBWA4+3rQgwAmzkAiQvA9kAuJ8LMOcPgPGAADhP/pe9I06AO9FIBai2NTczBjRXcgNa6J0BhAHxLNBXBNA3BakIiB5/OgLyNnB/318DksOhoALkH4pyl4ER/1kqAMY9AeAtAEr+BfFfVo9EgDt3hmr/q76WZlaAFiOA+4ZggL45IMkWpgiYPhCdEVkm3giswwjItoXBNvD1PpgIcjUACxA7wFWAXIA5HADTfAUIDQBh/2+9/BWPPfjDq0aA3mZygBYgMaCZeyk0SN4jSBWBLAKmCAGICPDUgKQCxIOMgPhVUPIuwAgAvhVK8ncFcAJgnG8BG8TfAz7g0c81uJIJcLmruVkwoM0IwO4MGKTvkeSKQPo1CeuYmCXA06dMBIA28LUxgKsBn1IB8goAPhW4og0AqwUcDwkA3AE2gH8EFSG+GA2/BpkAVzuaJQGyFqA2WgkB2twIALdIxkWA7ANrBiw4Aixbu4M9EbDHCwBqQM0AWwB2EYATAAfAePEA+NHbANj8L3n4W2AvpkMTBSn/rpZmyQAgQAu/QxQYgO4SZ4pA9At6b2FBiICnT91jwpYAe0gAtgYQAogVIP1GHNMCxvzHC3UA7v2v9fOn6av4X74c8x/o6moRDWgxApC7RJp/9Bng9IFTUQTgTSF5BCzbBlCnA7Z2CQMoAZLTwZEAARXgPtkC5nNA2AaMlRcARfgz9BP+fhGGa/yjK4FlAVo9ArgRgAwgikAU/1ELoIuATW0EEDXgNDkebAR4qKgA9++LLeB4eAAE8r+K+Yfj1wbBUMK/q000wPBntglGW0N4A9wImJxMvyfFR4DVBFAC7IEjgsk4cCLgND4flBwOfQiGWAHyHQH0KuB4FgDjqgBAHeCgtwEM4O+n7y0E1xL+XZUWyQC5B4QRMKiKgGQdIBbgHnlGCB8Upz8nubW3t2dHgCPAKRDgoVaAufv3pRZwvLwA+NFbAJT8Lwr8RQ+upFfCd0gCtHh6wGhckQyw+sDJZCVIioAnCgG2UgFepwIccAK8SzaFQv5iBZiTKwAKgFsBASB3gKH8Nfj9aZB/E6JFMMDXAzKrQXwRmJQiAAqQHRMlBNgyAmQ1IDcgex8gCrAmBMB9YRXQCADngHV3AMX5Xwwf+f+0o6UjFaBVEKBNIUBTdlTs9sTEbaIIhEWAKMBmyt+pAXYEnJyAGtBktwBrDakAcgfAF4BA/vXQNxbU+LdUUgEqQgR4e8A8AoaHJ+/VHukJbwRMWxHACfCMi4CtxIBXUg3IBYgmgk1WCxDvBlrVCUBXAP0cUB0Aofwv1jX6o8Lf1mWaAM4Afw+Y3xw0trAQAR0V+sCJgAh45hHg1SvYBB4c4IkgFOBjk68F8FWA7Fbgu2UFgH8F4Bz4t7R0gRrQUrgHbEqvj5tciA2YrCMC5qkzgnQNePUqMWAvmwQINaCppApwN6wC8FPAHxX8rzQO/8X+OPRb8iagwkZAq6YFiCNg+E4swL1MgGFVBOA2cD4RYDkVgDIgawJ391IBXrsCHEsCrDECzPsrAH4ZeEtzIaQ2AM6Zf/L82zWgRawAsgBdg8M1qnEETDBTQXROMI8AS4D5JTkCzEpgKoBZBjjIBDg+tmtAk/v80/zn+AoQfwitYQHwz/A3NaDNL4B8XLhpYCwRYOHeHeatIFwLJGeCybdkbQHIa2OjdwFxDXgNFoL2kQG0AFEDSAXA/Ly3AoDdANwq4M/6APixQANQDn7IP68BXAQoW4BoOTAO9oV8FkBFgL0tyD0eUBNAjgB4SLgmwGtXgGMnArAAZAWYn/dWAHs7CMWfuBaOWQT+0VMAGsm/q7U1F6ANtYEtUgvgEaBjLDXgDrsxgBbgHhZAbgN3vAIc+wXIJ4H5pQD5/eDCHOCutwLU/o8TwPn+j9sBlsR/wKLt/kGNPzDAEwFtyhagqaWjmggwxi8HOgZMOxHgrQHQgFd7yIB4InhMCPDOCLBGtgBwSzBRAeJbju8yFSBmb36jC4AfCxQAFf8BxL+fGBe7W5EAFbgc7Bqg7QGbOjq6YgEmyb1ho+kxsZJrwN6eHQF+AYgWAO4JJyqA+US4WAFG9AHw44+eDrAY/4GBjH8/Oy72trZiA7rQTLClYA/YURtxBNzhPjLt7g2edJcCltBE0FsDHAFgBYA1oElqAVZlAabNJ2KlCjAyQn0ZjFoEBN//0hcAP/+BjD/ibY+MvzICYA8oJUBbJECXEwBwe+jomBgBeCWooADbpADvOAGSFgCfCnMqgMMfC5AvAoy4FWCYeQvwo6cDLMJ/IOXPo49HX2urbUBrF+4CWrgesFlqAOIxYAcAqAGSAPfwMWGxBjzHBqAmYJsT4F2T3QKs5QGwKgdA/C845a8ASReA5oDDw8w+ACsAFAXAx38g5Y/puwWg2tbqGtCBJwItXA/YzBrQnPDv6J2845wWz/nTBlC3xVARkPN/zkfAwYFlgGkCmqwWYC0XYNUvwMy0ogK4S0HD5QWAjj96+MkGoNre2hoWARUkQLPMv6Pjh8FQAaacM4KkAIZ/iAAmAppwBVhTCZBdDx0lQPYykJoDUAEQ8fcKQAdAIP+B7PEH/LkOsNLa2ipFQJstAGgB2ngBcv4dXewRIefyaHoeYO8LfGYOiKX8cwPqEGAtEWCFOBjurAJEIeCvADedCgD4D9YZACr+/YrR1dpKGsBHAGoBOAMM/2bn5jDYA2pqwBIZAVkFeA4FIJoArwD586+vADMzmgpw064Aw6UHgFj8Nfj7e1sZAcxEwDagzRagWeLf6nxNBKwD6WqAKMBzSgBNEwAEWDEBECqAUAGcABjOBUhawOtiAFxRBICEX8e/r62VNYArAlYLQAhg6n9HdLlkq1UDsACjTg2YJJoAuwZkAjwPFuAk7wKBAA9zAVY0LYC3AtwkBBi2AoC8EUoZAH7+Kvy1CUCl0s4J0EZHQIsrQLPI37k6zhcBIAGYwwH5LGB93TLAK8BJdkAUCLD2MBdgxRKAbAFmfALcJCrAsCXA4HW2AmQBcLXR/PuTh7zNFwHIALsHdARw+Du3R8oCTE3lBtj3RqPTIevrgD/ZBGgFyF4H1fiv1d8C1NATATA8DCvA4I+D/gC4WiAABvoD8PfnGe/pA9GKsNMDWga0AP7N4IgA/TbIaQMT/ulaENgWCAV4mn9NPBXgBV0D9o0BvAA5/7Xo+V/xCTCTC2BPAnMBbhICDFsBMOgPgKtXG82/N9/75esDYRvQRgkArg4i+Ie0gUCAhXvcATFLgBeuAHueGgAEeJhXgBWvANknQqQKcBMKgPmbSaAlABEAV9kAKIt/1RT51oAiQLQA4OagDop/3AYOqgRIK0B6THiRqQFGgESBF04T4BcArAMQL4QtAcD90N4WAJSBzIDhYasCDAoV4IolgD4AAvm38wK4RSDfGdBCC9DsxH9HM3uDMF8DJo0ACx4BAH8ogPmQuNwEgHcBD2kBrL0As7wAeDOYWwGGrQAYHNRUgOAACOPf39GWC9DV6p0J5AaAFqDVOjKOHv+OJuEScTYCJnMDotMkVA3ImsBnSABcA/bg2RB7KShNAFoAvgc0V0QzqwC3WAGGLQEGB6UKoAuA+vn3tkkCEG1AukmcbgEiAVp5/k0tIQJEv7rTjADZ+bBnz56xAuzZArhd4CkWwNkQ4AgQZwD4VJyuBbD4AwHkClAkAAL5V9t0Apg2IDWgwgiA0r+jjbg1alhRA7IE8J4PywR47gqwZwTgasApJYDQAkQKzORLQeoWIA6AjL0yAK56AoDlPxDEv7/iEcC8FuzAUwGmBUD4O1qoc4LD+hoQzwHv8QI8ywTIVgFAE7DnF+AUCbCmEcDcES2uAtxyKsAwGQCDg9o54BVdAQjl3x3f8dvBLQSQL4YTAzo6nGWg2swA8ydeDjQPhdSAXAC7BgD+jABxBdgNSQBBgDkjwJxHgFoPWPt/t+xJ4EgxAWT+hAGB/Pva9AKARrBmQKsRoJXBX2E+JzWsrwHyGeFnhABZDcg/Ig2aAFKAU6kEuBVgzhYALgOlnwmEO8LSFmCEE6DoIkA5/PvTW77zDq+9VTKgAgxoq+QGZCvDHV2e+E9qALMt0IqAAAGgAZkAu5QA3OGwJvUkAAjA9oDuYvCNnw3/wcAKwLwHYgIgef8fWgBqMLuZpUDegA4sQNojgsef2yLWPDSsawKmUQ3wJIBKgAM0DZAEWFEKQLUARoC8AoyMBFeAYgFwsVABgAK0iQKAqQAwIH74u7AAwkGhqiAA2BZUI082AfO2AOvrRBNgC/A64U+fDmxiz4baZ0LcCqARYCRIAE0FkDoAPf9qeyZAe3dqQEdbq96ARIBorxf6yWjzh7RJXKgBY/CL4tPTsAbcy48ImwgA/J0uEBhQjgBzSgHGHQFGBAGYALjmeQ8oBEB/eAGoje7MgDZPBFgGYPqZFs3CHuGmphahCeAFAEcDcATYArx4vqMTwN0TqJgEkALAHtA6FXDT4j+oEuDateItYEAAXDACdBkBAgzosunHAjQ3N8sGDPgFmIxrQN4E4NNhHgF2dpgmgBHgVBbAqgBQAKIHtDcEpPxRAAz7KsA1nwCl8O+vXDAGdGQRcKHNVwRaCOqAf0uzV4BeZmfomC2A2wQQAlgGvNgpQwDiepj7vh7wlrkoGFSAkZERZQvgBgBfAS6VIEDfhQvGgEomQMUfAbwBHWhRmD8pyB4PypvAyawGuAIsFRZgnxXgsWcWqBIAXBRrBBihBRjWVoCrZABcKqUDtAXoTrpAfwTA2SDE38Z9V8weV4fZfWHZbYFMF5gKsMQL8FwW4IC6IsIRQEgAsQccH5/AAozSAgwLLcA1vwCXWAFCOsALF4ABF7ozA9oKGtDR2sx+V0w5EUwFyHcFUl0gvjNcEGCHE+DYI8BKXQIkCZC1ACO0AMOyAN4KQL8HCO0AkQBRF2gE8BYBuwp0VFr4jwrhZaCWFrsGWAKkG4L4LlAvwK71NigS4LioAJpJwDjuAUdGRwn+sA0QA+BKIwOg8wI2oCOLgIoqAjo6vPT5cyItzVITQApwj/mOsEaA11AA+2hQvQLgVQAswAgdAECAMitAgQ4QGhA3AZEBHZoIaM3n/zWc8idlqHNCLQNsBOQLwe40gBPAMoDcFJoJsC0KwMwC5xkB0LHQcacHHGmYACUEQMUWoD0TIKkBHgPazJJ/W4vegHyzQK90TUQugOkCuRIQIMBr4YqIJnEZYH7eOwlI7gnGAoxaAozIFSC0BSD4XywUAJkBXZkB7W3+IgAEaA0QwJwTZlaCrKMhpgvEh8NIAZ5z80AjAHM69LRJehk87xcApEAuwKglwIhSgCwArga2AOj+j5AAyAzowDVAjgDw4r+lRW2A2SxWES4Kwk0AeUCYmgc+9wtwcKAVgLgiTBAAlIF8FjhqCUAvBQkV4GpoC3CxaACkAqQ1oDurAaIB4K1vi2wAfVK46RIfAGQXaJ0QjwX4Fy3Ac06AA/aOkCZ+HWjVEoCYBKA+YDwPACjA8IhfgB/VAjD8CwdAYsCF7syA9jZfEWjVC9BMBUALXAlwXwYqBViWBdgpLsAKcUUYK0A+Exy/hSpADX4+C2QWg6l7AZAAAZPAEP69Fy4QBnRkAnR4I6AN7PptURsAd4p3ySvBzjSgfgGcNwEaAVb9AsA9YY4AIwUEAC1AuAAXCwVAIkAlj4A2XwSAFqBVLUAr3CxSUQkwiQVYID4fKAsAz4bxAqBZAP5qOHghTAswxQowwgswyAug7AEv0gJcLBgAsQEXujIDKj4D7B5QY0AzPioypBZgCgmwWEyAfUGAd5QAzvciOAGm3RagmAB1tQAp/6IBgGtAHgFcEXBbAIUB1mbRqk+ACVqAYgmwHyoAuiuWXwicmbLWgphJwHclQN+FC7QB2Tygu7tdjgCiBfAK0GKdFeslrwrj5oELmQBLS8RCAF4HCEiAY64ExA74BJgmFgPrF+CaIwDTAlwuWgE6L3AG5DWgQ44AWgDRgGZ7t3gXf12oESBLgIVMgKVcgKVGCmAtBnECzIQIMKwTAG4LNz3gFVeAy0UFqF5gBcjbwO4LogFED+hbDHAOi3YoBJicTOaBk5kAS+cjQHxZaCqAsA404wowUZoAaBJw5YrTA14mBNBVACYAIgPypQA5AlqpHlCOgBbntFizIIA5GxYLMOkKkK8EEUvB9lKg/6pIfE9gelvsOQjAfCfImQTgMhAHANEGKAVINgIxBnToIoDsAUUDiNPCA95pQCpA+qkZUoBn9QlwQgmQ/sY6GxYiwM1yBbjiCnCZFiBgI1A9EcC0AIIA1G0B2TTgtizAtCTAM1KA51oB8hsimuybYv0CpJdEkD1AwELgICvA1UABlC2AEAA4Atp5AyqsAC1e/s3O1uDbygS45wrwJFiAA/GKmAABZvJLIngBRv0CgBSwPhSGBWC+DXc5vAL0Xbigi4B8LaBNEqC1RWFAG3ldRIemBExNZgLccwV4QgrwAgqwJwhw4lwRoxMgpk8IMGGtBGP+5CwQlgH3Q2FeAS4XWAXobL+gjIAKKwDbAtACtNDXxbRqBJjEAixCAZ6QAryAAuz5BTgNE2A2E2AWCTDOCjAqCMC+ENYJgKuAToBqe7tsgCIC2iQBWkT+8OVwc50C2MfDszuCsqNh+RUhogCnpABmElCvAKP1CXBVEOByEQG6fQJQEdCm7QEpA1rYCwOu6AW45wqw7BdglxbAPRuaCfCoxv6RRoDZcxLg6pWyBai0B0QA0wdWQgSI9o8zF4ZUPWvBgL8rwLJfgN0iAjzyC5DAdwW45Qower4C6CqAz4CKrwhIPaBtQHx+gLkwyJkHlivAbhEBHvkFSG+JEgW49b0K0K0QwLwVZvpAsQWwvikDrw2xd4j2NlSA3SICPPILAFOAE+CWXoDrwQJcpgXQLQNUEgEqnZ0V1gLwUrCLWg9s0wvQAu8NcfYId1ELAY0U4KAEAeZcAe42SIArfgEuBwrQl/DvTFZ62D6wUywC7XILAAwAN0x3dLgfFeooKsCycEnU/4YAN/wCXG2EAN2Av2AAKALEinBFK0Brh3tyFApQKSjAcikCnCABNkoXYOx7FCCpAHmFV/SBRBvg6wHzrwnAw6Ot1Pck/kkBThoswFh9AlxriADJHCCnK7wX7uTbANgCsAK0NOMD5G3UMYHmRgmw4xfgxBHgsV+A+bn7WgFulSDA1dIF6FYKABcDnP2BSADegA6aPzLgWmME2CkiwGO/ANGPlABT9QgwGCzApeICdLajEtCpWgyw2wDYArACtLL8oQEDxaaBrgDonsidcAE+agSY/74FUKwDpKtAZpanWxHu7hAEoA3A94e0cieF+oMFWCIFoG4I8qwDIAE+agSY1wsw/p0K0KcXAM0E8DEBsLTv3htCPP4dLexJoaoowKQrAPnt4GfrWgEOzMsgKMBHjQDzhACz9LuA8cYLcIkW4KKqAugEQG0AMAC3AJQAlS6ZvzGgKr0MmnQFoD8eva4V4ABcEQUE+EgLgF8HzysESI8GjpcpwFWPAJdDBGi3BZA3B4E2ABwXvWAEaCeuDrIef5J/LkCfdE0c4h8LsFifAAcH4IooI8BHSgB7P8C8QoC76JIQUoCR/JKof0KArAXIF4L4hQDBAKsFsARote+OEk8L9gYJsBAsALooNuF/cGwJ8FEjwDwhwAwSILojIoEvCABSQHVZeJAAEX9ZgN5QAUAj2JUtB6BlIOfiGPvyuDb5tKAgwKQjwEJ9AhygAMgF+KARYFUhwF2/ALAMmCLwo3tFACHAFX8CeA+IdzsC+LaHXQDrQVkG2C0AMKDivziQEoDYFDrRKAG2iwiwqhBgKhVgghcA9QE3bogHhBsiQCUTwKwE+XYHmalAV2YAK0Cbc2u497hoF/O9gAmtAM8CBdgOEmAFXREABJhzBEhSgBZglBbgBinAj/UJcFHTAsAu0COAa0C70wPGBrS6N4e2+S+OYQSYcAXAt0MgAda9NwXnAuD9gLIAZh5ICzALBTB3BExkNaAeAYq9DfIJ0EcK4DOg3TLA7QHjxSHiznDFgeFe56NRo9SG0Ml7C34BngsC7GsFeKgTYNYSAF4SYQswUlAA4W1QwRrQTQhQkQ1ogwYkN4kTPWBbB3FrtOrIeC/mfxveE4q3BHsFeC4IsE8nwHtLgMfhAsxKAowBAUZ5Aa7zAlwtVYBOI0CnUoAL8PKwbvxJqKwFqFCfjFDeGQAEuCMIsOAX4Plz4VUALcB7nQAr/7AAV8MEuKjoAdE0INSALiQARb9LeWK8GQpwJxdgwhFggRbgiVKA17QA7y0BNigB8otCBAFmZkgB8DTAWQ68UWAacIUR4LJKANADmmlAt0YAcIEgNKCdpN+lPC0YG5ALcCcWAAQAIwA6F0gLQF0P404Cjt8nAnwQBTC3RBgB7lsCzCgEGHWbgAICmBjAXeBlnQCgB8RdoMaALtcA5pMhqrNiQICM/53smkCVAMuhAuxbArzXCLAWS4AFuG8JEDkQf+E6UAC8EDDoLwGoDqAIsKpAmACVIAO6fKPS0tISYEAqwJ1MgDGNANQ60HNJgP391/uWAO81AqS3hYgCzCYCTNcngPtCIL0oCE4DBAFUEdANBcBNgF8AlQHsDjGPAHcyAeDtMKUKsG8J8N4I8DFIgHlagBlBgFFWgBvUEWHrlgArAuoRoLOdbQI0BlzwGdDRJu4Q5QXI+RcTYF0W4DUhwHtZgEf5NSGkAPfzD8jP5h+Sn052Bo6Pu0uB1ilxQoBBQYCrdA24bA1NDai0802AxoDkzZCAX9gfyAlQrQlwJxMAfjW48CzQWQmGAqSbgQB/XoA1SYA5JMBsLgC1FJgtB8kCDMoCXK0/AqrttACdagF4A/K3AhoBWtvaWoAAdzIBRkeZFqBsAd4TAnwqIIAZSAB7IcC6JaBRAljbQ70CdBaIgLZKF2UA/Nq014Bks3C2S2Ag538HfTZcswzgEWA3RIBPrABrxQW4RQow4hWAOB9CCsCXAf8kwG0CVALEBlgP/wX+u2KUAenssZL80ZU7YQIolgFsAfaxAIC/EeCTESDrAh9ZETA/v7zMCjDLCHDL0wXmRwNkAVQRYJ8T9QlgTwR1BrR3QAM6iC/NewRowxuFUAAoe8Al6mUw3wMqBPiUCWCmAY9sAVaXfQK404DaMAKMkl3gjRIF8ERAbztTA/LZgcKASkduAEXfHwH58lH8xy13CghA7QZgJwGvMwHSScABIcAnV4BHjgAPav/E+7wAM7IAcCIABYBlIFwAYSrgWwagaoBSgOy8v+rjkrYB5q1x/IetSIDSe0BXgANbgCwAIgFAE+AI8OABTgCuCUDzQCzAqF6AyIChsiPAFsCZBygMABuCdR+XtAQAp8XjPKhoWoBJpwJkAjzTCWCWAQ4cAT5SAmwIAiQrQfelLnACRMCoEAFAALcGDNUnwEXPOhA5D1C8FrQECI2AirVZtAMK4K8AS0v4XeAz7yzwNWoBXAE+uAI8flT7PWAAIUCcApppgCzAsCDAkEqAoAjorLA1oKIVAGwG0Xxa0DkvbG8W72JagElSgCUowBOPANkyoCBA9iIACfD48YYjwIO0B8gEmE8EAHXAEeBumAB2DRhKBbhGrAUWjYBKxV8DfAYAAS60hRvQYR8W7HVaAEEAcEdowp+cBLxAV0TKAnzIFgGMAAl/XAMeZAIsz5vPiOZXBZHzwLt3QRMwFtwFDg0RBmjaQMmAimNAeA0A24Ha2tpCi0DFOS1SZVoASgAUAE+ePPHNAvdIAWAFyF4EAgFS/kiABw8iA4wA4AtS3DTgLhQALQdxAqAaMOQR4Io2ApAFlfojwO4BAyPACYDmAX0LsLgEBHhiBOBagD2FAB9dAWq/sQR4kAqQ1wByKoCmAeP558RrAow5ApgjYrQAQ7QA7rWxNf6XxAhAOVBxDeh2I0A0oJ0QQB8BHe5xsWF9CwAF4APAtACWAG4FOHkP+ccCxPAtAR7YAqzKAtyN8RsBxkgBRkb4JmBoaMgTAexRccmAasU1oBIYAU4PGGJAm3tctE3fAiyGCbDLVIADuBXAFSAfHgHmJQHyLwlH/CduUQKMQAGsJmBIIcAVnQAX+0EvQAkQGgFuD6gvAq3EecEOfQuwuOjwF3rAXa8A4EUwJYAxgBXANiAT4C4UYGKCjABBgCFGgEIRALvBRIAK1wZWNAYQPaA6AogCYGaBwjrwJFsBCAHS64HAsXBGgBMTAJIAtf/LBIi7wFVZgOn8M9KpAOO8AEwNGBoaqjcCGANSASp1RADZAigjAJwcMq+G+3QV4J62BTD8d9keMEiA6J1gHgE1/pIASQRMAQGiRcGJCb8AIAKGRAFQBFzRR8BFXoBOogtgDWjvpAVQGABuDKyYrSEDqgoQ3wwDKwAnwAtagNfEJEASIO8CH2EBHqQnhSUBsu3hd40BCgFyA4YoAegIgCmgMiATQBEBnAGVTqoH1BSBVvLCkBZVBbgHBVgWBHjxgk8AogIUFUDsAgkBxCbAjoChIW0NkAQgq0AuQKVwBHR0dhI9oCYCOsgT4x2qCgCviIb8nxB3RFsCOAFACfCJLQEeAdwmIDkhYtUALMBogQi4Gm4A8V1hRoCQCOjszA1oawuJgA58ZJzqAeUKsLAI+DsCAP4v5AoABfggCuB0gUknKNaAGVIAVANgCGgEKC8CgABFI6DdCFBpCzGgYh8atXpAoQLcgxVgeVmoAC/ICvCaF+CjKMCmHQHpVEAQYBaeEWOaAEcAtwZgC4pGAFEEKt4I8EwFK525Ae0qAVoZ/i1WD8hXgHuUAEIF2PEIwLcAlgCblAAP4jLACTDLCXALG+CpAYOEAGwEhBgABLAioFdZBEQB+AiAV0e0wu1hLd4KYN8P6xNAvB8yFuC9RoDHnABxCuAI4AQYZwWQa4BTB1IBrnkiQGFAhTOgW1kEOjpzAy60qSOgzb4zJjeggwyACXwxEFsBLAEM/x2hArx/z/WAn5p+QdMArQCUAUFNQGIA/oiQGwH598QDisBlrQCVXl0R6OzMDHBbANaANvrgKNwMwF8PfC+oBXCvBZAE+MALYGpA0gUiBRQCTAfXgGFegCH7e9L6ImAZ0MlHgKoItHsEIA1oo28NiQ3o91SAe2EVgDgVzgnwwa0AtABxBOAQ8Asw7RHArQH2Z8TsCDDbw66w24P8BiABChSBSmduQLtWAJZ/i3kVyFUAEwCyAM/9AggVwC/AI0uAVW4pKJkJTqXvBKwacGuMrwHZzaHGAhwB1v5ALgJ8O4S6eQE6NUXACNB54YLOAJ5/zYAufQVYCqgA6IPhOADeCwJ8hgI8dgVYE5oAY0F6TtiNALQ7kPmcOIwBcj3AZ8BleZsoFoCLAP6lUKdXANuACnttUDT6FC0g+kRA4QDYx/zJHrAmANkFJhY8gKsBtgBzUIBZUgDmiAgSYFgQ4M6dYbgiIESA8GKgVxCg4i8C7YZ/5YIqAtDVge774atUAEwoA6CAAGArGNEDIgFADUg1kASACQAPiRkB4q0hY74I4A2Ifm3usJuEoQHSunBfpaIqAowBFSyA34COLnICmC8P+gMgEQC9BtAJ8IoQ4Pi9VAFkAeI3w0wNuH9/FjcC03YT4B4RCBRgOP6lGdYYIL0ZsAVgi0DFJ0A7K0BbK313JPF1wV45APIKsIgDQDMJpPi/fx8iwGO1APdjAeaoc6LglAB7ROC2xoDB5NdmkC0CaHcA+364KgpQ8bUBqAXwRkBbl4d/Sz8OAK4FXAwPgFcFBPjsCLDBCYBqwH1BgPHsKxKpAWOuAbdVAgzdjn9xxobYCHBSgAqB/kpFWQRIA3QCtFE3B1P8K8oWUBBgnRbg1Su5ApDLQLEAVg3YwAZQAsQSzIo14O5dPgKia5FUBiS/PEIbkNwieEleGa54DOiW9ghbPaAYAdbVweTdUb2KOaD5RAhVAdbpSeArJEAeAL4W4IsjwMaGtwakMZBGwBxVA+AOcVuA26kAt70CDCa/PkOiAZ6dgpcvd8oCwDbANaDiCsAZ0GZdG0tuEh/QtIALQgCs0wHwygmAA00L8JslwGONAPMeAcazLaJ0DUjvSB62UsAy4FJ/NRrJvs6+5PcvcQLIBnR7IqBCGcD1gHwRqDj8qe+KUR3ABPeBCEKAdVqAV44ABxoBPpMC1AzYFJqAvBFIa8AcVQOm2AiAl6TbAlyrUe/r6+k2v+g9fdEwP9HdU/uZan+QAX0eAZAB9oFhpwXgDOgg+LsG9CoCAF8JIPLnBcDvgZkW4PNviQBODdjc3GQjAHxRcjZdDyBqABJgzBwUHb1NCjBYe8p7AXczYgH6nJ/u7rE0EFpBQgB2j7BtQDspwAXP499V4Y4JXFIFAFsBrE+EePnLAfCZE2BTEGDVLwDaGWIdFLx92zbgUrWvp5Mf3VYEgGTo7oQW8AZUK14DugkDuB6QEKDduj+unTsm0OFdAyADYBkHwPNyBPhcE+BLiAAPbAHm5qgaMJV/S4o6KAjxX6s99p2+QUcA+Mnevn53QujpAoWzYtiACi3ABSH9uzra2GMC1TICwDoOQghg7wQiBfjMC2AZAARYXXUMsCNgCguQHBRLDRhDAgx1akY3JUAP1qK7r3qJNuASJ4DSgE6iB7QMcD8Zxx4TaLvtXwTkW0D2Tgg2AKAA9ouAmH8mQGzAL4oa4BdgZhrsDkwiAG8OAgaoBEge9h7KCuRFb5VYGU5+7Kn4DagQBrAtgHSHaEU4JtArLgKmnwjjAsC9GM4bAO99AYAE8NeAFUoAXAPM7rC8BiTLeTUBxuwI6FYJ0ENFQCoA9qLPcuBy+mOfQgDaAF6ACwY/NKCjTToncMkTAAtCABD8OQEO1AJ8MQL8omoC4KekqAiAZwSyGpAJ4E4EegIioJs2oNtOhv5L7iC7QNmA9GsCXAuQfFuy0oW+KUQ9/kiALk8AuNfCid8HcPjHAuybAPC1AL8BAawUCIkAIECyMyQVYMo2YDSbDmYC9HXqI6CHbg7dv0VP1RHgYqdGAMoAQYAL6C9PH3/5rFg1iD8KgGfPlBUA8tdUgC9NW7+kY+MXEwOEAGtsDZizd4dZbWAeAXYbYOj19PQEtoFZH9hDCXPZMqC7UtAAtgdESwepARXPSaGKWACIm4EtAVQVAOwEVFUAKMDGLz4BvG3grF0D7AgYgxFQBfwlBeilgN4++udjZS6iWQHdBHgM6MYC4D0C3fbo6vCeFesTA2BhwdMB6FpAKABTAT4xAqBu0DVgbU1bA4QIGEMC9CP+vAHMo84VgeRPgm+NcU2AI4BlQIVcBmp36Xd3myMjbBFoG5aWABYCA+B5UADASeAnVAFqAmwpBFjjBLif1gB/BIy5BlyxBOjpDpgH5HNBxpvuqlkdYpoArwGdjgAk/e6uiuKsWEMDQF8BPhURID4rnNWAlRVNG0hFgFkSxAsBPWYENAGeCIjawVwBpgnwGtCNWoAKSR/jZyMgMACWqABYVwTAvrwM+OkTrgC2AKQBj+LT4nkErNBLAXN0BIznEZCuCQMDepQGcMVejIDo75stEvepBeAMqHR2dWvwswb0Sfz5AMgEeFpPCwgqgB0AwQKsWAKkn5WfcyJg2okA+FbAmgb0yArw/b4YAVkrcOUK1wRQBrR3Owp0s6OrojwvSgTAZEAAPF0PbgHf+wIgF6BmwJZCgKQGrK0QEXAfloEkAqaRANEe8fFbTgSgeaBgQA/3oPMRkP1t0jrQGSBAe7d2dFYuaA8L1hcAT70B8Dr9QMDBQVgFSATYcgXgIoASAHxXGBwTwhEQ/R96MYjmgfFOD74X7OEedDYCgBdxCPSEREB7pw5/+wXtWbHW9mENfy4AnvIBkArw+nVIBbAF2IJlwCPAg0wAtEXcFmDWFiCxwETAWCzARfzMsiHACsBFQC/8H0SdAF8DSAMqfvwV/x5hJwDGQgtAIsBTOwCcCvD6dXYvmD4AsAC6GkBGQCIBPig2a0VAWgicCOjkDOhWTQPYCLDmB32XLncGCeAzAKwLqgTouKMMAIG/EADueWB1BeAFiA2A58QerJECgPUAc1Bsdta+QNSOgFiA0W7WgB6dAJ190qui/G/Sc7k7LAKkRsB6LaAxoFqsAMQCPPUGAHEgHLWAH07gN2JsAV4KNQCeEslvEK5NBMBSwLwrgNkdNJ0YYHpBHAGjo85GD8YAnwA99BoRMKCvEmpAp4a+ToAuib8nAJ5SAYAESCcAMX9xEeATUQFyAaga4B4TciLA1AHSACBAHgG5AbXfVDsFA7o1AjA1oMddJAoVgDDApa8yoO2KzV8fAM+e6joAoQU8kQKAEOAX99o4JABsA601YfhiEETAlBsBY8kXRfqJ7b5UCLCvfbgaQLwsDI+ATgy/3fd9Wc6AXnsfeAH+/gCQFgE+fAD8bQFehgiAIwC1gtbuoAUYAVNuBMS/GSZn8G4IeAVgXxX1aASoMAJ0mtdCqi8M0wJUbo/6Pw5o3wudfR+uWAdgVYAPH9gKYATY8grg1AD3tdDs/awQLCQCJLtDpqbQNnHwXqjHY0CPVwBuKcApAqECJJtBkqVA7TemSQOqNn91ADxTBMDr194K8OEDXwEoAbw1ABmAIiBfE47+k4wAZBGIDSALu1sGBAG4oyNuEQg0AO4GKiJAZkB3HfzlANgBDYAQAAR/LABVA34pFAHJ/0/5MxEQF4H85XCVeYtjKeAXoMf/sjBQgE4sQNEIaL8u8K87APb8AfDhg1QBgACwBsAt4o82N7OzgrANXMkcMCuCyUuBmgCLi8gAJwLM9oCL3DYwbID0zqfH86qoaATA7WDtxQ2o1sHfGwD5raDoVsADij9TAUgBxK0haQSsrDhbhPMIWEwFWGAiAOwQYreGIwN6/AL0sdlgkqMSZEA5AnSH8QcCPPMHAH0rID4PQvK3BHjpE8CNgJUVUwZgFxBFQPS580WpCMAtYvy7XJt/n7hnVHhV1FtIgIojQBEDKoP46/B0AyAUAGkKYK4FZitAzl8jAN4aJEdA+m1pKgIWjQBMHwgNqHYqDJBf+/ObQ+0iEGKA1QP6DKD7wLaqwF9dAMgAMCcBhABw+dsV4EvTliYCHtn7A9fYCFjMhi8CEgMuiycCAgTo4cNBJ0BF7gELRUBvGH96CYAMAMifDQDDnw2Ar3ECUAKwp0QSAbgIWEQCKCKgW2FAUQGyCCjSBbgVINyAjmENf3IXgCcAEv6eAAD8OQG+IgGcCEg0sCPgkRHAiYDFxUUuAhgD5ONBBj++OUQ1DQisARX8Prh+AS5cKpn/c8NfEQAc/8+QfyrAS0mADdwGPnrER8CiLQBfBLKvylRVZ0PjZo7ZMioFRMhagCVANyFAmAFVgb9QAJ484TvAF5C/HACQPxMAX20BnDaQiIBocBGwtMQY4EZA/l2hq0r83se80xMByQZPrQGdZkcwEiPAgN56+EsB8EoMACCAwx+3gF9lAXAN2HwEHGAiYIkVIDFg2kRA/Jvaf/nCxFiPln5MMnRvcLYWkO3w1RaB+gXouI35KwuAnj8dAO/DAiATgKwBugjI9wbE/xnRfw9jQLoomH5pfnx8If4PXqp208W/jx49+rcBEfIeJIA+AsChANwcag2oXCvMHxYAtwN8VW8AsAK8LBQBK9negBrLNAKWyD4wXxbODoyk/83D8YOdd3jdPQR7+DNuL+gIAF7jZzXAbPJXGVDrAXMD2tUGwAawfyyI/7/wQTB1AQgOAKsCfIuXgl+mvyGWAn6BM8ENNwJW1tL9YcuJAJECZATAFwOJAYup9H2+0YMDobeHFYDYw9UXFAEVUwE6wwUABlQbwL9oAEgV4FuWAFkMSBEAbhHNImBtJesElhMD5mUDktlAYsBkGgFVmX5PdjEgGwIYsTVwDehRRkAnSIz2Agb0afmTH4d+2pgAIFpAS4CX4kww2iRoRUDqQPRp0aSgR60A1QfmFkxFn5rPeoGZ+D/8mpe+0xKanzcPuSwAeLWoiYD48S8uQK/An28AnigDYK/EAHAE4CMg3iVqRUBSB1biLwxH/wnxbICIgNr/3UMGZNOByYXaX6ug7/SFPU7KKwVQ9YHJsYDEAPdFsdeArtEw/v8K4q8IgBN/AAQKsLGZ7hPGEZAa8CAVIJsN2Abcg4UAFIFkSWCySrAnl/ZxCHgEsF4lwf0lXgOMAN2EAD4DOobr5s8UgFfUFNANgBN9AFgCvGRngtlGcSoC0ivElrMFAVsA3ApMOQb0a26JiNMezQ96GAF6rBEYARXTAnQWEqByjV//ofgvWRfC8wHwShcAJyfKOeA3SoAtXgAcAVkCrKE75IgIyHMgukbQbgOiMea5Lw491m4I5G1eDz0sATQR0El+WlxnQOVS+fyfW/zFADjRBsA3QoCACLD4ZwqkEbCIFwWTIjA7QxvQ5ydv1/R0QkhVeZ8ACgPySQD6qKzKgPYBLf9Flr+6AFABcKINgG+MAIERgD8xTRUB0wxmR8ftInClW0GeMqCPJkwJEBABlQq4HSJQgMrFQP66BoAvACEB8Nnl7wggR8AGjIBHpABEEcAGUG1Aj4Y8Uwa8AoRHAP09SY0BlYE6+AcWgH3yNeDJyYeQAKAEsCPgFzcCsg/Mrj11DVimi4BtACoC1U7tpRzooU7BFhFANKCzqADK53+hAP9iHSC/EeAbJ4AbAfjQePJFkTQCnloCSEUgNmCWNuDnHiX5bPRSywZqAXr0AnAnR9sbxr9gASgYAKQAW5IAm+DlYPSviz4x7RSB+04E0Ab0acnblV3Bn0oI2QDyY5J+A3D/P+nnv1SEf7kB8K1pu0AEpAKsr8cGPLAvFM+KwJLYCCIDrvSoyTMGNEaAzgABOq/w/BcK8xcLAN0BhgQALYAvAhID1lMB3Bvl57PtARn6JbYRjAyYnsYR0KMcYQLoDehUCeB8Zn5IFf8Mf6EB0HSA7/0BQPOvCRAcAUkReLS5LhuQvhu+n/wHi1OBmgH9IeQpAwIFkHYGKAXABnSPqOLf2QJG8NcXAPNxKG8A/JYL8FUhgGRAFgGxAJEB5sAQLALp9oDk+c+zwGoDgAE9RUbxGtCjE6CiFaCXf/yt8h/EX1cA3vsDgOP/n5oABSNgM48A4rMi8+n2gHg6uGRHADQg+dTg9HS1gQaQf543QNUDYgP6zok/WQAwfzIAfmME+A8nAGPALy8sATY3aQMeZALE8JeIIpAakKwL1gwYrxO/pAD5Z/kioKwARoD2Ko+/Efxf2/yPqUXgjyz/r4Z/LIA6Amq/eZHvDokM2AQCQAMePFjODJhfkgzIXhDXDIgjoK84fcEA+k9yAnSqBUgNqPRz736d8l+cP1sA3vsKwKeYPxMArABbL38hx4sNaMDmJhUB8UgNyLtB2oBpY8At/5KeTJ//HzN/ijEgQIDYgO5B1eOv489sAkP8UQF4zxWAjyx/GACJAIQBtf+z2W9lBmxuugas0QYsmwkhagQpA6o9moZOos/9T7k/QwvQrewB008L9vH4S+ZPBcB7fwD8lgvw1Q0AToCXlABbiQCblAC0AauxAVYE5AbEV8klGkQGjGjinEbu+R/yAnTW0wLEe4eqE6rHH0z/HP7PyuP/QcEfBUAqgMqAtDF4sckaYAsQbxbmikBymWA0I8gMqAqPtO+JFw1gjaIMCKkA7Z2XdI9/nfy5AvDeug2OLQC/xelPBIAoAG3ADmOAGwGrZl2YMyC5XDo1YKIvdCgnhHykeATwlYDeERY/F///CuIvB8B7fwFw+eMAyAQIKgKbQhFY0xqwuGgZMH33bn9PUfxyGaj9RLXKCNApLQNVtPHvffwbwV8oAB/RDFAIAFkAvgjscAasKQ2IfuMa0Odr8cQWgf3T1WjQTYVrAOwBRQO6r+ke/5L5kwWACQA//1yAsAio/buRBjidwCpuAxbxAWLbgKmLijY/uSkg6O2QIIBTBFAFkAzoU+KH5f9f9vsfDX9FA8AEQMZfJUBIHxj/2xECJNuEHuQfGs0igJoK0Ab0eed6Bd4P9kkC2AYoBei8GP7418G/UAH4rAiAQAGgAZuSAXkQBBowyBPtLfxyQBagWxaANqBvTP/40+1/mfzpAkDxlwTwGrAFZgKUAevr+Zdm12wDUBuQvCJcIg0o9k5IDgFZACsCcAvA3CLbz+L3Pf56/qENgC3AZ1UAWAJsCwIkb4jYIhC/G8y/NOo1IN8uYhlwt698AzwCYAMcASps8z8Z8vi7/J+G8t+vm/9Xhz8UYPslmQKGvxwBuQBZCqzxU4GlpSXOgCs9PWUrkAgg/A86hQrgGNA7qMRfNv+gAmD44wD4KglA1wHDP8iAB/jQ2LLKgJkyioBjQNUnADDAJ0Ca/pNh+K3yr+avbwAsAT4zAeDwhwIcCgZs2QKEGLAaZMCtvp6SFfBUANQIUgIYAypJ8zc5WdfjX5R/0QJgAuCrJMDh4SHTCub8PRGgMGDJbBEABuAyUEIRwAb4BejpJNcBLQMqvUMcffHxp9u/QP6wATgW3gEIAUDxNwIcpgJQEbC1pTMg2iL0SDIguUVm3mNAtWQDFAL0dHsFqHRf4uhTzZ8d/6Xwr68AfJUEODw85COAFIA0AF8r7BgQ7RExScAaUEYRAApoBHAN6MQHhrv7WfqT94THvxz+QQ0A0wGS/DMBDo0AYQZsuoM1IN4jsrrsNWBmuKdMA6oqAfo78TzQWh6q8vTv3fM//nb7Xx5/dQEwk0BCgMPDQ20EOEXghWAAmgqYLQIeAxYW+ks0oKoToJr3AZ3ObXKd1QkB/z0ef3n86QZQUQA8AZAIcHjoNwBdJwuLwIsXnADYADMn9BgQvS2u9pSlQDUTwPcagd0k7MF/z4/fevun5m9PALZLLwCJAIeWANCA/f2X5hrJMgxY5Q1YTPlHBvSViz8WoK+IAN0e/CXz3yH4Zw2gnr+2A0wEODy0DTBLwvupAKgQWEXgRWIA7AcCDJi3DEj3C5SwGgDxV/3vEslLA7r7ZfqQP4ffPv5ZIn9vA+ANgJoAh64AeQhs71MGGAG2QATseA1YI6vAPCoD+XvCwTLxVzVvk10Dui966AP+Fn6H/zOL/3Nt/rP8CxUAW4A/mg4PSQMS/tvYADsCar+bGWDPCfFU4FHyihj3AcuoCiwt4numFy83AL9ogPVFic6+qz78Cwr8BfiTE4AA/gEF4A9CAGPAti2AbcBWbkD6X8AYEP3wAG4Xy8uAZQA8Ur7YD3EqD4wQ9Kt9PbotJeibIt3VMfXDL+FfJvE3gn+RAvCHKEDSDezvw6aQMyCmzxkQbRWzNgzSBqCO0BjQp+vjzf5PjF97lYD5qkxn30VN6b9n6HP4y+KvXAHgC8BXhj8lwCF6PbiPpgVAgC1YBAgD0EeHzb2CggHmwvl0VJEAXgn6HPpV8twAfXIA3FY5POnhH+O/R+J3+T+T4t87/2MngLoCIAXAHyoBrHlhbkDqgdKAR7wBoBXMDFjCBtjPNLMlvOqMPvZIEfHTRoC+Se+8P/3Rg3/Z+/gX5a9pAHwF4A9WAJUB0IMyDFiiDLhXNbt6XbxoqZf40wEnCpEA/Z5V3zQFXPoW/mXq8Q/nX6QBVBSAPwQBihtAtwEaAxL2y3YZqBJdnWbwRwS9AvRMSK/8sibAj38ZPf5U/JfL39cAfKP41y9A/QbEjUB+oYQdAlWysw+n742AHrECLCD6buOvw99w/rgAKPjTAhwdhRrATQViBTb9BjxZzm+UYAzQOsAeDfSOTIDLMvx71mEPEX+D+FMHgd0C8JUvAH+IAhwdyQZYbwe36jNgNfnlMgbYCvSLfb7dFRQgjyOgh97pgSb/Hvqqx/+c+X+j+VMCHKUC2JWgmAEbm5IBSQjEk+VlIgQSBS73+Vp+e3LXV2T04AqAN3nAlR8tftz8cfxfBfJnLgKw+X/V8ScEOErGttMLuAKkP9ZrQPqyBBmAQmBQruk9dZLHAvQvEOMeddKPx+9//BvBHzUAX/kC8IcowFE23GbQNiA3IdAAfM/8ar5ZliwDsQJjfcrdP3UL0NMzscAPcdHP/fQf//jT/F+T/A/C+HsD4A9RgKMjtQHGhF8IA2IFdiQDUgWePbENcEJgCbSCDSAPBKj9/bTwefxPcvzc40+e//tH+NsCHB3JBsA3Q6AYEJPByIAsCSQDnj595iqAQ2A5kuBSX8PIww+U9lRZ+F76+Yv/p97H/4Uc/+fH3xLgyCPANno3+HLLMmCHGKQB5t1Q9Ov0jAkBvDg02tco8rkA0d/9suLRJ+mbfX8e/HXz/0BfBs83AN94/liAoyOfAViAl2wbQBvgtoLJL5VgwPJSvki0WO1r6Ej0IvgvsfTdbT9Pnvjw+/nv8/xPPPx/C+WPBDg6CjbgZX0GJHcNe0Mg+8PBxgvQJ9NfXhYf/if21I98/OH9nzb//XPmDwU4ogUozYBNy4DoizPrmQLP+F4QKLDYf24CLCrrPnHmr47HPz8ARM7/QvnbAvwhCnB0dKSJAL8BhAW0AevJrxVhwBMrYo0Cww0WoB9/5ERf+d1NvzR+Vfkvzv9LIP+/mkT+tAH05cJb4AzpjjsjSA0AreDmJjKADAFTbXMFLjVUgMEw/hj/Mxm/L/4L8/9cnH8uwNGR3gBrQcCeDGYSeAyIzxKmv2JMCEARcgQNqwNJD8jQ55b8IP5nYvHnHv+6+Ac0ADT/TIAjUYCyDIDTwew8MR8CdhgYBaarjRKgjyDPvu6z8D8z9As+/uz0rzj/bx7+qQBHR0dhEbAtTQa9Bmxm/HUGUAr0N0iApSUNfvyvl/JX4Wf5S+1/A/knAhwdyQaAt8OH7F0yW+7gDYBHylEZ0CqwfK+/EasA1cBn3/AvhN+J/3PnHwtwpBj4GpG6DNi0DdCEwBOnHVxeulItl340CdCXfcRfoq94/K3yf478IwGOjtQGoIaguAH2IEKg9kP0aysrsDzRXyb92riimvBZ/NeL4W88/29+/jUBjvQCHG6LArzcAqfIww2AIZD9yCuQxcBQfTFQvYbeMN1xucf/pCcsfTV+nn9e/veL8rcECOD/V9PRkdoAe8voS/JLM6IBO/YpUqsMZAo8NQYwCgBCwwUdqPbfXlq+jQRYstYeItGeqOjz+MmdH+7jTx3/aTz/AAGyKaFowEu/ATv0zTJWCPgUwGtFSxOXq+Hw4xjBd5JB8ta3XcXO77kPf0P4f66ff5gApRiwwxmAQ2AdKuC0g+5y4dLy5OVqVcd+aNIQRrfR9DGHO0n6hv/z5570t3Z+wJN/GL/L/0Nj+QcK0FADUAisg3LgKMAsGUfgFob6+zkNqtX+q7eXlvFTjgXwd37PzAjGLzz++2Xz/6bj/1fTsY78m9IN4EIgRb+uVeCJ07FFY3p0eOjq5YuXo3FpaHhsgZvZVUUBePoe/ir8+3L8nwf/v5u2dfyBANsaAxgFdr0hEP+iJrfPw57wmdqBZYKysLqHBKjy9J/ZQ+APa7+d/nz1Z8p/Q/n/9XuTkv8bLgJKNiD9IvHm5qMwBbADT5g398QqT58rgBT7ivKP8e/4H//9f45/rQRsK/nzBnAOKAygFTAfIaEUiJeIUjCMA8wrZfLxxgIo0Hum/hb+Hb7448ff0/43ir+qCXzzphQDdnd1vaCsQPp7GR0qB/hkIOIdCdAfAp/b8AXx7zDpv++JfzV/cAKsEP+/m96r+UsGbPMG7KUC7EYjMARcBczIAT1RjH/9i2vuOAH89InDXjb+Hbb4e/l/KM7/m57/X/9pOtDzL2hAMvZ2CxkgKfD0WYgD0IQnrADPuLEuwyfx79D495Xxfw78ayXgLIB/HQbUfglYA8pQ4BlRvZ9Ii7jZQAJcVLFX0o/47+3x1d8X/+fC/++ms+MA/m+sBaH4FdGRwoD4FwEYEBQCuQKblAXPSAme8WrgpxwJcNnPnm38HPw7xR7/c+UfCRDC3zLgKDLAbBYQ+oA9YIAQAjuiAukk0X1tZIBlDSLxHDPVHQlwSSQf8vBD/hR+9vFn7v9qEP+/zprO3oTwR0Ug+gFtF+EmA7VfhJd7dgjsuhMCKQtq0PN1gmzznRMERCr4hi3AujCe6+nv0Ls+wh//xvL/+0wsAW/eSAYQG4ZoA/bA4MuAtxykK0Tm80R2X1CEvyVACPyUPof/VQH8583/rz9qApyF8X/zRtoypjVgVzAgTAGpK1gvRwD+VS9Nf8f+5DOT/v88f1mAN28aYgARAs4S0WYRB/If7TquF+CyBn0OX6Af8/fgV8Q/u/+jJP6JAMeB/Isb8JIJgd0AA4gv1SUS4B+pPi77Kb8Az/khwodv/l7L6f9d8I97AEaAN29KMWDfVwbqViB1AMoQMiwBnj9XwPfRr/Gn8Rfk/9ne/1UW/7/OIgFeBfNPDHA0OHQNACdJuTKwmxlQXIFNUxfqE6BfgX9npwz8B378PH/q/U8iQCD/P2MBqAh488ZrABEEjgHocwN0GchNcA0IUaAof70A2of/FdP6I/zfB/9MgDfh/JlSYBlgf3CCCAHUD9StAOjeCglQLcb/FRwa/PTO73PnnwlwWID/27eSAfkXZxID+DKAG4JdSoEADSJQqImzGnpqhlfVCeCZ84fhP/A//ufCv9YDxgKcFeHvNwDcKMGVARQFTAjooyBmTMAT+3qdAC/Y5X6M33rln+N38v8Y4uf5Y/xl86/1gJQASv6MAflkAN0pwpQBanGIVcDnwfNCQyXAC+5tH6aPT/swT7/L38X/UdH+l8D/j0yA40L8PQbgW2WYEAhSQI6C5yUI0MfTt/89av+WDv49f/jH/I/l6n9e/KMKkAhwVoy/ZAD2gGwE4t95bbWEuBXY3VI7UJD/835eAH7WH/+r2vQz/uDhd8I/4n/sqf7nxh8IcFyMP2fA4fbxsZUEbhmIf3xZ+7XiFYh+IE8VAPA79fF/ftkR4IW83pP9e9r0U/4Y/4EGP81fLP+l8P/9LBfgpCB/zoDj48gAMQTydcLcAEeBdAh3zyVThB3APwanAZ9BHkICyGs9cOLK05fwe5s/XftX5/ofCIBUgLOi/GkDjpMhGIA+TU2GwA6YIjKnizY3wR84aHX8X9xBh0N3NOwz/nvUhq99Hn/A4y/Hfzn8YQKka0EF+KcGvCH4y2UAKkDWgWSSuCs7gAfB18f/xYJKAEx/b4+hLzz8Ovwo/hvM/+8/gQDvC/N3DTg5lgxwFXhJ1oH0VzpQASgBOJ/3guX/4jkS4KmXvzWDfa18+G38AY9/o/jHFSAT4Kw4f9uAk+OTE2AAGwL5ivE+pQD4ESmgcQBIYP8ZIhKQAGMi/72i9HX46ce/YfyxACfF+WMDTuIhhoD5MjFdB7IlQlcBGAM+Fyj+1EACDHH89yT4OX0Ffl/6U/HfGP5YgFd18IcGnJx4DYDLhFYdeE2vEVIxsKXOA8/ABwMI/Hsy/Lj5F+gz+GX+7ONfHv+/zpAAZ/XwNwbk/JEBxOKgfZ7ErgOWA04MbOUHzkoVoOoGv49+/oFfmr6NP+jxbyD/NACMAMf18M8UODmhDDjWGAAUsDUwHBwH0N6iYgO/DHDmeyr+B3XiFx7/hvH/ryXAWX38YwNOT09PwFAaYCsQr6bIlSD6PcCfdEBhRfw/xC8DCvDn8R/73/r7Hv+G8f/9zBbgbX38awacngoGZDdN+hWo5WmqAPBgF8UAvatkl+rcffx3+yUBvA//a13pNwd+Wfz24+/Gf6Hz3wz/rAIAAc7q5P/23allgFsG6IunnRBIFXiNo8BxIFmN2yUl2N3l3cB/Cb4pMoS9wP+9jf891/vpH/+G8IcCvK+T/zvCABwCR/mBUl6B7VyBTANSgT3zNsYJghruXWFYikxiAaSpvrb1c+i/f6/Df378fycEOKuXv2sAKgPH+YEypQLxcBwwv4/ex7jJvSsO83dEAizs8Sv8mpf91MPvxa95/MvlTybAWd38yRDABrCbRlwFXtIKoIHfyZDp7eG/t4dXgiz+8N9BsexD0Wfxi9X/nPgjAc7q568oA5IBkgKvUyp2RmMHcEawIsA/gTeG5/QJ8hA+wb9Gn334Bfxc91f0/m8N///QAryvnz9bBlIPlArES4ZEJchUeI1j2pYgaOCVIG6hB7OndvoS9DP+HwX8n5jHv5H8TQBgAc5K4J8ZYJWBXASvAWZDsauAeSLTLDCM9gpLgBcC+AdeoP+epp/yF/F/Yh7/hvIPECCcPxkCpyALOAWIGeI+qgRWPSYmZ4Uc6CcE2JfGgZJ+wl/G/4l5/M+LvyXAWSn8XQNO30ADSlPALdF8u+g09/kfo01hPfv7IfDprk/m/8niT+EXrv8ugf+fvADvSuFvl4Ha77051YTANrVMxDpAt2mEBejnX9sJgvcE7e1zz//Bgf7R/675Z68BKAHOyuGPDTjFOlAhYFYI1QpQkUBr8FoeeB64RPAnZ/vvRfgc/08WfxJ/g/nDCuAI8L4c/rAMnJpBhkB00xi8dZBaLd7f3/Y4sP+68MALAa9l8snwwX9vX/VF0K/x/y308S+F/5+SAGdl8c9DIEWP2wJLAesLpcILA0+JLqQBXgiQuLOX+/iueqPwf/ot+PEvhf9fZ6IAZ2XxTxWwRGDqgP2igFFge181hFc31MALAQcHdfKvwSf4fxIe/3zlT7z8uyT+f595BPhQGv+IPawGvhA4OkSfqJQEiDkEW8D8ldVAATzP/gnx/H/S8Pc9/uXw9wpwdloaf7oaWAq84b9SSk4PUYEOSgTuT19Cn46sg38+7eXueqK6Pw/+BvOnBDgonb8dArAOnEgHjFPy9sXUOfkD8HteDVhhXqCjIRnn9B+kbv7Ashd90y85+WPSn3j8S+L/h1+As5Py+bMhEP1GqcDxNuVAwjXlo+RvYwU1oN/6hwD20VDQj/h/9OD/DPHrHv+S+P91phDgrEz+v/76q6BA+iN585yV/zGAbcwnA4poQeSKGV30V+VtYN+Byx+8zxa6PjM+evF/lvFTj39J/J0KQAtwUCp/xoB8iSBTgLto4OhQcuAgOWliP7MYuW9ml/WB/Yj/MRr8hC+Qfsr/iy/9z4U/LcDZ+1L5swqgMKAVyGaIKfhj14HtA3uqQBAW/2Q0dq5Uq1e28n+CAr0L30Mf7fti8ZOPf1n8fz9TCnD2rlz+tAHmD3MDuLvrAXfHAccIF/S2fwSAd4q+TV/E/1mV/g3hTwQAJ8DZabn8HQVOYv5aBXImCJZFbpvVoAB/3zofhv/BR5/C/0WLv5H8WQF+LZt/bsC7/Pl/5ypAO4DQbOMgOKb+pAO3LP4nLvwT34qvhf9LNhD+b/8Qf1aAszdl87dCINeBVyD70clmPrUpCzx/WsufYn/ie92H6CP8aOPnt288/vL4/zdIgLPy+cMQoBcJkALZgVMJ8jE/tv1/CTdUNf/E964/AP8359RXA/j/fhYmwFn5/IEC5vlnFUgHOlpgIfazLIe/Br6XPoM/5v+t8fz/PgsV4KAB/BUKpP0gOnAcrxkfn9PwrfN9pEdx/N/4x79E/v8NFuBsuxH8HQOI1eJkiShW4IQ7ZlT+SP8Z0juej/zg6bvZ/4W67q/B/JkAEAVwVwPK4C85YK0QvX1rHTBogAP235/b3vNRHhJ9G/8XLf5z4C8LcNYg/rkCvzIKZL/zwT1kkjtQjgt+/l72xEbPz+6ar8vfi/88+HsEOGsU/0QBMgzMFPE0PlZBKZCdNDkpj79d/6lXe2H0yYc/5+/Hfy78fQKcNYy/oif4mJ2rIx2gisJJOTHAvNoNSX6OPoO/wfzrEOBVw/nD5QHMPxrp3gq7FJwyVQH+QTHiev6fZPp14i+T/7ez4gKcHb5pOH9agWxbTYbAOmkihoKnbdTzD2/5vfR1+Mvk/5+zegRIpwKN5U8UguThxwTckwYnIUPPnz3SLU/3Jfrcw0/jP6f8VwkQvxdqOH9bgeTJdyHEcwR6e1ngsHclfEBDx16b/KH4y+T/11m9Apx9OBf+sQK/wvr/kU5gcmsJBTeIf0Cvx6/2ifS14X+ez79OgLNP58PfJIFv5vVOluDUHxE6/p98A13u80XG/1WL/zz56wQ4+3iO/Gvjo2Ywm8wIuH5FTgvRhxt8v3zx4f+qxX+u/JUCnP37PPnXfmVTBDQVjwT85kP0lzgzzgL8PfAF/v85F/6/n5UlgKIKlMk/wYxhIy62A/ZOI2kPakn8xarvi///fCfPv16As7fnzN8MQOVXWoKPxNtl6h0Tt+IYyj8t/F+8I7j6l8r/z7MyBfAY0Dj+kLVpEBwHPmb/Hu9CR9CTn/X8//63Gr967vcPPP8hApz99zz4135tWQWSH02TSEWE7/2C+6/6STsM+2h8+eJxgKP/HdX/QAHOzn49D/6fOQeMDK4Dn+Afiu+ZCvA3c/1/g1Hs4f/Onv9AAc4+nA9/rwKf8mIg/DXkKmMAf7jG929rFKZ/Xvy/nTVEAHoy0AD+fgUSCRTPb3DH8Vki76v97KrP9/n8BwtAZUBj+KscCBt6/v8mh7rp/6f5/x4ANFSAs/cfz40/cKABOtTGv5Xjy5cvIfD/8ef/rJECnJ2dJ/+Ue2MioRTwAfS/R/5FBDg7OU/+5dUF++9SJ/RQ+OfF/79nDRfg7P358o9WXOt3wP67lkH/awD98+H/eyjLQgKcnZ2eM3/Hgc823PPm/zUM/vfKv6gAZ1/Onb/ggBQNzN+1Hv5fv4bTPx/+BUAWFSDqBc+dPyOBokvw82/go39e/L+dnasAZ7/9I/xdB+w/JjQo8fkvwP6c+BejWIcAZ2cf/xn+WAJSCiyCn//nz6H8vwWNhvP/qyD/+gQ4++f459ClbGC6yIL8i6E/H/6/F0ZYnwAlKFAHf2840H+XL8VGQfbnwr8OgPUKUK8CDeBveVAK/8LP/jnw/6sufPULcLbwffJnRh0rPd8n/w9n/7QA0V6h/6/4f6XH98j/z//Wy64UAaLF4f9d/l9143vkXwK5kgQ4Ozv4/5j/t+KjkfxL4VaaAPHpke+Mf4q4OP9v9Y6G8f/975KglSnA2dnHT98hf8zaR/9bmaNB/EujX7oAZ2evvnP+jcR9Xvz/WyawsgWI3hL9H//G8f/z75JpNUCA6D3Rp//jXzr/3//+/c/yUTVGgGhtQNqQ/X/8g/n//XdjODVMgGSV+NP/8a+f/59//t04Rg0VIF4f+OhY8H/8lfz/rP2Zbw3m03AB0snBl5oFn+P//3/8Ffz/aFzmW+P/AW8rHDdKZjWKAAAAAElFTkSuQmCC";
const png = (b64) => Buffer.from(b64, "base64");
app.get("/icon-192.png", (_, res) => { res.type("png").set("Cache-Control", "public, max-age=604800").send(png(ICON192)); });
app.get("/icon-512.png", (_, res) => { res.type("png").set("Cache-Control", "public, max-age=604800").send(png(ICON512)); });
app.get("/manifest.webmanifest", (_, res) => res.type("application/manifest+json").json({
  name: "Мята — админ",
  short_name: "Мята",
  description: "Учёт табака и смен кальянной",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#EDF7F3",
  theme_color: "#EDF7F3",
  lang: "ru",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
}));
app.get("/sw.js", (_, res) => {
  res.type("application/javascript").set("Cache-Control", "no-cache").send(
    `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.startsWith("/api")) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});`);
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

  const pendCount = (s) => (s.requests || []).filter((r) => r.status === "new").length;
  const menuOf = (s) => {
    const n = pendCount(s);
    return new Keyboard()
      .text("📊 Дэшборд").text("💰 Касса").row()
      .text("🗓 График").text("👥 Смены").row()
      .text("📦 Склад").text("📄 Поставка из файла").row()
      .text(n ? `✍️ Запросы на смену (${n})` : "✍️ Запросы на смену").text("👤 Сотрудники").resized();
  };
  const staffMenu = new Keyboard().text("🗓 Мои смены").text("✍️ Выбрать смену").resized();
  const adminsOf = (s) => new Set(adminIds.concat(Object.entries(s.people || {}).filter(([, x]) => x.role === "admin").map(([id]) => id)));
  const reqText = (r) => `✍️ ${r.type === "drop" ? "Просит снять смену" : "Заявка на смену"} · ${r.name}\n` +
    r.items.map((i) => `${ruDay(i.day)} · ${KIND_LABEL[i.kind]}`).join("\n");
  const reqKb = (id) => new InlineKeyboard().text("✅ Подтвердить", `req:ok:${id}`).text("✖️ Отклонить", `req:no:${id}`);
  const sendRequest = async (ctx, req) => {
    const s = await mutate((s) => { s.requests.push(req); });
    for (const aid of adminsOf(s)) {
      ctx.api.sendMessage(aid, reqText(req), { reply_markup: reqKb(req.id) }).catch(() => {});
      ctx.api.sendMessage(aid, `Запросов без ответа: ${pendCount(s)}`, { reply_markup: menuOf(s) }).catch(() => {});
    }
  };

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
  const myDaysKb = () => {
    const kb = new InlineKeyboard();
    for (let i = 0; i < 14; i++) {
      const d = isoAt(i);
      kb.text(i === 0 ? `Сегодня · ${ruShort(d)}` : i === 1 ? `Завтра · ${ruShort(d)}` : ruDay(d), `my:d:${d}`);
      if (i % 2 === 1) kb.row();
    }
    return kb;
  };
  const myShiftsText = (st, empId) => {
    const mine = Object.entries(st.roster).filter(([, v]) => v === empId)
      .map(([k]) => k.split("|")).filter(([d]) => d >= iso(Date.now())).sort();
    const pend = (st.requests || []).filter((r) => r.empId === empId && r.status === "new");
    return {
      mine,
      text: "🗓 Твои смены\n\n" + (mine.map(([d, k]) => `${ruDay(d)} · ${KIND_LABEL[k]}`).join("\n") || "Пока пусто")
        + (pend.length ? "\n\nНа подтверждении у управляющего:\n" + pend.map((r) => r.items.map((i) => `${r.type === "drop" ? "снять " : ""}${ruDay(i.day)} · ${KIND_LABEL[i.kind]}`).join("\n")).join("\n") : ""),
    };
  };
  const myShiftsKb = (mine) => {
    const kb = new InlineKeyboard().text("➕ Добавить смену", "my:new").row();
    mine.slice(0, 8).forEach(([d, k]) => kb.text(`✖️ Снять ${ruShort(d)} · ${KIND_LABEL[k]}`, `my:drop:${d}:${k}`).row());
    return kb;
  };

  bot.use(async (ctx, next) => {
    if (ctx.state.isAdmin) return next();
    const p = ctx.state.person;
    const st = ctx.state.st;
    const emp = st.employees.find((e) => e.id === p.empId);
    const myName = emp?.name || p.name;
    const cq = ctx.callbackQuery?.data;

    if (cq) {
      if (cq === "my:new") {
        await ctx.answerCallbackQuery();
        return ctx.editMessageText("На какой день хочешь выйти?", { reply_markup: myDaysKb() });
      }
      if (cq.startsWith("my:d:")) {
        const day = cq.slice(5);
        await ctx.answerCallbackQuery();
        return ctx.editMessageText(`${ruDay(day)} — какая смена?`, {
          reply_markup: new InlineKeyboard()
            .text("1-я смена", `my:k:${day}:day`).text("2-я смена", `my:k:${day}:night`).row()
            .text("← Другой день", "my:new"),
        });
      }
      if (cq.startsWith("my:k:")) {
        const [day, kind] = cq.slice(5).split(":");
        const taken = st.roster[`${day}|${kind}`];
        await ctx.answerCallbackQuery();
        const who = taken && taken !== p.empId ? empName(st, taken) : null;
        return ctx.editMessageText(
          `${ruDay(day)} · ${KIND_LABEL[kind]} смена` + (who ? `\nСейчас записан ${who} — попрошу управляющего о замене.` : "") + "\n\nОтправить запрос?",
          { reply_markup: new InlineKeyboard().text("✅ Отправить", `my:send:${day}:${kind}`).text("✖️ Отмена", "my:list") });
      }
      if (cq.startsWith("my:send:")) {
        const [day, kind] = cq.slice(8).split(":");
        await ctx.answerCallbackQuery("Отправлено");
        await sendRequest(ctx, { id: uid(), empId: p.empId, name: myName, type: "add", items: [{ day, kind, name: myName }], ts: Date.now(), status: "new" });
        return ctx.editMessageText(`✅ Запрос отправлен: ${ruDay(day)} · ${KIND_LABEL[kind]} смена.\nКак ответят — напишу.`);
      }
      if (cq.startsWith("my:drop:")) {
        const [day, kind] = cq.slice(8).split(":");
        await ctx.answerCallbackQuery("Отправлено");
        await sendRequest(ctx, { id: uid(), empId: p.empId, name: myName, type: "drop", items: [{ day, kind, name: myName }], ts: Date.now(), status: "new" });
        return ctx.editMessageText(`✅ Запрос отправлен: снять ${ruDay(day)} · ${KIND_LABEL[kind]} смену.`);
      }
      if (cq === "my:list") {
        const r = myShiftsText(st, p.empId);
        await ctx.answerCallbackQuery();
        return ctx.editMessageText(r.text, { reply_markup: myShiftsKb(r.mine) });
      }
      await ctx.answerCallbackQuery();
      return;
    }

    const text = ctx.message?.text || "";
    if (text === "/start") return ctx.reply(`Привет, ${myName}! Здесь можно посмотреть свои смены и попроситься на новые.`, { reply_markup: staffMenu });
    if (text === "🗓 Мои смены") {
      const r = myShiftsText(st, p.empId);
      return ctx.reply(r.text, { reply_markup: myShiftsKb(r.mine) });
    }
    if (text === "✍️ Выбрать смену") return ctx.reply("На какой день хочешь выйти?", { reply_markup: myDaysKb() });

    const items = parseRoster(text, myName);
    if (!items.length) return ctx.reply("Нажми «Выбрать смену» или напиши, например: «завтра 1».", { reply_markup: staffMenu });
    await sendRequest(ctx, { id: uid(), empId: p.empId, name: myName, type: "add", items, ts: Date.now(), status: "new" });
    return ctx.reply("Отправил управляющему:\n" + items.map((i) => `${ruDay(i.day)} · ${KIND_LABEL[i.kind]}`).join("\n"));
  });

  bot.command("start", (ctx) => { clrS(ctx); ctx.reply(
    "Привет! Я админ кальянной.\n\n" +
    "Кнопки внизу — касса, график, смены, склад.\n" +
    "Можно просто писать словами:\n" +
    "• «завтра Вова 2, Денис 1»\n" +
    "• «касса за сегодня 52000, 21 кальян»\n" +
    "• «пришла поставка табака»\n" +
    "• «продали 14 классики и 3 фрукта»\n" +
    "• «сколько табака на складе»", { reply_markup: menuOf(ctx.state.st) }); });

  // ═════════ ЗАПРОСЫ НА СМЕНУ ═════════
  bot.hears(/^✍️ Запросы на смену/, async (ctx) => {
    clrS(ctx);
    const s = await loadState();
    const pend = (s.requests || []).filter((r) => r.status === "new");
    if (!pend.length) return ctx.reply("Новых запросов нет.", { reply_markup: menuOf(s) });
    await ctx.reply(`Запросов без ответа: ${pend.length}`, { reply_markup: menuOf(s) });
    for (const r of pend) await ctx.reply(reqText(r), { reply_markup: reqKb(r.id) });
  });

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
  const SITE = RENDER_EXTERNAL_URL || "";
  const dashKb = (() => {
    const kb = new InlineKeyboard();
    if (SITE) kb.url("🌐 Открыть сайт", SITE).row();
    return kb.text("💰 Заполнить кассу", "c:pick:0").text("📦 Склад", "w:show").row().text("🗓 График", "g:0");
  })();

  bot.hears("📊 Дэшборд", async (ctx) => {
    clrS(ctx);
    const s = await loadState();
    await ctx.reply(dashText(s), { reply_markup: dashKb });
    if (pendCount(s)) await ctx.reply(`✍️ Запросов на смену без ответа: ${pendCount(s)}`, { reply_markup: menuOf(s) });
  });

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
      if (verdict === "ok") {
        if (req.type === "drop") for (const it of req.items) { if (s.roster[`${it.day}|${it.kind}`] === req.empId) delete s.roster[`${it.day}|${it.kind}`]; }
        else applyRoster(s, req.items);
      }
    });
    await ctx.answerCallbackQuery();
    if (!req) return ctx.editMessageText("Заявка уже обработана.");
    const list = req.items.map((i) => `${ruShort(i.day)} · ${KIND_LABEL[i.kind]}`).join(", ");
    const what = req.type === "drop" ? "снятие смен" : "смены";
    await ctx.editMessageText(`${verdict === "ok" ? "✅ Подтверждено" : "✖️ Отклонено"} · ${req.name}: ${list}`);
    const tg = Object.entries(s.people).find(([, p]) => p.empId === req.empId);
    if (tg) ctx.api.sendMessage(tg[0], verdict === "ok" ? `✅ Подтвердили ${what}: ${list}` : `✖️ Отклонили ${what}: ${list}`).catch(() => {});
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
          { reply_markup: menuOf(s) });
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
