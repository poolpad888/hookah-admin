import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  AreaChart, Area, PieChart, Pie, Cell, LabelList,
} from "recharts";

// ---------- API ----------
const TOKEN_KEY = "hookah_token";
const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "x-token": getToken() }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error("unauthorized");
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; e.data = j; throw e; }
  return j;
};

// ---------- палитра "мята" ----------
const LIGHT = {
  ink: "#0E2F2B", mint: "#19C39A", mintDeep: "#0F8F70", mintPale: "#DDF7EF",
  paper: "#F4FBF8", white: "#FFFFFF", coral: "#F2634A", sun: "#F5B841", sky: "#3A8DFF", lilac: "#8E6CF2",
  mute: "#6B8A84", line: "#D5EAE3", panel: "#0E2F2B", panelText: "#FFFFFF", panelSoft: "#B7E8D8", lowBg: "#FFF3F0", cellBg: "rgba(255,255,255,.7)",
};
const DARK = {
  ink: "#E6F4EF", mint: "#2BD7AB", mintDeep: "#5FE3C0", mintPale: "#173A33",
  paper: "#0C1A16", white: "#162924", coral: "#FF7A62", sun: "#FFC857", sky: "#5CA3FF", lilac: "#A98CFF",
  mute: "#9CC2B9", line: "#27453E", panel: "#0C2B24", panelText: "#EAF7F2", panelSoft: "#8FD9C2", lowBg: "#402A24", cellBg: "rgba(255,255,255,.06)",
};
const PAL = { ...LIGHT };
const BRAND_COLORS = [PAL.mint, PAL.sky, PAL.lilac, PAL.sun, PAL.coral, "#2FB3C6", "#E058A8"];
const EMP_COLORS = [PAL.mint, PAL.sky, PAL.lilac, PAL.sun, PAL.coral, "#2FB3C6", "#E058A8", "#7AC943"];

// ---------- даты ----------
const DAYS_RU = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTHS_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = new Date(d); const w = (x.getDay() + 6) % 7; x.setDate(x.getDate() - w); x.setHours(12, 0, 0, 0); return x; };
const fmtShort = (d) => `${d.getDate()} ${MONTHS_RU[d.getMonth()]}`;
const TODAY = new Date(); TODAY.setHours(12, 0, 0, 0);

// ---------- стартовые данные ----------
const SEED_EMPLOYEES = ["Артём", "Даша", "Максим", "Лена"].map((name, i) => ({ id: `e${i}`, name, color: EMP_COLORS[i] }));

// ---------- мелкие компоненты ----------
const Card = ({ title, aside, children, style }) => (
  <section style={{ background: PAL.white, border: `1px solid ${PAL.line}`, borderRadius: 18, padding: "18px 20px", ...style }}>
    {(title || aside) && (
      <div className="flex items-baseline justify-between mb-3 gap-3">
        {title && <h2 style={{ fontSize: 17, fontWeight: 700, color: PAL.ink, margin: 0 }}>{title}</h2>}
        {aside && <div style={{ fontSize: 13, color: PAL.mute }}>{aside}</div>}
      </div>
    )}
    {children}
  </section>
);

const Btn = ({ children, onClick, tone = "mint", small, disabled }) => {
  const tones = {
    mint: { background: PAL.mint, color: PAL.ink },
    ghost: { background: PAL.mintPale, color: PAL.mintDeep },
    coral: { background: "#FDE4DF", color: PAL.coral },
    ink: { background: PAL.panel, color: PAL.panelText },
  };
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ ...tones[tone], border: "none", borderRadius: 10, padding: small ? "6px 10px" : "9px 14px", fontWeight: 700, fontSize: small ? 12 : 14, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, fontFamily: "inherit" }}>
      {children}
    </button>
  );
};

const STY = {
  get input() { return { border: `1px solid ${PAL.line}`, borderRadius: 10, padding: "8px 10px", fontSize: 14, color: PAL.ink, background: PAL.white, fontFamily: "inherit", outline: "none", width: "100%" }; },
  get tip() { return { background: PAL.panel, border: "none", borderRadius: 10, color: PAL.panelText, fontSize: 12 }; },
};

const Pill = ({ color, children, light }) => (
  <span style={{ background: light ? "rgba(255,255,255,.14)" : color + "22", color: light ? "#FFFFFF" : PAL.ink, borderRadius: 999, padding: "2px 9px", fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
    <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: "inline-block" }} />{children}
  </span>
);


// ====================================================================
export default function HookahAdmin() {
  const [view, setView] = useState("tobacco");
  const [employees, setEmployees] = useState([]);
  const [shifts, setShifts] = useState({});
  const [toast, setToast] = useState(null);
  const [prices, setPrices] = useState({ regular: 3000, premium: 3500, electro: 4000 });
  const [shift, setShift] = useState(null); // текущая открытая смена
  const [closedShifts, setClosedShifts] = useState([]);
  const [dark, setDark] = useState(() => localStorage.getItem("hookah_dark") === "1");
  const [ledger, setLedger] = useState([]);
  const [bowlGrams, setBowlGrams] = useState({ regular: 22, premium: 30, electro: 0 });
  const [daily, setDaily] = useState({}); // "дата|смена" → { cash, hookahs }
  const [inventories, setInventories] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [pwd, setPwd] = useState("");
  const [pwdErr, setPwdErr] = useState("");
  const [fatal, setFatal] = useState("");
  useEffect(() => { const h = (e) => setFatal(String(e.message || e.reason || e)); window.addEventListener("error", h); window.addEventListener("unhandledrejection", h); return () => { window.removeEventListener("error", h); window.removeEventListener("unhandledrejection", h); }; }, []);
  const versionRef = useRef(0);
  const dirtyRef = useRef(false);
  const applyRef = useRef(false);

  // применить состояние с сервера
  const applyState = (s) => {
    applyRef.current = true;
    versionRef.current = s.version || 0;
    setEmployees(s.employees?.length ? s.employees : SEED_EMPLOYEES);
    setShifts(s.roster || {});
    setPrices(s.prices || { regular: 3000, premium: 3500, electro: 4000 });
    setBowlGrams(s.bowlGrams || { regular: 22, premium: 30, electro: 0 });
    setShift(s.shift || null);
    setClosedShifts(s.closedShifts || []);
    setLedger(s.ledger || []);
    setDaily(s.daily || {});
    setInventories(s.inventories || []);
    setRequests(s.requests || []);
    setTimeout(() => { applyRef.current = false; }, 0);
  };
  const load = async () => {
    try { const s = await api("GET", "/api/state"); applyState(s); setAuthed(true); setLoaded(true); }
    catch (e) { if (e.message === "unauthorized") { setAuthed(false); setLoaded(true); } else setToast("Нет связи с сервером"); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { localStorage.setItem("hookah_dark", dark ? "1" : "0"); }, [dark]);

  // сохранение на сервер (с задержкой, чтобы не слать каждую букву)
  useEffect(() => {
    if (!loaded || !authed || applyRef.current) return;
    dirtyRef.current = true;
    const t = setTimeout(async () => {
      try {
        const s = await api("PUT", "/api/state", { version: versionRef.current, employees, roster: shifts, prices, bowlGrams, shift, closedShifts, ledger, daily, inventories, requests });
        versionRef.current = s.version; dirtyRef.current = false;
      } catch (e) {
        if (e.status === 409 && e.data) { applyState(e.data); setToast("Данные обновились из бота"); dirtyRef.current = false; }
        else setToast("Не сохранилось: " + e.message);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [employees, shifts, prices, bowlGrams, shift, closedShifts, ledger, daily, inventories, requests]);

  // подхватывать изменения из бота
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(async () => {
      if (dirtyRef.current) return;
      try { const s = await api("GET", "/api/state"); if ((s.version || 0) > versionRef.current) { applyState(s); setToast("Обновлено из бота"); } } catch {}
    }, 10000);
    return () => clearInterval(t);
  }, [authed]);

  const login = async () => {
    setPwdErr("");
    const r = await api("POST", "/api/login", { password: pwd }).catch(() => ({ ok: false }));
    if (!r.ok) return setPwdErr("Неверный пароль");
    localStorage.setItem(TOKEN_KEY, pwd); setPwd(""); load();
  };

  Object.assign(PAL, dark ? DARK : LIGHT);

  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&display=swap";
    document.head.appendChild(l);
    return () => document.head.removeChild(l);
  }, []);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2200); return () => clearTimeout(t); }, [toast]);

  if (!loaded || !authed) return (
    <div style={{ minHeight: "100vh", background: PAL.paper, fontFamily: "Manrope, system-ui, sans-serif", color: PAL.ink, display: "grid", placeItems: "center" }}>
      {loaded && (
        <div style={{ background: PAL.white, border: `1px solid ${PAL.line}`, borderRadius: 18, padding: 28, width: 320, boxShadow: "0 10px 40px rgba(14,47,43,.08)" }}>
          <div style={{ fontWeight: 800, fontSize: 22, marginBottom: 4 }}>Мята — админ</div>
          <div style={{ fontSize: 13, color: PAL.mute, marginBottom: 16 }}>Введи пароль управляющего</div>
          <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} onKeyDown={(e) => e.key === "Enter" && login()} autoFocus
            style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${PAL.line}`, borderRadius: 10, padding: "10px 12px", fontSize: 15, fontFamily: "inherit", background: PAL.paper, color: PAL.ink }} />
          {fatal && <div style={{ color: PAL.coral, fontSize: 12, marginTop: 8 }}>Ошибка: {fatal}</div>}
          {pwdErr && <div style={{ color: PAL.coral, fontSize: 13, marginTop: 8 }}>{pwdErr}</div>}
          <button onClick={login} style={{ marginTop: 14, width: "100%", border: "none", borderRadius: 10, padding: "10px", background: PAL.mint, color: PAL.ink, fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "inherit" }}>Войти</button>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: PAL.paper, fontFamily: "Manrope, system-ui, sans-serif", color: PAL.ink }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 24px 10px", flexWrap: "wrap", gap: 12 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: 38, height: 38, borderRadius: 12, background: PAL.mint, display: "grid", placeItems: "center", fontWeight: 800, color: PAL.ink, fontSize: 18 }}>М</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 20, letterSpacing: -0.4 }}>Мята — админ</div>
            <div style={{ fontSize: 12, color: PAL.mute }}>{DAYS_RU[(TODAY.getDay() + 6) % 7]}, {fmtShort(TODAY)}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
        <button onClick={() => setDark((d) => !d)} title="Переключить тему" aria-label="Переключить тему"
          style={{ width: 40, height: 40, borderRadius: 12, border: `1px solid ${PAL.line}`, background: PAL.white, cursor: "pointer", fontSize: 18, display: "grid", placeItems: "center" }}>
          {dark ? "☀️" : "🌙"}
        </button>
        <nav style={{ display: "flex", background: PAL.white, border: `1px solid ${PAL.line}`, borderRadius: 12, padding: 4, gap: 4 }}>
          {[["tobacco", "Табак"], ["staff", "Смены"]].map(([k, l]) => (
            <button key={k} onClick={() => setView(k)}
              style={{ border: "none", borderRadius: 9, padding: "8px 18px", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit", background: view === k ? PAL.panel : "transparent", color: view === k ? PAL.panelText : PAL.mute }}>
              {l}
            </button>
          ))}
        </nav>
        </div>
      </header>

      <main style={{ padding: "8px 24px 40px", maxWidth: 1240, margin: "0 auto" }}>
        {view === "tobacco"
          ? <TobaccoView setToast={setToast} ledger={ledger} setLedger={setLedger} daily={daily} inventories={inventories} setInventories={setInventories} />
          : <StaffView employees={employees} setEmployees={setEmployees} shifts={shifts} setShifts={setShifts} setToast={setToast}
              daily={daily} setDaily={setDaily} requests={requests} setRequests={setRequests} />}
      </main>

      {toast && (
        <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", background: PAL.panel, color: PAL.panelText, padding: "10px 18px", borderRadius: 12, fontWeight: 600, fontSize: 14, boxShadow: "0 8px 30px rgba(14,47,43,.25)" }}>{toast}</div>
      )}
    </div>
  );
}


const fmtMoney = (n) => Math.round(n || 0).toLocaleString("ru-RU") + " ₽";
const SHIFT_LABEL = { day: "1-я смена", night: "2-я смена" };
const shiftHoursOf = (kind, d) => kind === "day" ? "11:00–23:00" : ([5, 6].includes(d.getDay()) ? "16:00–04:00" : "16:00–02:00");
const dkey = (day, kind) => `${day}|${kind}`;
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

// ---------- горизонтальная шахматка: строки — недели, столбцы — дни ----------
function Heatmap({ shifts, empById, weeks = 4 }) {
  const [hover, setHover] = useState(null);
  const start = mondayOf(TODAY);
  const rows = Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i)));
  const LEV = [
    { bg: PAL.lowBg, br: PAL.line, label: "никого" },
    { bg: PAL.sun, br: PAL.sun, label: "одна смена" },
    { bg: PAL.mint, br: PAL.mintDeep, label: "обе смены" },
  ];
  const info = (d) => {
    const key = iso(d);
    const a = empById[shifts[dkey(key, "day")]], b = empById[shifts[dkey(key, "night")]];
    return { n: (a ? 1 : 0) + (b ? 1 : 0), a, b, key };
  };
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5, marginBottom: 5 }}>
        {DAYS_RU.map((d) => <div key={d} style={{ fontSize: 11, color: PAL.mute, fontWeight: 600, textAlign: "center" }}>{d}</div>)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {rows.map((week, wi) => (
          <div key={wi} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5 }}>
            {week.map((d) => {
              const { n } = info(d);
              const today = iso(d) === iso(TODAY);
              return (
                <div key={iso(d)} onMouseEnter={() => setHover(iso(d))} onMouseLeave={() => setHover(null)} onClick={() => setHover(iso(d))}
                  style={{ height: 26, borderRadius: 7, background: LEV[n].bg, border: today ? `2px solid ${PAL.ink}` : `1px solid ${LEV[n].br}`, display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700, color: n ? PAL.ink : PAL.mute }}>
                  {d.getDate()}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, minHeight: 34, display: "flex", alignItems: "center", padding: "6px 10px", borderRadius: 10, background: PAL.mintPale, fontSize: 12 }}>
        {(() => {
          const key = hover || iso(TODAY); const d = new Date(key + "T12:00:00"); const { a, b } = info(d);
          return (
            <span>
              <b>{DAYS_RU[(d.getDay() + 6) % 7]}, {fmtShort(d)}</b>
              <span style={{ marginLeft: 8 }}>1-я: {a ? a.name : <span style={{ color: PAL.coral }}>—</span>}</span>
              <span style={{ marginLeft: 10 }}>2-я: {b ? b.name : <span style={{ color: PAL.coral }}>—</span>}</span>
            </span>
          );
        })()}
      </div>
      <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 6, fontSize: 11, color: PAL.mute }}>
        {LEV.map((l, i) => <span key={i} className="flex items-center gap-1"><span style={{ width: 11, height: 11, borderRadius: 3, background: l.bg, border: `1px solid ${l.br}`, display: "inline-block" }} />{l.label}</span>)}
      </div>
    </div>
  );
}

// ---------- общая касса и кальяны за день ----------
function DayTotals({ rec, onSave, setToast, compact }) {
  const [edit, setEdit] = useState(false);
  const [cash, setCash] = useState("");
  const [hk, setHk] = useState("");
  useEffect(() => { setCash(rec?.cash ?? ""); setHk(rec?.hookahs ?? ""); }, [rec?.cash, rec?.hookahs]);
  const filled = !!(rec && (rec.cash || rec.hookahs));
  const save = () => {
    const c = Number(cash) || 0, h = Number(hk) || 0;
    if (!c && !h) return;
    onSave({ cash: c, hookahs: h }); setEdit(false); setToast && setToast("Записано");
  };
  if (filled && !edit) return (
    <div className="flex items-center gap-4 flex-wrap">
      <div><div style={{ fontSize: 11, color: PAL.mute }}>касса за день</div><div style={{ fontSize: compact ? 18 : 30, fontWeight: 800, color: PAL.mintDeep }}>{fmtMoney(rec.cash)}</div></div>
      <div><div style={{ fontSize: 11, color: PAL.mute }}>кальянов</div><div style={{ fontSize: compact ? 18 : 30, fontWeight: 800 }}>{rec.hookahs}</div></div>
      <div style={{ marginLeft: "auto" }}><Btn small tone="ghost" onClick={() => setEdit(true)}>Изменить</Btn></div>
    </div>
  );
  return (
    <div className="flex items-end gap-2 flex-wrap">
      <label style={{ flex: "1 1 130px" }}>
        <div style={{ fontSize: 11, color: PAL.mute, marginBottom: 3 }}>общая касса, ₽</div>
        <input type="number" inputMode="numeric" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0" style={{ ...STY.input, fontWeight: 800 }} />
      </label>
      <label style={{ flex: "1 1 100px" }}>
        <div style={{ fontSize: 11, color: PAL.mute, marginBottom: 3 }}>кальянов всего</div>
        <input type="number" inputMode="numeric" value={hk} onChange={(e) => setHk(e.target.value)} placeholder="0" style={{ ...STY.input, fontWeight: 800 }} />
      </label>
      <Btn small={compact} onClick={save}>Сохранить</Btn>
      {filled && <Btn small={compact} tone="ghost" onClick={() => setEdit(false)}>Отмена</Btn>}
    </div>
  );
}

// ---------- выбор сотрудника на смену ----------
function ShiftPick({ day, kind, emp, employees, onEmp }) {
  return (
    <div style={{ background: PAL.white, border: `1px solid ${PAL.line}`, borderRadius: 14, padding: 12, flex: "1 1 220px" }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div>
          <div style={{ fontWeight: 800, fontSize: 15 }}>{SHIFT_LABEL[kind]}</div>
          <div style={{ fontSize: 12, color: PAL.mute }}>{shiftHoursOf(kind, new Date(day + "T12:00:00"))}</div>
        </div>
        {emp && <span style={{ width: 10, height: 10, borderRadius: 5, background: emp.color || PAL.mint }} />}
      </div>
      <select value={emp?.id || ""} onChange={(e) => onEmp(e.target.value)} style={{ ...STY.input, fontWeight: 700 }}>
        <option value="">кто на смене…</option>
        {employees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    </div>
  );
}

// ====================================================================
function StaffView({ employees, setEmployees, shifts, setShifts, setToast, daily, setDaily, requests, setRequests }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [newName, setNewName] = useState("");

  const monday = addDays(mondayOf(TODAY), weekOffset * 7);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const SHIFTS = [["day", "1-я смена"], ["night", "2-я смена"]];
  const empById = Object.fromEntries(employees.map((e) => [e.id, e]));
  const setCell = (day, kind, empId) => setShifts((s) => ({ ...s, [dkey(day, kind)]: empId || undefined }));

  const today = iso(TODAY), tomorrow = iso(addDays(TODAY, 1));

  const addEmployee = () => {
    if (!newName.trim()) return;
    setEmployees((es) => [...es, { id: "e" + Date.now(), name: newName.trim(), color: EMP_COLORS[es.length % EMP_COLORS.length], rate: 10 }]);
    setNewName(""); setToast("Сотрудник добавлен");
  };
  const removeEmployee = (id) => {
    setEmployees((es) => es.filter((e) => e.id !== id));
    setShifts((s) => { const n = { ...s }; Object.keys(n).forEach((k) => { if (n[k] === id) delete n[k]; }); return n; });
  };
  const patchEmp = (id, patch) => setEmployees((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  // общая касса за день: ключ "дата|all"; старые записи по сменам суммируются
  const totalOf = (day) => {
    const all = (daily || {})[dkey(day, "all")];
    if (all) return { cash: Number(all.cash) || 0, hookahs: Number(all.hookahs) || 0 };
    const parts = ["day", "night"].map((k) => (daily || {})[dkey(day, k)]).filter(Boolean);
    if (!parts.length) return null;
    return { cash: parts.reduce((a, x) => a + (Number(x.cash) || 0), 0), hookahs: parts.reduce((a, x) => a + (Number(x.hookahs) || 0), 0) };
  };
  const setTotals = (day, rec) => setDaily((d) => {
    const n = { ...d, [dkey(day, "all")]: rec };
    delete n[dkey(day, "day")]; delete n[dkey(day, "night")];
    return n;
  });
  const empsOf = (day) => ["day", "night"].map((k) => empById[shifts[dkey(day, k)]]).filter(Boolean);

  // дни за последние 45 дней, где есть смены или касса
  const dayList = useMemo(() => {
    const out = [];
    for (let i = 0; i < 45; i++) {
      const d = addDays(TODAY, -i), day = iso(d);
      const emps = empsOf(day), rec = totalOf(day);
      if (!emps.length && !rec) continue;
      const rate = emps.length ? emps.reduce((a, e) => a + (Number(e.rate) || 0), 0) / emps.length : 0;
      out.push({ day, emps, cash: rec?.cash || 0, hookahs: rec?.hookahs || 0, filled: !!rec, pool: Math.round((rec?.cash || 0) * rate / 100) });
    }
    return out;
  }, [daily, shifts, employees]);

  const month = TODAY.getMonth(), year = TODAY.getFullYear();
  const inMonth = (day) => { const d = new Date(day + "T12:00:00"); return d.getMonth() === month && d.getFullYear() === year; };

  // зарплата: касса дня делится поровну между сотрудниками этого дня
  const salary = employees.map((e) => {
    const mine = dayList.filter((r) => inMonth(r.day) && r.emps.some((x) => x.id === e.id));
    const withCash = mine.filter((r) => r.filled);
    const base = withCash.reduce((a, r) => a + r.cash / r.emps.length, 0);
    const hk = withCash.reduce((a, r) => a + r.hookahs / r.emps.length, 0);
    const rate = Number(e.rate) || 0;
    return {
      id: e.id, name: e.name, color: e.color, rate,
      смен: mine.length, касса: Math.round(base), кальянов: Math.round(hk),
      среднее: withCash.length ? Math.round(hk / withCash.length) : 0,
      зп: Math.round(base * rate / 100),
    };
  });

  const perf = employees.map((e) => {
    const mine = dayList.filter((r) => r.filled && r.emps.some((x) => x.id === e.id));
    const avg = mine.length ? Math.round(mine.reduce((a, r) => a + r.cash / r.emps.length, 0) / mine.length) : 0;
    return { name: e.name, color: e.color, смен: mine.length, "средняя касса": avg };
  }).filter((p) => p.смен).sort((a, b) => b["средняя касса"] - a["средняя касса"]);

  const byDay = dayList;

  const chart = [...byDay].filter((r) => r.filled).slice(0, 14).reverse().map((r) => ({
    label: fmtShort(new Date(r.day + "T12:00:00")), касса: r.cash,
  }));

  const monthTot = byDay.filter((r) => inMonth(r.day)).reduce((a, r) => ({ cash: a.cash + r.cash, hk: a.hk + r.hookahs }), { cash: 0, hk: 0 });
  const [editDay, setEditDay] = useState(null);
  const pendingReqs = (requests || []).filter((r) => r.status === "new");
  const decideReq = (r, ok) => {
    if (ok) setShifts((sh) => {
      const n = { ...sh };
      (r.items || []).forEach((i) => { n[dkey(i.day, i.kind)] = r.empId; });
      return n;
    });
    setRequests((L) => (L || []).map((x) => (x.id === r.id ? { ...x, status: ok ? "ok" : "no" } : x)));
    setToast(ok ? `Смены ${r.name} одобрены` : `Заявка ${r.name} отклонена`);
  };

  const isToday = (d) => iso(d) === today;
  const th = { padding: "8px", fontWeight: 600, fontSize: 12, color: PAL.mute, textAlign: "left", whiteSpace: "nowrap" };
  const td = { padding: "8px", borderTop: `1px solid ${PAL.line}`, fontSize: 13 };
  const num = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}>
      <Card style={{ gridColumn: "span 8" }} title={`Сегодня · ${DAYS_RU[(TODAY.getDay() + 6) % 7]}, ${fmtShort(TODAY)}`}
        aside={<span style={{ fontSize: 12, color: PAL.mute }}>общая касса за день</span>}>
        <div className="flex gap-3 flex-wrap">
          {SHIFTS.map(([kind]) => (
            <ShiftPick key={kind} day={today} kind={kind} employees={employees}
              emp={empById[shifts[dkey(today, kind)]]} onEmp={(id) => setCell(today, kind, id)} />
          ))}
        </div>

        {/* заявки от сотрудников */}
        {pendingReqs.length > 0 && (
          <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 14, background: PAL.lowBg, border: `1px solid ${PAL.line}` }}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>Ждут одобрения на смену · {pendingReqs.length}</div>
            <div className="flex flex-col gap-2">
              {pendingReqs.map((r) => (
                <div key={r.id} className="flex items-center gap-2 flex-wrap" style={{ background: PAL.white, borderRadius: 10, padding: "8px 10px" }}>
                  <b style={{ fontSize: 14 }}>{r.name}</b>
                  <span style={{ fontSize: 13, color: PAL.mute }}>
                    {(r.items || []).map((i) => `${fmtShort(new Date(i.day + "T12:00:00"))} · ${SHIFT_LABEL[i.kind]}`).join(", ")}
                  </span>
                  <span className="flex gap-1" style={{ marginLeft: "auto" }}>
                    <Btn small onClick={() => decideReq(r, true)}>Одобрить</Btn>
                    <Btn small tone="coral" onClick={() => decideReq(r, false)}>Отклонить</Btn>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 14, background: PAL.paper, border: `1px solid ${PAL.line}` }}>
          <DayTotals rec={totalOf(today)} setToast={setToast} onSave={(rec) => setTotals(today, rec)} />
        </div>

        <div className="flex gap-2 flex-wrap" style={{ marginTop: 12 }}>
          <Pill color={PAL.lilac}>{MONTHS_RU[month]}: {fmtMoney(monthTot.cash)} · {monthTot.hk} шт</Pill>
          <Pill color={PAL.sky}>смен с кассой: {byDay.filter((r) => r.filled && inMonth(r.day)).length}</Pill>
        </div>
      </Card>

      <div style={{ gridColumn: "span 4", display: "flex", flexDirection: "column", gap: 16 }}>
        <Card title="Завтра">
          <div className="flex flex-col gap-2">
            {SHIFTS.map(([kind]) => {
              const e = empById[shifts[dkey(tomorrow, kind)]];
              return (
                <div key={kind} className="flex items-center justify-between gap-2" style={{ padding: "8px 12px", borderRadius: 10, background: e ? PAL.mintPale : PAL.lowBg }}>
                  <span style={{ fontSize: 13, color: PAL.mute }}>{SHIFT_LABEL[kind]}</span>
                  <b style={{ color: e ? PAL.ink : PAL.coral }}>{e ? e.name : "никого"}</b>
                </div>
              );
            })}
          </div>
        </Card>
        <Card title="Занятость смен" aside={<span style={{ fontSize: 11, color: PAL.mute }}>4 недели</span>}>
          <Heatmap shifts={shifts} empById={empById} />
        </Card>
      </div>

      <Card style={{ gridColumn: "span 12" }}
        title={`Неделя ${fmtShort(days[0])} — ${fmtShort(days[6])}`}
        aside={<div className="flex gap-2"><Btn small tone="ghost" onClick={() => setWeekOffset((w) => w - 1)}>← пред.</Btn><Btn small tone="ghost" onClick={() => setWeekOffset(0)}>Сегодня</Btn><Btn small tone="ghost" onClick={() => setWeekOffset((w) => w + 1)}>след. →</Btn></div>}>
        <div style={{ overflowX: "auto" }}>
          <div className="grid gap-2" style={{ gridTemplateColumns: "110px repeat(7, minmax(120px, 1fr))", minWidth: 960 }}>
            <div />
            {days.map((d, i) => (
              <div key={i} style={{ textAlign: "center", padding: "6px 0", borderRadius: 10, background: isToday(d) ? PAL.panel : "transparent", color: isToday(d) ? PAL.panelText : PAL.ink }}>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{DAYS_RU[i]}</div>
                <div style={{ fontSize: 12, color: isToday(d) ? PAL.panelSoft : PAL.mute }}>{fmtShort(d)}</div>
              </div>
            ))}
            {SHIFTS.map(([kind, label]) => (
              <React.Fragment key={kind}>
                <div style={{ alignSelf: "center" }}>
                  <div style={{ fontWeight: 700 }}>{label}</div>
                  <div style={{ fontSize: 12, color: PAL.mute }}>{kind === "day" ? "11:00–23:00" : "16:00–02:00, пт/сб до 04:00"}</div>
                </div>
                {days.map((d) => {
                  const key = dkey(iso(d), kind); const e = empById[shifts[key]]; const dayRec = totalOf(iso(d));
                  return (
                    <div key={key} style={{ borderRadius: 12, padding: 6, background: e ? (e.color || PAL.mint) + "22" : PAL.paper, border: `1.5px ${e ? "solid " + (e.color || PAL.mint) : "dashed " + PAL.line}`, minHeight: 58, display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 }}>
                      {e && <div style={{ fontWeight: 800, fontSize: 14, textAlign: "center" }}>{e.name}</div>}
                      {kind === "day" && dayRec ? <div style={{ fontSize: 11, textAlign: "center", color: PAL.mintDeep, fontWeight: 700 }}>{fmtMoney(dayRec.cash)} · {dayRec.hookahs} шт</div> : null}
                      <select value={shifts[key] || ""} onChange={(ev) => setCell(iso(d), kind, ev.target.value)}
                        style={{ ...STY.input, padding: "4px 6px", fontSize: 12, background: PAL.cellBg, border: "none", textAlign: "center", color: e ? PAL.mute : PAL.ink }}>
                        <option value="">{e ? "заменить…" : "назначить…"}</option>
                        {employees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </Card>

      <Card style={{ gridColumn: "span 12" }} title="Кальянные смены по дням"
        aside={<span style={{ fontSize: 12, color: PAL.mute }}>касса, кальяны и бонусный пул</span>}>
        {chart.length > 0 && (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chart} margin={{ left: -10, right: 10, top: 16 }}>
              <CartesianGrid vertical={false} stroke={PAL.line} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: PAL.mute }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: PAL.mute }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={STY.tip} formatter={(v) => fmtMoney(v)} />
              <Bar dataKey="касса" fill={PAL.mint} radius={[6, 6, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
        <div style={{ overflowX: "auto", maxHeight: 460, overflowY: "auto", marginTop: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
            <thead><tr>
              <th style={th}>День</th><th style={th}>Смена</th>
              <th style={{ ...th, textAlign: "right" }}>Касса</th>
              <th style={{ ...th, textAlign: "right" }}>Кальянов</th>
              <th style={{ ...th, textAlign: "right" }}>Бонусный пул</th>
              <th style={th} />
            </tr></thead>
            <tbody>
              {byDay.length === 0 && <tr><td style={{ ...td, color: PAL.mute }} colSpan={6}>Пока нет данных — назначь смены и заполни кассу.</td></tr>}
              {byDay.map((r) => {
                const d = new Date(r.day + "T12:00:00");
                const editing = editDay === r.day;
                return (
                  <tr key={r.day} style={{ background: r.day === today ? PAL.mintPale : (r.filled ? "transparent" : PAL.lowBg) }}>
                    <td style={{ ...td, fontWeight: 700, whiteSpace: "nowrap" }}>{DAYS_RU[(d.getDay() + 6) % 7]}, {fmtShort(d)}</td>
                    <td style={td}>{r.emps.map((e) => e.name).join(" и ") || <span style={{ color: PAL.mute }}>никого</span>}</td>
                    {editing ? (
                      <td style={td} colSpan={4}>
                        <DayTotals compact rec={r.filled ? { cash: r.cash, hookahs: r.hookahs } : null} setToast={setToast}
                          onSave={(rec) => { setTotals(r.day, rec); setEditDay(null); }} />
                      </td>
                    ) : r.filled ? (
                      <>
                        <td style={{ ...num, fontWeight: 800, color: PAL.mintDeep }}>{fmtMoney(r.cash)}</td>
                        <td style={{ ...num, fontWeight: 700 }}>{r.hookahs}</td>
                        <td style={{ ...num, color: PAL.lilac, fontWeight: 700 }}>{fmtMoney(r.pool)}</td>
                        <td style={{ ...td, textAlign: "right" }}><Btn small tone="ghost" onClick={() => setEditDay(r.day)}>Изменить</Btn></td>
                      </>
                    ) : (
                      <>
                        <td style={{ ...td, color: PAL.coral, fontWeight: 700 }} colSpan={3}>Касса не заполнена — необходимо заполнить</td>
                        <td style={{ ...td, textAlign: "right" }}><Btn small onClick={() => setEditDay(r.day)}>Заполнить</Btn></td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Штат и зарплата" style={{ gridColumn: "span 7" }} aside={<span style={{ fontSize: 12, color: PAL.mute }}>% от кассы · {MONTHS_RU[month]}</span>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
            <thead><tr>
              <th style={th}>Сотрудник</th><th style={{ ...th, textAlign: "right" }}>Мотивация, %</th><th style={th} />
            </tr></thead>
            <tbody>
              {salary.map((s) => (
                <tr key={s.id}>
                  <td style={td}>
                    <div className="flex items-center gap-2">
                      <span style={{ width: 10, height: 10, borderRadius: 5, background: s.color || PAL.mint, flexShrink: 0 }} />
                      <input value={s.name} onChange={(e) => patchEmp(s.id, { name: e.target.value })} style={{ ...STY.input, fontWeight: 600, padding: "4px 8px" }} />
                    </div>
                  </td>
                  <td style={num}><input type="number" value={s.rate} onChange={(e) => patchEmp(s.id, { rate: Number(e.target.value) || 0 })} style={{ ...STY.input, width: 70, padding: "4px 6px", textAlign: "right" }} /></td>
                  <td style={{ ...td, textAlign: "right" }}><Btn small tone="coral" onClick={() => removeEmployee(s.id)}>×</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2 mt-3">
          <input placeholder="Имя нового сотрудника" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addEmployee()} style={STY.input} />
          <Btn onClick={addEmployee} disabled={!newName.trim()}>Добавить</Btn>
        </div>
      </Card>

      <Card title="Кто делает кассу" style={{ gridColumn: "span 5" }} aside={<span style={{ fontSize: 12, color: PAL.mute }}>средняя касса за смену</span>}>
        {perf.length === 0 ? <div style={{ fontSize: 13, color: PAL.mute }}>Данных пока нет.</div> : (
          <ResponsiveContainer width="100%" height={Math.max(160, perf.length * 42)}>
            <BarChart data={perf} layout="vertical" margin={{ left: 8, right: 70 }}>
              <XAxis type="number" tick={{ fontSize: 11, fill: PAL.mute }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 13, fill: PAL.ink, fontWeight: 600 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={STY.tip} formatter={(v, n, p) => [`${fmtMoney(v)} · ${p.payload.смен} смен`, "средняя касса"]} />
              <Bar dataKey="средняя касса" radius={[0, 8, 8, 0]} isAnimationActive={false}>
                {perf.map((d, i) => <Cell key={i} fill={d.color || BRAND_COLORS[i % BRAND_COLORS.length]} />)}
                <LabelList dataKey="средняя касса" position="right" formatter={(v) => fmtMoney(v)} style={{ fontSize: 11, fill: PAL.ink, fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Card style={{ gridColumn: "span 12" }} title={`Итоги за ${MONTHS_RU[month]} — заработок сотрудников`}
        aside={<span style={{ fontSize: 12, color: PAL.mute }}>касса делится поровну между сотрудниками смены</span>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
            <thead><tr>
              <th style={th}>Сотрудник</th>
              <th style={{ ...th, textAlign: "right" }}>Смен</th>
              <th style={{ ...th, textAlign: "right" }}>Касса</th>
              <th style={{ ...th, textAlign: "right" }}>Кальянов</th>
              <th style={{ ...th, textAlign: "right" }}>В среднем за смену</th>
              <th style={{ ...th, textAlign: "right" }}>%</th>
              <th style={{ ...th, textAlign: "right" }}>Заработал</th>
            </tr></thead>
            <tbody>
              {salary.map((s) => (
                <tr key={s.id}>
                  <td style={td}><span className="flex items-center gap-2"><span style={{ width: 10, height: 10, borderRadius: 5, background: s.color || PAL.mint }} /><b>{s.name}</b></span></td>
                  <td style={num}>{s.смен}</td>
                  <td style={{ ...num, color: PAL.mute }}>{fmtMoney(s.касса)}</td>
                  <td style={num}>{s.кальянов}</td>
                  <td style={num}>{s.среднее}</td>
                  <td style={{ ...num, color: PAL.mute }}>{s.rate}%</td>
                  <td style={{ ...num, fontWeight: 800, color: PAL.mintDeep, fontSize: 15 }}>{fmtMoney(s.зп)}</td>
                </tr>
              ))}
              {salary.length > 0 && (
                <tr style={{ background: PAL.mintPale }}>
                  <td style={{ ...td, fontWeight: 800 }}>Итого</td>
                  <td style={{ ...num, fontWeight: 700 }}>{salary.reduce((a, s) => a + s.смен, 0)}</td>
                  <td style={{ ...num, fontWeight: 700 }}>{fmtMoney(salary.reduce((a, s) => a + s.касса, 0))}</td>
                  <td style={{ ...num, fontWeight: 700 }}>{salary.reduce((a, s) => a + s.кальянов, 0)}</td>
                  <td style={num} />
                  <td style={num} />
                  <td style={{ ...num, fontWeight: 800, color: PAL.lilac }}>{fmtMoney(salary.reduce((a, s) => a + s.зп, 0))}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <MonthShifts employees={employees} shifts={shifts} monday={monday} />
    </div>
  );
}

// ---------- нижний блок: смены за месяц ----------
function MonthShifts({ employees, shifts, monday }) {
  const monthStats = useMemo(() => {
    const y = monday.getFullYear(), m = monday.getMonth();
    return employees.map((e) => {
      let day = 0, night = 0;
      Object.entries(shifts).forEach(([k, v]) => {
        if (v !== e.id) return;
        const [d, kind] = k.split("|"); const dt = new Date(d + "T12:00:00");
        if (dt.getFullYear() === y && dt.getMonth() === m) kind === "day" ? day++ : night++;
      });
      return { name: e.name, день: day, ночь: night };
    });
  }, [employees, shifts, monday]);

  return (
    <Card title={`Смены за ${MONTHS_RU[monday.getMonth()]} — 1-я и 2-я`} style={{ gridColumn: "span 12" }}>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={monthStats} margin={{ left: -10, right: 10, top: 16 }}>
          <CartesianGrid vertical={false} stroke={PAL.line} />
          <XAxis dataKey="name" tick={{ fontSize: 13, fill: PAL.ink, fontWeight: 600 }} axisLine={false} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: PAL.mute }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={STY.tip} />
          <Bar dataKey="день" stackId="a" fill={PAL.sun} isAnimationActive={false} />
          <Bar dataKey="ночь" stackId="a" fill={PAL.ink} radius={[8, 8, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <div className="flex gap-2 mt-2"><Pill color={PAL.sun}>1-я смена</Pill><Pill color={PAL.ink}>2-я смена</Pill></div>
    </Card>
  );
}


// ====================================================================
const TYPES = {
  supply: { label: "Поставка", color: "#19C39A" },
  sale: { label: "Продажа", color: "#3A8DFF" },
  writeoff: { label: "Списание", color: "#F2634A" },
  adjust: { label: "Корректировка", color: "#8E6CF2" },
  inventory: { label: "Инвентаризация", color: "#F5B841" },
};
// граммовки кальянов
const BOWLS = [
  ["classic", "Классика", 22],
  ["pro1", "Хука Про 1", 11],
  ["pro2", "Хука Про 2", 22],
  ["fruit", "Фрукты", 30],
];
const bowlG = (k) => (BOWLS.find((b) => b[0] === k) || [, , 22])[2];
const bowlName = (k) => (BOWLS.find((b) => b[0] === k) || [, "кальян"])[1];
const INV_KIND = { mid: "Промежуточная", main: "Основная" };
const DEVIATION = 800; // допустимое отклонение, г
const GRAMS_PER_BOWL = 22; // средняя граммовка кальяна для прогноза

function QtyTable({ q, onChange, color }) {
  return (
    <div className="flex flex-col gap-2" style={{ marginTop: 10 }}>
      {BOWLS.map(([k, name, g]) => (
        <div key={k} className="flex items-center gap-2">
          <div style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>{name}<span style={{ fontWeight: 600, fontSize: 12, color: PAL.mute }}> · {g} г</span></div>
          <input type="number" min={0} value={q[k] ?? ""} placeholder="0" onChange={(e) => onChange({ ...q, [k]: e.target.value })}
            style={{ ...STY.input, width: 84, textAlign: "center", fontWeight: 800 }} />
          <div style={{ width: 76, textAlign: "right", fontSize: 13, color: (Number(q[k]) || 0) ? color : PAL.mute, fontWeight: 700 }}>
            {(Number(q[k]) || 0) * g || 0} г
          </div>
        </div>
      ))}
    </div>
  );
}

function TobaccoView({ setToast, ledger, setLedger, daily, inventories, setInventories }) {
  const [range, setRange] = useState(14);
  const fileRef = useRef();
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(null);
  const [fileMode, setFileMode] = useState("add");
  const [fileErr, setFileErr] = useState("");
  const [confirmFile, setConfirmFile] = useState(false);

  const stock = ledger.reduce((s, l) => s + (Number(l.grams) || 0), 0);
  const add = (entry) => setLedger((L) => [...L, { id: "l" + Date.now() + Math.random().toString(16).slice(2, 5), date: iso(TODAY), ts: Date.now(), ...entry }]);
  const addMany = (entries) => setLedger((L) => [...L, ...entries.map((e, i) => ({ id: "l" + Date.now() + i + Math.random().toString(16).slice(2, 4), date: iso(TODAY), ts: Date.now() + i, ...e }))]);
  const remove = (id) => setLedger((L) => L.filter((l) => l.id !== id));
  const patch = (id, fields) => setLedger((L) => L.map((l) => (l.id === id ? { ...l, ...fields } : l)));

  // ---------- расчётный остаток: график и прогноз ----------
  const chart = useMemo(() => {
    const out = []; const start = iso(addDays(TODAY, -(range - 1)));
    let bal = ledger.filter((l) => l.date < start).reduce((s, l) => s + l.grams, 0);
    for (let d = range - 1; d >= 0; d--) {
      const key = iso(addDays(TODAY, -d)); const ls = ledger.filter((l) => l.date === key);
      bal += ls.reduce((s, l) => s + l.grams, 0);
      out.push({ label: fmtShort(addDays(TODAY, -d)), остаток: bal, ушло: -ls.filter((l) => l.grams < 0).reduce((s, l) => s + l.grams, 0) });
    }
    return out;
  }, [ledger, range]);

  // среднее число кальянов в день — из смен
  const avgHookahs = useMemo(() => {
    const rows = Object.entries(daily || {}).map(([k, v]) => ({ day: k.split("|")[0], hk: Number(v?.hookahs) || 0 })).filter((r) => r.hk);
    const from = iso(addDays(TODAY, -29));
    const recent = rows.filter((r) => r.day >= from);
    const byDay = {};
    recent.forEach((r) => { byDay[r.day] = (byDay[r.day] || 0) + r.hk; });
    const ds = Object.values(byDay);
    return ds.length ? ds.reduce((a, x) => a + x, 0) / ds.length : 0;
  }, [daily]);

  const perDay = Math.round(avgHookahs * GRAMS_PER_BOWL);
  const daysLeft = perDay > 0 ? Math.floor(stock / perDay) : null;
  const goneRange = chart.reduce((s, r) => s + r.ушло, 0);

  // ---------- инвентаризация ----------
  const invList = [...(inventories || [])].sort((a, b) => (a.date < b.date ? 1 : -1));
  const lastInv = invList[0] || null;
  const nextInvDate = lastInv ? addDays(new Date(lastInv.date + "T12:00:00"), 30) : null;
  const daysToInv = nextInvDate ? Math.round((nextInvDate - TODAY) / 864e5) : null;

  const [invKind, setInvKind] = useState("mid");
  const [invActual, setInvActual] = useState("");
  const [invChecked, setInvChecked] = useState(false);
  const [showInvList, setShowInvList] = useState(false);
  const invNum = Number(invActual);
  const invDiff = invActual === "" ? null : Math.round(invNum - stock);
  const invBig = invDiff !== null && Math.abs(invDiff) > DEVIATION;

  const saveInventory = () => {
    if (invActual === "" || !(invNum >= 0)) return;
    const rec = { id: "i" + Date.now(), date: iso(TODAY), kind: invKind, actual: Math.round(invNum), calc: stock, diff: invDiff };
    setInventories((L) => [...(L || []), rec]);
    if (invDiff) add({ type: "inventory", grams: invDiff, note: `${INV_KIND[invKind].toLowerCase()} инвентаризация (расчёт ${stock} г)` });
    setInvActual(""); setInvChecked(false);
    setToast(`Инвентаризация сохранена: ${Math.round(invNum)} г`);
  };

  // ---------- ручная корректировка ----------
  const [corr, setCorr] = useState({ grams: "", note: "" });
  const corrG = Math.round(Number(String(corr.grams).replace(",", ".").replace("−", "-")) || 0);
  const doCorr = () => {
    if (!corrG) return;
    add({ type: "adjust", grams: corrG, note: corr.note || (corrG > 0 ? "ручное добавление" : "ручное уменьшение") });
    setToast(`${corrG > 0 ? "+" : ""}${corrG} г`); setCorr({ grams: "", note: "" });
  };

  // ---------- продажи и списания за период ----------
  const today = iso(TODAY);
  const [salePeriod, setSalePeriod] = useState({ from: today, to: today });
  const [saleTouched, setSaleTouched] = useState(false);
  const [saleQty, setSaleQty] = useState({});
  const [woPeriod, setWoPeriod] = useState({ from: today, to: today });
  const [woQty, setWoQty] = useState({});
  const [woReason, setWoReason] = useState("перезабивка");
  const [woOwn, setWoOwn] = useState("");

  const qtySum = (q) => BOWLS.reduce((s, [k, , g]) => s + (Number(q[k]) || 0) * g, 0);
  const qtyCount = (q) => BOWLS.reduce((s, [k]) => s + (Number(q[k]) || 0), 0);
  const saleGrams = qtySum(saleQty), woGrams = qtySum(woQty);

  const periodNote = (p) => (p.from === p.to ? fmtShort(new Date(p.from + "T12:00:00")) : `${fmtShort(new Date(p.from + "T12:00:00"))} — ${fmtShort(new Date(p.to + "T12:00:00"))}`);

  // последний внесённый период продаж
  const lastSale = useMemo(() => {
    const withP = ledger.filter((l) => l.type === "sale" && l.pTo);
    if (!withP.length) return null;
    const to = withP.reduce((m, l) => (l.pTo > m ? l.pTo : m), withP[0].pTo);
    const from = withP.filter((l) => l.pTo === to).reduce((m, l) => (l.pFrom < m ? l.pFrom : m), withP[0].pFrom);
    return { from, to };
  }, [ledger]);
  useEffect(() => {
    if (!lastSale || saleTouched) return;
    const next = iso(addDays(new Date(lastSale.to + "T12:00:00"), 1));
    setSalePeriod({ from: next, to: next > today ? next : today });
  }, [lastSale?.to]);

  const doSales = () => {
    const entries = BOWLS.filter(([k]) => Number(saleQty[k]) > 0).map(([k, label, g]) => ({
      type: "sale", kind: k, qty: Number(saleQty[k]), grams: -Number(saleQty[k]) * g,
      date: salePeriod.to, pFrom: salePeriod.from, pTo: salePeriod.to, note: `${label} · ${periodNote(salePeriod)}`,
    }));
    if (!entries.length) return;
    addMany(entries); setSaleQty({}); setSaleTouched(false); setToast(`Продажи: ${qtyCount(saleQty)} шт, −${saleGrams} г`);
  };
  const doWo = () => {
    const reason = woReason === "своя" ? (woOwn.trim() || "списание") : woReason;
    const entries = BOWLS.filter(([k]) => Number(woQty[k]) > 0).map(([k, label, g]) => ({
      type: "writeoff", kind: k, qty: Number(woQty[k]), grams: -Number(woQty[k]) * g,
      date: woPeriod.to, note: `${label} · ${reason} · ${periodNote(woPeriod)}`,
    }));
    if (!entries.length) return;
    addMany(entries); setWoQty({}); setWoOwn(""); setToast(`Списано ${qtyCount(woQty)} шт, −${woGrams} г`);
  };
  // период списания по умолчанию повторяет продажи, пока его не тронули
  const [woTouched, setWoTouched] = useState(false);
  useEffect(() => { if (!woTouched) setWoPeriod(salePeriod); }, [salePeriod, woTouched]);

  // ---------- файл ----------
  const readB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });
  const toJpeg = (file) => new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { const k = Math.min(1, 2200 / Math.max(img.width, img.height)); const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg", .92).split(",")[1]); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("не удалось открыть картинку")); };
    img.src = url;
  });
  const onFile = async (e) => {
    const file = e.target.files?.[0]; if (!file) return; setBusy(true); setFound(null); setFileErr(""); setConfirmFile(false);
    try {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const data = isPdf ? await readB64(file) : await toJpeg(file);
      const m = await api("POST", "/api/recognize", { base64: data, mediaType: isPdf ? "application/pdf" : "image/jpeg" });
      setFound({ items: m.items, docTotal: m.docTotal ?? null, name: file.name, open: false });
    } catch (ex) { setFileErr("Не удалось распознать: " + (ex.message || ex)); }
    setBusy(false); e.target.value = "";
  };
  const foundTotal = found ? found.items.reduce((s, it) => s + (Number(it.grams) || 0), 0) : 0;
  const setFoundItem = (id, grams) => setFound((f) => ({ ...f, items: f.items.map((it) => (it.id === id ? { ...it, grams: Number(grams) || 0 } : it)) }));
  const dropFoundItem = (id) => setFound((f) => ({ ...f, items: f.items.filter((it) => it.id !== id) }));
  const applyFile = () => {
    if (fileMode === "add") { add({ type: "supply", grams: foundTotal, note: `накладная ${found.name}` }); setToast(`+${foundTotal} г на склад`); }
    else { const diff = foundTotal - stock; if (diff) add({ type: "inventory", grams: diff, note: `инвентаризация по файлу ${found.name}` }); setToast(`Остаток: ${foundTotal} г`); }
    setFound(null); setConfirmFile(false);
  };

  // ---------- редактирование строк журнала ----------
  const [editRow, setEditRow] = useState(null);
  const [editVals, setEditVals] = useState({ grams: 0, note: "" });
  const startEdit = (l) => { setEditRow(l.id); setEditVals({ grams: l.grams, note: l.note || "" }); };
  const saveEdit = () => { patch(editRow, { grams: Math.round(Number(editVals.grams) || 0), note: editVals.note }); setEditRow(null); setToast("Строка изменена"); };

  const th = { padding: "8px", fontWeight: 600, fontSize: 12, color: PAL.mute, textAlign: "left", whiteSpace: "nowrap" };
  const td = { padding: "9px 8px", borderTop: `1px solid ${PAL.line}`, fontSize: 14, verticalAlign: "middle" };
  const num = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const label = { fontSize: 11, color: PAL.mute, marginBottom: 3 };

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}>
      {/* ---------- расчётный остаток ---------- */}
      <section style={{ gridColumn: "span 7", background: PAL.panel, color: PAL.panelText, borderRadius: 22, padding: "20px 22px" }}>
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <div style={{ fontSize: 13, color: PAL.panelSoft }}>Расчётный остаток на складе</div>
            <div style={{ fontSize: 48, fontWeight: 800, letterSpacing: -2, lineHeight: 1.1, color: PAL.mint }}>
              {stock.toLocaleString("ru-RU")} <span style={{ fontSize: 20, color: PAL.panelSoft, letterSpacing: 0 }}>г</span>
            </div>
          </div>
          <div className="flex gap-1">
            {[7, 14, 30].map((n) => (
              <button key={n} onClick={() => setRange(n)} style={{ border: "none", borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: range === n ? PAL.mint : "rgba(255,255,255,.12)", color: range === n ? PAL.ink : PAL.panelText }}>{n} дн.</button>
            ))}
          </div>
        </div>

        <div style={{ height: 150, marginTop: 10 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chart} margin={{ left: -20, right: 6, top: 6 }}>
              <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={PAL.mint} stopOpacity={.55} /><stop offset="100%" stopColor={PAL.mint} stopOpacity={0} /></linearGradient></defs>
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: PAL.panelSoft }} axisLine={false} tickLine={false} interval={range > 14 ? 3 : 1} />
              <YAxis tick={{ fontSize: 10, fill: PAL.panelSoft }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={STY.tip} formatter={(v, n) => [`${v} г`, n]} />
              <Area type="monotone" dataKey="остаток" stroke={PAL.mint} strokeWidth={2.5} fill="url(#g1)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="flex flex-wrap gap-2" style={{ marginTop: 6 }}>
          <Pill color={PAL.mint} light>за {range} дн. ушло {goneRange} г</Pill>
          <Pill color={PAL.sky} light>в среднем {avgHookahs ? avgHookahs.toFixed(1) : "—"} кальянов в день</Pill>
          <Pill color={PAL.sun} light>расход ≈ {perDay || "—"} г/день</Pill>
        </div>

        <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "rgba(255,255,255,.10)" }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            {daysLeft === null
              ? <span style={{ color: PAL.panelSoft }}>Заполни кальяны в сменах — посчитаю, на сколько хватит.</span>
              : <>Рекомендация: хватит примерно на <span style={{ color: daysLeft < 7 ? PAL.coral : PAL.mint, fontSize: 22 }}>{daysLeft}</span> дн.
                {daysLeft < 7 && <span style={{ color: PAL.coral }}> — пора заказывать</span>}</>}
          </div>
          <div style={{ fontSize: 11, color: PAL.panelSoft, opacity: .75, marginTop: 4 }}>
            Прогноз по среднему расходу из расчёта {GRAMS_PER_BOWL} г на кальян — из остатка ничего не вычитается.
          </div>
        </div>
      </section>

      {/* ---------- реальная инвентаризация ---------- */}
      <Card style={{ gridColumn: "span 5" }} title="Реальная инвентаризация"
        aside={<Btn small tone="ghost" onClick={() => setShowInvList((v) => !v)}>{showInvList ? "Скрыть" : "Прошлые"}</Btn>}>
        <div className="flex flex-wrap gap-2 mb-3">
          {lastInv ? (
            <>
              <Pill color={PAL.sun}>последняя {fmtShort(new Date(lastInv.date + "T12:00:00"))} · {lastInv.actual} г</Pill>
              <Pill color={daysToInv <= 3 ? PAL.coral : PAL.sky}>
                {daysToInv > 0 ? `следующая через ${daysToInv} дн.` : `просрочена на ${-daysToInv} дн.`}
              </Pill>
            </>
          ) : <Pill color={PAL.coral}>инвентаризаций ещё не было</Pill>}
        </div>

        {showInvList ? (
          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Дата</th><th style={th}>Тип</th><th style={{ ...th, textAlign: "right" }}>Факт</th><th style={{ ...th, textAlign: "right" }}>Расчёт</th><th style={{ ...th, textAlign: "right" }}>Δ</th></tr></thead>
              <tbody>
                {invList.length === 0 && <tr><td colSpan={5} style={{ ...td, color: PAL.mute }}>Пока пусто</td></tr>}
                {invList.map((i) => (
                  <tr key={i.id}>
                    <td style={td}>{fmtShort(new Date(i.date + "T12:00:00"))}</td>
                    <td style={{ ...td, color: PAL.mute }}>{INV_KIND[i.kind]}</td>
                    <td style={{ ...num, fontWeight: 700 }}>{i.actual}</td>
                    <td style={{ ...num, color: PAL.mute }}>{i.calc}</td>
                    <td style={{ ...num, fontWeight: 700, color: Math.abs(i.diff) > DEVIATION ? PAL.coral : PAL.mintDeep }}>{i.diff > 0 ? "+" : ""}{i.diff}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <div className="flex gap-2 mb-3">
              {Object.entries(INV_KIND).map(([k, l]) => (
                <button key={k} onClick={() => setInvKind(k)}
                  style={{ flex: 1, border: `2px solid ${invKind === k ? PAL.mint : PAL.line}`, background: invKind === k ? PAL.mintPale : PAL.white, color: PAL.ink, borderRadius: 12, padding: "10px", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
              ))}
            </div>
            <div style={label}>Фактический остаток, г</div>
            <div className="flex gap-2">
              <input type="number" value={invActual} placeholder={String(stock)} onChange={(e) => { setInvActual(e.target.value); setInvChecked(true); }}
                style={{ ...STY.input, fontSize: 22, fontWeight: 800 }} />
            </div>

            {invDiff !== null && invChecked && (
              <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 12, background: invBig ? PAL.lowBg : PAL.mintPale }}>
                <div style={{ fontWeight: 800, color: invBig ? PAL.coral : PAL.mintDeep }}>
                  {invBig ? "Необходимо пересчитать" : "Нормальное отклонение"}
                </div>
                <div style={{ fontSize: 13, color: PAL.mute, marginTop: 2 }}>
                  расчётный {stock} г · факт {Math.round(invNum)} г · разница {invDiff > 0 ? "+" : ""}{invDiff} г
                  {invBig && ` (допустимо ±${DEVIATION} г)`}
                </div>
                {invBig && <div style={{ marginTop: 8 }}><Btn small tone="coral" onClick={() => { setInvActual(""); setInvChecked(false); }}>Пересчитать</Btn></div>}
              </div>
            )}

            <div className="flex gap-2" style={{ marginTop: 12 }}>
              <Btn onClick={saveInventory} disabled={invActual === ""}>Сохранить инвентаризацию</Btn>
            </div>
          </>
        )}
      </Card>

      {/* ---------- ручная корректировка ---------- */}
      <Card style={{ gridColumn: "span 4" }} title="Ручная корректировка"
        aside={<span style={{ fontSize: 12, color: PAL.mute }}>минус — убрать</span>}>
        <div style={label}>Граммы: 500 добавит, −500 уберёт</div>
        <input value={corr.grams} placeholder="например −250" onChange={(e) => setCorr({ ...corr, grams: e.target.value })}
          style={{ ...STY.input, fontSize: 22, fontWeight: 800, color: corrG < 0 ? PAL.coral : PAL.ink }} />
        <div style={{ ...label, marginTop: 10 }}>Комментарий — почему</div>
        <input value={corr.note} placeholder="например: просыпали при забивке" onChange={(e) => setCorr({ ...corr, note: e.target.value })} style={STY.input} />
        <div className="flex items-center gap-2" style={{ marginTop: 12 }}>
          <Btn onClick={doCorr} disabled={!corrG}>Сохранить</Btn>
          {!!corrG && <span style={{ fontSize: 14, color: PAL.mute }}>остаток станет <b style={{ color: PAL.ink }}>{stock + corrG} г</b></span>}
        </div>
      </Card>

      {/* ---------- продажи ---------- */}
      <Card style={{ gridColumn: "span 4" }} title="Продажи кальянов">
        <div style={{ fontSize: 12, color: PAL.mute, marginBottom: 8, padding: "6px 10px", borderRadius: 8, background: PAL.paper }}>
          {lastSale
            ? <>последние продажи внесены за <b style={{ color: PAL.ink }}>{periodNote({ from: lastSale.from, to: lastSale.to })}</b></>
            : "продажи ещё не вносились"}
        </div>
        <div className="flex gap-2">
          <label style={{ flex: 1 }}><div style={label}>с</div>
            <input type="date" value={salePeriod.from} onChange={(e) => { setSaleTouched(true); setSalePeriod({ ...salePeriod, from: e.target.value }); }} style={STY.input} /></label>
          <label style={{ flex: 1 }}><div style={label}>по</div>
            <input type="date" value={salePeriod.to} onChange={(e) => { setSaleTouched(true); setSalePeriod({ ...salePeriod, to: e.target.value }); }} style={STY.input} /></label>
        </div>
        <QtyTable q={saleQty} onChange={setSaleQty} color={PAL.sky} />
        <div className="flex items-center gap-2" style={{ marginTop: 12 }}>
          <Btn onClick={doSales} disabled={!saleGrams}>Сохранить</Btn>
          <span style={{ fontSize: 14, color: PAL.mute }}>{qtyCount(saleQty)} шт · <b style={{ color: PAL.coral }}>−{saleGrams} г</b></span>
        </div>
      </Card>

      {/* ---------- списание ---------- */}
      <Card style={{ gridColumn: "span 4" }} title="Списание">
        <div className="flex gap-2">
          <label style={{ flex: 1 }}><div style={label}>с</div>
            <input type="date" value={woPeriod.from} onChange={(e) => { setWoTouched(true); setWoPeriod({ ...woPeriod, from: e.target.value }); }} style={STY.input} /></label>
          <label style={{ flex: 1 }}><div style={label}>по</div>
            <input type="date" value={woPeriod.to} onChange={(e) => { setWoTouched(true); setWoPeriod({ ...woPeriod, to: e.target.value }); }} style={STY.input} /></label>
        </div>
        <QtyTable q={woQty} onChange={setWoQty} color={PAL.coral} />
        <div style={{ ...label, marginTop: 10 }}>Причина</div>
        <div className="flex gap-2">
          {[["перезабивка", "Перезабивка"], ["своя", "Своя причина"]].map(([k, l]) => (
            <button key={k} onClick={() => setWoReason(k)}
              style={{ flex: 1, border: `2px solid ${woReason === k ? PAL.sun : PAL.line}`, background: woReason === k ? PAL.sun + "22" : PAL.white, color: PAL.ink, borderRadius: 10, padding: "8px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
          ))}
        </div>
        {woReason === "своя" && <input value={woOwn} placeholder="напиши причину" onChange={(e) => setWoOwn(e.target.value)} style={{ ...STY.input, marginTop: 8 }} />}
        <div className="flex items-center gap-2" style={{ marginTop: 12 }}>
          <Btn tone="coral" onClick={doWo} disabled={!woGrams}>Сохранить</Btn>
          <span style={{ fontSize: 14, color: PAL.mute }}>{qtyCount(woQty)} шт · <b style={{ color: PAL.coral }}>−{woGrams} г</b></span>
        </div>
      </Card>

      {/* ---------- файл ---------- */}
      <Card style={{ gridColumn: "1 / -1" }} title="Из файла"
        aside={
          <div className="flex gap-1">
            {[["add", "Поставка — добавить"], ["replace", "Инвентаризация — заменить"]].map(([k, l]) => (
              <button key={k} onClick={() => setFileMode(k)} style={{ border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: fileMode === k ? PAL.panel : PAL.paper, color: fileMode === k ? PAL.panelText : PAL.mute }}>{l}</button>
            ))}
          </div>
        }>
        <div className="flex items-center gap-3 flex-wrap">
          <input ref={fileRef} type="file" accept="image/*,application/pdf" onChange={onFile} style={{ display: "none" }} />
          <Btn tone="ink" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? "Читаю…" : "Выбрать фото или PDF"}</Btn>
          <span style={{ fontSize: 13, color: PAL.mute }}>накладная или лист инвентаризации — посчитаю общий вес</span>
        </div>
        {fileErr && <div style={{ marginTop: 10, fontSize: 13, color: PAL.coral }}>{fileErr}</div>}

        {found && (
          <div className="mt-3" style={{ padding: "12px 14px", borderRadius: 12, background: PAL.mintPale, fontSize: 14 }}>
            <div className="flex items-center gap-3 flex-wrap">
              <span>В файле «{found.name}»: <b style={{ fontSize: 22 }}>{foundTotal} г</b> <span style={{ color: PAL.mute }}>({found.items.length} строк)</span></span>
              <Btn tone="ghost" onClick={() => setFound((f) => ({ ...f, open: !f.open }))}>{found.open ? "Скрыть строки" : "Проверить строки"}</Btn>
              {!confirmFile && <Btn onClick={() => setConfirmFile(true)}>Далее</Btn>}
              <Btn tone="ghost" onClick={() => { setFound(null); setConfirmFile(false); }}>Отмена</Btn>
            </div>

            {found.docTotal !== null && found.docTotal !== foundTotal && (
              <div style={{ marginTop: 8, fontSize: 13, color: PAL.coral, fontWeight: 600 }}>
                В документе напечатан итог {found.docTotal} г, по строкам {foundTotal} г — проверь строки.
                <button onClick={() => setFound((f) => ({ ...f, items: [{ id: -1, name: "итог из документа", grams: f.docTotal, calc: "", assumed: false }], open: false }))}
                  style={{ marginLeft: 8, border: "none", background: "transparent", color: PAL.mintDeep, cursor: "pointer", fontFamily: "inherit", fontWeight: 700, textDecoration: "underline" }}>Взять итог из документа</button>
              </div>
            )}

            {confirmFile && (
              <div style={{ marginTop: 10, padding: "12px 14px", borderRadius: 12, background: PAL.white, border: `2px solid ${PAL.mint}` }}>
                <div style={{ fontWeight: 800, fontSize: 15 }}>Подтверди операцию</div>
                <div style={{ fontSize: 14, marginTop: 6 }}>
                  {fileMode === "add"
                    ? <>Поступило <b>{foundTotal} г</b>. Остаток станет <b style={{ color: PAL.mintDeep }}>{stock + foundTotal} г</b> (сейчас {stock} г).</>
                    : <>Остаток будет заменён на <b>{foundTotal} г</b>. Сейчас {stock} г, корректировка{" "}
                      <b style={{ color: foundTotal - stock >= 0 ? PAL.mintDeep : PAL.coral }}>{foundTotal - stock > 0 ? "+" : ""}{foundTotal - stock} г</b>.</>}
                </div>
                <div className="flex gap-2" style={{ marginTop: 10 }}>
                  <Btn onClick={applyFile}>Подтверждаю</Btn>
                  <Btn tone="ghost" onClick={() => setConfirmFile(false)}>Назад</Btn>
                </div>
              </div>
            )}

            {found.items.some((it) => it.assumed) && <div style={{ marginTop: 6, fontSize: 12, color: PAL.mute }}>Строки со звёздочкой — вес не указан, взято по 250 г за пачку.</div>}
            {found.open && (
              <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10, background: PAL.white, borderRadius: 10, overflow: "hidden" }}>
                <tbody>
                  {found.items.map((it) => (
                    <tr key={it.id} style={{ borderTop: `1px solid ${PAL.line}` }}>
                      <td style={{ padding: "6px 10px", fontSize: 13 }}>{it.name}{it.assumed ? " *" : ""}</td>
                      <td style={{ padding: "6px 10px", fontSize: 12, color: PAL.mute, whiteSpace: "nowrap" }}>{it.calc}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right" }}><input type="number" value={it.grams} onChange={(e) => setFoundItem(it.id, e.target.value)} style={{ ...STY.input, width: 90, padding: "4px 8px", textAlign: "right", fontWeight: 700 }} /></td>
                      <td style={{ padding: "6px 10px", textAlign: "right" }}><Btn small tone="coral" onClick={() => dropFoundItem(it.id)}>×</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Card>

      {/* ---------- журнал ---------- */}
      <Card style={{ gridColumn: "1 / -1" }} title="Движения" aside={<span style={{ fontSize: 12, color: PAL.mute }}>{ledger.length} записей</span>}>
        <div style={{ overflowX: "auto", maxHeight: 460, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
            <thead><tr>
              <th style={th}>Дата</th><th style={th}>Операция</th><th style={th}>Что</th>
              <th style={{ ...th, textAlign: "right" }}>Шт</th><th style={{ ...th, textAlign: "right" }}>Граммы</th>
              <th style={{ ...th, textAlign: "right" }}>Остаток</th><th style={th} />
            </tr></thead>
            <tbody>
              {(() => { let bal = stock; return [...ledger].reverse().map((l) => {
                const editing = editRow === l.id;
                const row = (
                  <tr key={l.id} style={{ background: editing ? PAL.mintPale : "transparent" }}>
                    <td style={{ ...td, color: PAL.mute, whiteSpace: "nowrap" }}>{fmtShort(new Date(l.date + "T12:00:00"))}{l.ts ? <span style={{ fontSize: 12 }}> {fmtTime(l.ts)}</span> : null}</td>
                    <td style={td}><Pill color={(TYPES[l.type] || TYPES.adjust).color}>{(TYPES[l.type] || TYPES.adjust).label}</Pill></td>
                    <td style={{ ...td, color: PAL.mute }}>
                      {editing ? <input value={editVals.note} onChange={(e) => setEditVals({ ...editVals, note: e.target.value })} style={{ ...STY.input, padding: "4px 8px" }} /> : l.note}
                    </td>
                    <td style={num}>{l.qty || "—"}</td>
                    <td style={{ ...num, fontWeight: 800, color: l.grams > 0 ? PAL.mintDeep : PAL.coral }}>
                      {editing
                        ? <input type="number" value={editVals.grams} onChange={(e) => setEditVals({ ...editVals, grams: e.target.value })} style={{ ...STY.input, width: 90, padding: "4px 8px", textAlign: "right", fontWeight: 700 }} />
                        : <>{l.grams > 0 ? "+" : ""}{l.grams}</>}
                    </td>
                    <td style={{ ...num, fontWeight: 700 }}>{bal}</td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      {editing
                        ? <span className="flex gap-1 justify-end"><Btn small onClick={saveEdit}>ОК</Btn><Btn small tone="ghost" onClick={() => setEditRow(null)}>Отмена</Btn></span>
                        : <span className="flex gap-1 justify-end"><Btn small tone="ghost" onClick={() => startEdit(l)}>Изм.</Btn><Btn small tone="coral" onClick={() => remove(l.id)}>×</Btn></span>}
                    </td>
                  </tr>);
                bal -= l.grams; return row;
              }); })()}
              {ledger.length === 0 && <tr><td colSpan={7} style={{ padding: 20, textAlign: "center", color: PAL.mute }}>Пока пусто</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
