import { useState, useMemo, useEffect, useRef } from "react";
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
  mute: "#6B8A84", line: "#D5EAE3", panel: "#0E2F2B", panelText: "#FFFFFF", lowBg: "#FFF3F0", cellBg: "rgba(255,255,255,.7)",
};
const DARK = {
  ink: "#E6F4EF", mint: "#2BD7AB", mintDeep: "#5FE3C0", mintPale: "#173A33",
  paper: "#0B1613", white: "#132621", coral: "#FF7A62", sun: "#FFC857", sky: "#5CA3FF", lilac: "#A98CFF",
  mute: "#7FA39B", line: "#1F3A34", panel: "#061B17", panelText: "#E6F4EF", lowBg: "#3A1F1A", cellBg: "rgba(0,0,0,.25)",
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
        const s = await api("PUT", "/api/state", { version: versionRef.current, employees, roster: shifts, prices, bowlGrams, shift, closedShifts, ledger });
        versionRef.current = s.version; dirtyRef.current = false;
      } catch (e) {
        if (e.status === 409 && e.data) { applyState(e.data); setToast("Данные обновились из бота"); dirtyRef.current = false; }
        else setToast("Не сохранилось: " + e.message);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [employees, shifts, prices, bowlGrams, shift, closedShifts, ledger]);

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
          ? <TobaccoView setToast={setToast} ledger={ledger} setLedger={setLedger} />
          : <StaffView employees={employees} setEmployees={setEmployees} shifts={shifts} setShifts={setShifts} setToast={setToast}
              prices={prices} setPrices={setPrices} shift={shift} setShift={setShift} closedShifts={closedShifts} setClosedShifts={setClosedShifts}
              setLedger={setLedger} bowlGrams={bowlGrams} setBowlGrams={setBowlGrams} />}
      </main>

      {toast && (
        <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", background: PAL.panel, color: PAL.panelText, padding: "10px 18px", borderRadius: 12, fontWeight: 600, fontSize: 14, boxShadow: "0 8px 30px rgba(14,47,43,.25)" }}>{toast}</div>
      )}
    </div>
  );
}


// ---------- шахматка занятости смен ----------
function Heatmap({ shifts, empById, weeks = 6 }) {
  const [hover, setHover] = useState(null);
  const start = addDays(mondayOf(TODAY), -(weeks - 2) * 7);
  const cols = Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i)));
  const LEV = [
    { bg: PAL.lowBg, br: PAL.line, label: "никого" },
    { bg: PAL.sun, br: PAL.sun, label: "одна смена" },
    { bg: PAL.mint, br: PAL.mintDeep, label: "обе смены" },
  ];
  const info = (d) => {
    const key = iso(d);
    const a = empById[shifts[`${key}|day`]], b = empById[shifts[`${key}|night`]];
    return { n: (a ? 1 : 0) + (b ? 1 : 0), a, b, key };
  };
  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 5, overflowX: "auto", paddingBottom: 4 }}>
        <div style={{ display: "grid", gridTemplateRows: "repeat(7, 22px)", gap: 5, marginRight: 2 }}>
          {DAYS_RU.map((d) => <div key={d} style={{ fontSize: 11, color: PAL.mute, lineHeight: "22px", fontWeight: 600 }}>{d}</div>)}
        </div>
        {cols.map((week, wi) => (
          <div key={wi} style={{ display: "grid", gridTemplateRows: "repeat(7, 22px)", gap: 5 }}>
            {week.map((d) => {
              const { n } = info(d);
              const today = iso(d) === iso(TODAY);
              return (
                <div key={iso(d)}
                  onMouseEnter={() => setHover(iso(d))} onMouseLeave={() => setHover(null)} onClick={() => setHover(iso(d))}
                  style={{ width: 22, height: 22, borderRadius: 6, background: LEV[n].bg, border: today ? `2px solid ${PAL.ink}` : `1px solid ${LEV[n].br}`, cursor: "default" }} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 10, fontSize: 12, color: PAL.mute }}>
        {LEV.map((l, i) => (
          <span key={i} className="flex items-center gap-1"><span style={{ width: 12, height: 12, borderRadius: 4, background: l.bg, border: `1px solid ${l.br}`, display: "inline-block" }} />{l.label}</span>
        ))}
        <span style={{ marginLeft: "auto" }}>{hover ? "" : "наведи на квадрат"}</span>
      </div>
      {hover && (() => {
        const d = new Date(hover + "T12:00:00"); const { a, b } = info(d);
        return (
          <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 10, background: PAL.mintPale, fontSize: 13 }}>
            <b>{DAYS_RU[(d.getDay() + 6) % 7]}, {fmtShort(d)}</b>
            <span style={{ marginLeft: 10 }}>1-я: {a ? a.name : <span style={{ color: PAL.coral }}>никого</span>}</span>
            <span style={{ marginLeft: 12 }}>2-я: {b ? b.name : <span style={{ color: PAL.coral }}>никого</span>}</span>
          </div>
        );
      })()}
    </div>
  );
}

// ====================================================================
function StaffView({ employees, setEmployees, shifts, setShifts, setToast, prices, setPrices, shift, setShift, closedShifts, setClosedShifts, setLedger, bowlGrams, setBowlGrams }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [newName, setNewName] = useState("");
  const [count, setCount] = useState(employees.length);

  const monday = addDays(mondayOf(TODAY), weekOffset * 7);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const SHIFTS = [["day", "1-я смена", "11:00–23:00"], ["night", "2-я смена", "16:00–02:00"]];
  const shiftHours = (kind, d) => kind === "day" ? "11:00–23:00" : ([5, 6].includes(d.getDay()) ? "16:00–04:00" : "16:00–02:00");

  const empById = Object.fromEntries(employees.map((e) => [e.id, e]));
  const setCell = (day, kind, empId) => setShifts((s) => ({ ...s, [`${day}|${kind}`]: empId || undefined }));

  const addEmployee = () => {
    if (!newName.trim()) return;
    setEmployees((es) => [...es, { id: "e" + Date.now(), name: newName.trim(), color: EMP_COLORS[es.length % EMP_COLORS.length] }]);
    setNewName(""); setToast("Сотрудник добавлен");
  };
  const removeEmployee = (id) => {
    setEmployees((es) => es.filter((e) => e.id !== id));
    setShifts((s) => { const n = { ...s }; Object.keys(n).forEach((k) => { if (n[k] === id) delete n[k]; }); return n; });
  };
  const applyCount = () => {
    const n = Math.max(1, Math.min(20, Number(count) || 1));
    setEmployees((es) => {
      if (n <= es.length) return es.slice(0, n);
      const add = Array.from({ length: n - es.length }, (_, i) => ({ id: "e" + Date.now() + i, name: `Сотрудник ${es.length + i + 1}`, color: EMP_COLORS[(es.length + i) % EMP_COLORS.length] }));
      return [...es, ...add];
    });
    setToast(`Штат: ${n}`);
  };
  const renameEmployee = (id, name) => setEmployees((es) => es.map((e) => (e.id === id ? { ...e, name } : e)));

  const weekKeys = days.flatMap((d) => SHIFTS.map(([k]) => `${iso(d)}|${k}`));
  const weekStats = employees.map((e) => ({ name: e.name, color: e.color, смены: weekKeys.filter((k) => shifts[k] === e.id).length }));
  const empty = weekKeys.filter((k) => !shifts[k]).length;

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

  const isToday = (d) => iso(d) === iso(TODAY);

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}>
      {/* ---- текущая смена ---- */}
      <ShiftPanel employees={employees} prices={prices} setPrices={setPrices} shift={shift} setShift={setShift} closedShifts={closedShifts} setClosedShifts={setClosedShifts} setToast={setToast} shiftHours={shiftHours} setLedger={setLedger} bowlGrams={bowlGrams} setBowlGrams={setBowlGrams} />

      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <Pill color={PAL.mint}>{employees.length} в штате</Pill>
        <Pill color={empty ? PAL.coral : PAL.sky}>{empty ? `${empty} смен без сотрудника` : "все смены закрыты"}</Pill>
      </div>

      <Card style={{ gridColumn: "span 12" }} title="Занятость смен" aside={<span style={{ fontSize: 12, color: PAL.mute }}>6 недель · строки — дни недели</span>}>
        <Heatmap shifts={shifts} empById={empById} />
      </Card>

      {/* график недели */}
      <Card style={{ gridColumn: "span 12" }}
        title={`Неделя ${fmtShort(days[0])} — ${fmtShort(days[6])}`}
        aside={<div className="flex gap-2"><Btn small tone="ghost" onClick={() => setWeekOffset((w) => w - 1)}>← пред.</Btn><Btn small tone="ghost" onClick={() => setWeekOffset(0)}>Сегодня</Btn><Btn small tone="ghost" onClick={() => setWeekOffset((w) => w + 1)}>след. →</Btn></div>}>
        <div style={{ overflowX: "auto" }}>
          <div className="grid gap-2" style={{ gridTemplateColumns: "110px repeat(7, minmax(120px, 1fr))", minWidth: 960 }}>
            <div />
            {days.map((d, i) => (
              <div key={i} style={{ textAlign: "center", padding: "6px 0", borderRadius: 10, background: isToday(d) ? PAL.panel : "transparent", color: isToday(d) ? PAL.panelText : PAL.ink }}>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{DAYS_RU[i]}</div>
                <div style={{ fontSize: 12, color: isToday(d) ? PAL.mintPale : PAL.mute }}>{fmtShort(d)}</div>
              </div>
            ))}
            {SHIFTS.map(([kind, label, hours]) => (
              <>
                <div key={kind} style={{ alignSelf: "center" }}>
                  <div style={{ fontWeight: 700 }}>{label}</div>
                  <div style={{ fontSize: 12, color: PAL.mute }}>{kind === "day" ? hours : "16:00–02:00, пт/сб до 04:00"}</div>
                </div>
                {days.map((d) => {
                  const key = `${iso(d)}|${kind}`; const e = empById[shifts[key]];
                  return (
                    <div key={key} style={{ borderRadius: 12, padding: 6, background: e ? e.color + "22" : PAL.paper, border: `1.5px ${e ? "solid " + e.color : "dashed " + PAL.line}`, minHeight: 58, display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 }}>
                      {e && <div style={{ fontWeight: 800, fontSize: 14, textAlign: "center" }}>{e.name}</div>}
                      <select value={shifts[key] || ""} onChange={(ev) => setCell(iso(d), kind, ev.target.value)}
                        style={{ ...STY.input, padding: "4px 6px", fontSize: 12, background: PAL.cellBg, border: "none", textAlign: "center", color: e ? PAL.mute : PAL.ink }}>
                        <option value="">{e ? "заменить…" : "назначить…"}</option>
                        {employees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    </div>
                  );
                })}
              </>
            ))}
          </div>
        </div>
      </Card>

      {/* штат */}
      <Card title="Штат" style={{ gridColumn: "span 5" }}>
        <div className="flex gap-2 mb-3 items-center">
          <span style={{ fontSize: 13, color: PAL.mute, whiteSpace: "nowrap" }}>Сколько сотрудников</span>
          <input type="number" min={1} max={20} value={count} onChange={(e) => setCount(e.target.value)} style={{ ...STY.input, width: 70 }} />
          <Btn small tone="ink" onClick={applyCount}>Применить</Btn>
        </div>
        <div className="flex flex-col gap-2">
          {employees.map((e) => (
            <div key={e.id} className="flex items-center gap-2">
              <span style={{ width: 12, height: 12, borderRadius: 6, background: e.color, flexShrink: 0 }} />
              <input value={e.name} onChange={(ev) => renameEmployee(e.id, ev.target.value)} style={{ ...STY.input, fontWeight: 600 }} />
              <Btn small tone="coral" onClick={() => removeEmployee(e.id)}>×</Btn>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-3">
          <input placeholder="Имя нового сотрудника" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addEmployee()} style={STY.input} />
          <Btn onClick={addEmployee} disabled={!newName.trim()}>Добавить</Btn>
        </div>
      </Card>

      <Card title="Смены на этой неделе" style={{ gridColumn: "span 7" }}>
        <ResponsiveContainer width="100%" height={Math.max(160, employees.length * 36)}>
          <BarChart data={weekStats} layout="vertical" margin={{ left: 8, right: 30 }}>
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: PAL.mute }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 13, fill: PAL.ink, fontWeight: 600 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={STY.tip} />
            <Bar dataKey="смены" radius={[0, 8, 8, 0]} isAnimationActive={false}>
              {weekStats.map((d, i) => <Cell key={i} fill={d.color} />)}
              <LabelList dataKey="смены" position="right" style={{ fontSize: 12, fill: PAL.ink, fontWeight: 700 }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <ShiftStats employees={employees} closedShifts={closedShifts} shift={shift} />

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
    </div>
  );
}

// ====================================================================
const KINDS = [["regular", "Обычный"], ["premium", "Премиум"], ["electro", "Электронный"]];
const DISCOUNTS = [0, 10, 15, 20, 30];
const fmtMoney = (n) => n.toLocaleString("ru-RU") + " ₽";
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

function ShiftPanel({ employees, prices, setPrices, shift, setShift, closedShifts, setClosedShifts, setToast, shiftHours, setLedger, bowlGrams, setBowlGrams }) {
  const [kind, setKind] = useState("regular");
  const [disc, setDisc] = useState(0);
  const [who, setWho] = useState(employees[0]?.id || "");
  const [which, setWhich] = useState(new Date().getHours() < 16 ? "day" : "night");
  const [editPrices, setEditPrices] = useState(false);
  const [grams, setGrams] = useState(bowlGrams.regular);
  const pickKind = (k) => { setKind(k); setGrams(bowlGrams[k]); };

  const price = Math.round(prices[kind] * (1 - disc / 100));
  const openShift = () => { setShift({ openedAt: Date.now(), kind: which, empId: who, sales: [] }); setToast("Смена открыта"); };
  const closeShift = () => {
    setClosedShifts((cs) => [{ ...shift, closedAt: Date.now() }, ...cs]);
    setShift(null); setToast(`Смена закрыта: ${fmtMoney(total)}`);
  };
  const sell = () => {
    const id = "s" + Date.now(); const g = Number(grams) || 0;
    setShift((s) => ({ ...s, sales: [{ id, ts: Date.now(), kind, disc, price, grams: g }, ...s.sales] }));
    if (g > 0 && setLedger) setLedger((L) => [...L, { id: "sh" + id, date: iso(TODAY), type: "sale", qty: 1, grams: -g, note: `смена: ${KINDS.find((k) => k[0] === kind)[1].toLowerCase()}` }]);
    setToast(`${KINDS.find((k) => k[0] === kind)[1]} — ${fmtMoney(price)}${g ? `, −${g} г` : ""}`); setDisc(0);
  };
  const undo = (id) => { setShift((s) => ({ ...s, sales: s.sales.filter((x) => x.id !== id) })); if (setLedger) setLedger((L) => L.filter((l) => l.id !== "sh" + id)); };
  const gramsTotal = (shift?.sales || []).reduce((s, x) => s + (x.grams || 0), 0);

  const sales = shift?.sales || [];
  const total = sales.reduce((s, x) => s + x.price, 0);
  const counts = Object.fromEntries(KINDS.map(([k]) => [k, sales.filter((x) => x.kind === k).length]));
  const discounted = sales.filter((x) => x.disc).length;
  const emp = employees.find((e) => e.id === shift?.empId);
  const last = closedShifts[0];

  const kindBtn = (active, color) => ({ border: `2px solid ${active ? color : PAL.line}`, background: active ? color + "22" : PAL.white, color: PAL.ink, borderRadius: 12, padding: "12px 10px", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", textAlign: "center" });

  return (
    <section style={{ gridColumn: "1 / -1", background: PAL.panel, borderRadius: 22, padding: "22px 24px", color: PAL.panelText }}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div style={{ fontSize: 13, color: PAL.mintPale, opacity: .8 }}>Текущая смена</div>
          {shift ? (
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5 }}>
              {shift.kind === "day" ? "1-я смена" : "2-я смена"} · {emp?.name || "—"}
              <span style={{ fontSize: 14, fontWeight: 600, color: PAL.mintPale, marginLeft: 10 }}>открыта в {fmtTime(shift.openedAt)} · {shiftHours(shift.kind, new Date(shift.openedAt))}</span>
            </div>
          ) : (
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, color: PAL.mintPale }}>Смена не открыта</div>
          )}
        </div>
        {shift ? (
          <div className="flex items-center gap-4">
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, color: PAL.mintPale, opacity: .8 }}>Касса за смену</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: PAL.mint, letterSpacing: -0.5 }}>{fmtMoney(total)}</div>
            </div>
            <Btn tone="coral" onClick={closeShift}>Закрыть смену</Btn>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select value={which} onChange={(e) => setWhich(e.target.value)} style={{ ...STY.input, width: "auto" }}>
              <option value="day">1-я смена, 11:00–23:00</option>
              <option value="night">2-я смена, 16:00–{[5, 6].includes(new Date().getDay()) ? "04:00" : "02:00"}</option>
            </select>
            <select value={who} onChange={(e) => setWho(e.target.value)} style={{ ...STY.input, width: "auto" }}>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <Btn onClick={openShift} disabled={!who}>Открыть смену</Btn>
          </div>
        )}
      </div>

      {shift && (
        <div className="grid gap-4 mt-5" style={{ gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)" }}>
          <div style={{ background: "rgba(255,255,255,.06)", borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 13, color: PAL.mintPale, marginBottom: 8 }}>Кальян</div>
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              {KINDS.map(([k, l], i) => (
                <button key={k} onClick={() => pickKind(k)} style={kindBtn(kind === k, [PAL.mint, PAL.sun, PAL.sky][i])}>
                  {l}<div style={{ fontSize: 12, fontWeight: 600, color: PAL.mute, marginTop: 2 }}>{fmtMoney(prices[k])}</div>
                </button>
              ))}
            </div>
            <div style={{ fontSize: 13, color: PAL.mintPale, margin: "12px 0 8px" }}>Скидка</div>
            <div className="flex flex-wrap gap-2">
              {DISCOUNTS.map((d) => (
                <button key={d} onClick={() => setDisc(d)} style={{ border: "none", borderRadius: 999, padding: "7px 14px", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit", background: disc === d ? PAL.lilac : "rgba(255,255,255,.1)", color: PAL.panelText }}>
                  {d ? `−${d}%` : "без скидки"}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between mt-4 gap-3 flex-wrap">
              <label className="flex items-center gap-2" style={{ fontSize: 13, color: PAL.mintPale }}>
                Табака в чаше
                <input type="number" min={0} value={grams} onChange={(e) => setGrams(e.target.value)} style={{ ...STY.input, width: 70, padding: "5px 8px", fontWeight: 800 }} /> г
              </label>
              <div>
                <span style={{ fontSize: 13, color: PAL.mintPale }}>К оплате </span>
                <span style={{ fontSize: 26, fontWeight: 800, color: PAL.mint }}>{fmtMoney(price)}</span>
                {disc > 0 && <span style={{ fontSize: 13, color: PAL.mute, marginLeft: 8, textDecoration: "line-through" }}>{fmtMoney(prices[kind])}</span>}
              </div>
              <Btn onClick={sell}>Пробить кальян</Btn>
            </div>
          </div>

          <div style={{ background: "rgba(255,255,255,.06)", borderRadius: 16, padding: 16, display: "flex", flexDirection: "column" }}>
            <div className="flex justify-between items-baseline">
              <div style={{ fontSize: 13, color: PAL.mintPale }}>За смену</div>
              <div style={{ fontSize: 12, color: PAL.mute }}>{sales.length} шт · со скидкой {discounted} · <b style={{ color: PAL.mint }}>{gramsTotal} г</b> табака</div>
            </div>
            <div className="grid gap-2 mt-2" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              {KINDS.map(([k, l], i) => (
                <div key={k} style={{ borderRadius: 10, padding: "8px 10px", background: "rgba(255,255,255,.05)", borderLeft: `3px solid ${[PAL.mint, PAL.sun, PAL.sky][i]}` }}>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{counts[k]}</div>
                  <div style={{ fontSize: 12, color: PAL.mintPale }}>{l.toLowerCase()}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, maxHeight: 150, overflowY: "auto", flex: 1 }}>
              {sales.length === 0 && <div style={{ fontSize: 13, color: PAL.mute, padding: "10px 0" }}>Пока ни одного кальяна — выбери тип слева и пробей.</div>}
              {sales.map((s) => (
                <div key={s.id} className="flex items-center gap-2" style={{ fontSize: 13, padding: "5px 0", borderTop: "1px solid rgba(255,255,255,.08)" }}>
                  <span style={{ color: PAL.mute, width: 44 }}>{fmtTime(s.ts)}</span>
                  <span style={{ fontWeight: 700, flex: 1 }}>{KINDS.find((k) => k[0] === s.kind)[1]}{s.disc ? <span style={{ color: PAL.lilac }}> −{s.disc}%</span> : null}{s.grams ? <span style={{ color: PAL.mute, fontWeight: 500 }}> · {s.grams} г</span> : null}</span>
                  <span style={{ fontWeight: 800 }}>{fmtMoney(s.price)}</span>
                  <button onClick={() => undo(s.id)} title="отменить" style={{ border: "none", background: "transparent", color: PAL.coral, cursor: "pointer", fontWeight: 800, fontSize: 15 }}>×</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 mt-4" style={{ fontSize: 13, color: PAL.mintPale }}>
        <div>
          {last ? <>Прошлая смена: {employees.find((e) => e.id === last.empId)?.name || "—"}, {fmtTime(last.openedAt)}–{fmtTime(last.closedAt)}, {last.sales.length} кальянов, {last.sales.reduce((s, x) => s + (x.grams || 0), 0)} г табака, <b style={{ color: PAL.panelText }}>{fmtMoney(last.sales.reduce((s, x) => s + x.price, 0))}</b></> : "Закрытых смен пока нет"}
        </div>
        <div className="flex items-center gap-2">
          {editPrices ? (
            <>
              {KINDS.map(([k, l]) => (
                <label key={k} className="flex items-center gap-1">
                  <span>{l}</span>
                  <input type="number" step={50} value={prices[k]} onChange={(e) => setPrices({ ...prices, [k]: Number(e.target.value) })} style={{ ...STY.input, width: 80, padding: "4px 6px", fontSize: 13 }} />₽
                  <input type="number" value={bowlGrams[k]} onChange={(e) => setBowlGrams({ ...bowlGrams, [k]: Number(e.target.value) })} style={{ ...STY.input, width: 56, padding: "4px 6px", fontSize: 13 }} />г
                </label>
              ))}
              <Btn small onClick={() => setEditPrices(false)}>Готово</Btn>
            </>
          ) : (
            <button onClick={() => setEditPrices(true)} style={{ border: "none", background: "transparent", color: PAL.mintPale, cursor: "pointer", fontFamily: "inherit", fontSize: 13, textDecoration: "underline" }}>Цены и граммовки</button>
          )}
        </div>
      </div>
    </section>
  );
}

// ====================================================================
function ShiftStats({ employees, closedShifts, shift }) {
  const [range, setRange] = useState(14);
  const nameOf = (id) => employees.find((e) => e.id === id)?.name || "—";
  const all = shift ? [{ ...shift, open: true }, ...closedShifts] : closedShifts;

  const days = useMemo(() => {
    const out = [];
    for (let d = range - 1; d >= 0; d--) {
      const date = addDays(TODAY, -d); const key = iso(date);
      const row = { key, date, label: fmtShort(date), wd: DAYS_RU[(date.getDay() + 6) % 7] };
      ["day", "night"].forEach((k) => {
        const s = all.find((x) => x.kind === k && iso(new Date(x.openedAt)) === key);
        row[k] = s ? { who: nameOf(s.empId), n: s.sales.length, sum: s.sales.reduce((a, x) => a + x.price, 0), open: s.open } : null;
      });
      row.n = (row.day?.n || 0) + (row.night?.n || 0);
      row.sum = (row.day?.sum || 0) + (row.night?.sum || 0);
      out.push(row);
    }
    return out;
  }, [all, range, employees]);

  const chart = days.map((r) => ({ label: r.label, "1-я смена": r.day?.n || 0, "2-я смена": r.night?.n || 0, sum: r.sum }));
  const tot = days.reduce((a, r) => ({ n: a.n + r.n, sum: a.sum + r.sum, d: a.d + (r.day?.n || 0), nt: a.nt + (r.night?.n || 0) }), { n: 0, sum: 0, d: 0, nt: 0 });
  const worked = days.filter((r) => r.n).length || 1;

  const th = { padding: "8px 8px", fontWeight: 600, fontSize: 12, color: PAL.mute, textAlign: "left", whiteSpace: "nowrap" };
  const td = { padding: "8px 8px", borderTop: `1px solid ${PAL.line}`, fontSize: 13, verticalAlign: "middle" };
  const num = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const cell = (s) => s ? (
    <>
      <td style={td}>{s.who}{s.open && <span style={{ color: PAL.mint, fontWeight: 700 }}> · идёт</span>}</td>
      <td style={{ ...num, fontWeight: 700 }}>{s.n}</td>
      <td style={{ ...num, color: PAL.mute }}>{fmtMoney(s.sum)}</td>
    </>
  ) : <><td style={{ ...td, color: PAL.mute }}>—</td><td style={num} /><td style={num} /></>;

  return (
    <Card style={{ gridColumn: "span 12" }} title="Кальяны по дням и сменам"
      aside={<div className="flex gap-1">{[7, 14, 30].map((n) => <button key={n} onClick={() => setRange(n)} style={{ border: "none", borderRadius: 8, padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: range === n ? PAL.panel : PAL.paper, color: range === n ? PAL.panelText : PAL.mute }}>{n} дней</button>)}</div>}>
      <div className="flex flex-wrap gap-2 mb-3">
        <Pill color={PAL.mint}>{tot.n} кальянов · {fmtMoney(tot.sum)}</Pill>
        <Pill color={PAL.sun}>1-я смена: {tot.d}</Pill>
        <Pill color={PAL.ink}>2-я смена: {tot.nt}</Pill>
        <Pill color={PAL.sky}>в среднем {Math.round(tot.n / worked)} в день</Pill>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chart} margin={{ left: -10, right: 10, top: 16 }}>
          <CartesianGrid vertical={false} stroke={PAL.line} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: PAL.mute }} axisLine={false} tickLine={false} interval={range > 14 ? 2 : 0} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: PAL.mute }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={STY.tip} formatter={(v, n, p) => [v, n]} labelFormatter={(l, p) => `${l} · ${fmtMoney(p?.[0]?.payload?.sum || 0)}`} />
          <Bar dataKey="1-я смена" stackId="a" fill={PAL.sun} isAnimationActive={false} />
          <Bar dataKey="2-я смена" stackId="a" fill={PAL.ink} radius={[6, 6, 0, 0]} isAnimationActive={false}>
            <LabelList dataKey={(d) => d["1-я смена"] + d["2-я смена"] || ""} position="top" style={{ fontSize: 11, fill: PAL.ink, fontWeight: 700 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto", marginTop: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
          <thead><tr>
            <th style={th}>День</th>
            <th style={{ ...th, borderLeft: `2px solid ${PAL.sun}` }}>1-я смена</th><th style={{ ...th, textAlign: "right" }}>шт</th><th style={{ ...th, textAlign: "right" }}>касса</th>
            <th style={{ ...th, borderLeft: `2px solid ${PAL.ink}` }}>2-я смена</th><th style={{ ...th, textAlign: "right" }}>шт</th><th style={{ ...th, textAlign: "right" }}>касса</th>
            <th style={{ ...th, textAlign: "right" }}>Итого шт</th><th style={{ ...th, textAlign: "right" }}>Итого касса</th>
          </tr></thead>
          <tbody>
            {[...days].reverse().map((r) => (
              <tr key={r.key} style={{ background: r.key === iso(TODAY) ? PAL.mintPale : "transparent" }}>
                <td style={{ ...td, fontWeight: 700, whiteSpace: "nowrap" }}>{r.wd}, {r.label}</td>
                {cell(r.day)}{cell(r.night)}
                <td style={{ ...num, fontWeight: 800 }}>{r.n || "—"}</td>
                <td style={{ ...num, fontWeight: 800, color: PAL.mintDeep }}>{r.sum ? fmtMoney(r.sum) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}


// ====================================================================
const TYPES = {
  supply: { label: "Поставка", color: "#19C39A" },
  sale: { label: "Продажа", color: "#3A8DFF" },
  writeoff: { label: "Списание", color: "#F2634A" },
  adjust: { label: "Корректировка", color: "#8E6CF2" },
};
const BOWLS = [["regular", "Обычный", 22], ["fruit", "Фрукты", 30]];

function TobaccoView({ setToast, ledger, setLedger }) {
  const [supply, setSupply] = useState({ grams: "", note: "" });
  const [sale, setSale] = useState({ kind: "regular", qty: 1 });
  const [wo, setWo] = useState({ kind: "regular", qty: 1, note: "" });
  const [range, setRange] = useState(14);
  const [editStock, setEditStock] = useState(null);
  const [clearAsk, setClearAsk] = useState(false);
  const fileRef = useRef();
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(null);
  const [fileMode, setFileMode] = useState("add"); // add | replace

  const stock = ledger.reduce((s, l) => s + l.grams, 0);
  const add = (entry) => setLedger((L) => [...L, { id: "l" + Date.now() + Math.random().toString(16).slice(2, 5), date: iso(TODAY), ts: Date.now(), ...entry }]);
  const remove = (id) => setLedger((L) => L.filter((l) => l.id !== id));
  const bowlG = (k) => BOWLS.find((b) => b[0] === k)[2];

  const doSupply = () => { const g = Number(supply.grams); if (!(g > 0)) return; add({ type: "supply", grams: g, note: supply.note || "поставка" }); setSupply({ grams: "", note: "" }); setToast(`+${g} г на склад`); };
  const doSale = () => { const q = Number(sale.qty); if (!(q > 0)) return; const g = q * bowlG(sale.kind); add({ type: "sale", kind: sale.kind, qty: q, grams: -g, note: BOWLS.find((b) => b[0] === sale.kind)[1].toLowerCase() }); setSale({ ...sale, qty: 1 }); setToast(`Продано ${q} шт, −${g} г`); };
  const doWo = () => { const q = Number(wo.qty); if (!(q > 0)) return; const g = q * bowlG(wo.kind); add({ type: "writeoff", kind: wo.kind, qty: q, grams: -g, note: wo.note || "списание" }); setWo({ ...wo, qty: 1, note: "" }); setToast(`Списано ${q} шт, −${g} г`); };
  const commitStock = () => { const diff = Math.max(0, Number(editStock) || 0) - stock; if (diff) { add({ type: "adjust", grams: diff, note: "ручная правка остатка" }); setToast(`Остаток: ${diff > 0 ? "+" : ""}${diff} г`); } setEditStock(null); };
  const clearStock = () => { if (stock) add({ type: "adjust", grams: -stock, note: "очистка склада" }); setClearAsk(false); setToast("Склад обнулён"); };

  // график: остаток по дням
  const chart = useMemo(() => {
    const out = []; const start = iso(addDays(TODAY, -(range - 1)));
    let bal = ledger.filter((l) => l.date < start).reduce((s, l) => s + l.grams, 0);
    for (let d = range - 1; d >= 0; d--) {
      const key = iso(addDays(TODAY, -d)); const ls = ledger.filter((l) => l.date === key);
      bal += ls.reduce((s, l) => s + l.grams, 0);
      out.push({ label: fmtShort(addDays(TODAY, -d)), остаток: bal, продано: -ls.filter((l) => l.type === "sale").reduce((s, l) => s + l.grams, 0) });
    }
    return out;
  }, [ledger, range]);
  const soldRange = chart.reduce((s, r) => s + r.продано, 0);
  const daysLeft = soldRange ? Math.round(stock / (soldRange / range)) : null;
  const todaySold = ledger.filter((l) => l.type === "sale" && l.date === iso(TODAY)).reduce((s, l) => s + (l.qty || 0), 0);

  // распознавание файла: модель выписывает каждую строку, сумму считаем сами
  const [fileErr, setFileErr] = useState("");
  const readB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });
  const toJpeg = (file) => new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { const k = Math.min(1, 2200 / Math.max(img.width, img.height)); const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg", .92).split(",")[1]); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("не удалось открыть картинку")); };
    img.src = url;
  });
  const onFile = async (e) => {
    const file = e.target.files?.[0]; if (!file) return; setBusy(true); setFound(null); setFileErr("");
    try {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const data = isPdf ? await readB64(file) : await toJpeg(file);
      const mediaType = isPdf ? "application/pdf" : "image/jpeg";
      const m = await api("POST", "/api/recognize", { base64: data, mediaType });
      const items = m.items;
      setFound({ items, docTotal: m.document_total ? Number(m.document_total) : null, name: file.name, open: false });
    } catch (ex) { setFileErr("Не удалось распознать: " + (ex.message || ex)); }
    setBusy(false); e.target.value = "";
  };
  const foundTotal = found ? found.items.reduce((s, it) => s + (Number(it.grams) || 0), 0) : 0;
  const setFoundItem = (id, grams) => setFound((f) => ({ ...f, items: f.items.map((it) => (it.id === id ? { ...it, grams: Number(grams) || 0 } : it)) }));
  const dropFoundItem = (id) => setFound((f) => ({ ...f, items: f.items.filter((it) => it.id !== id) }));

  const th = { padding: "8px 8px", fontWeight: 600, fontSize: 12, color: PAL.mute, textAlign: "left", whiteSpace: "nowrap" };
  const td = { padding: "9px 8px", borderTop: `1px solid ${PAL.line}`, fontSize: 14, verticalAlign: "middle" };
  const num = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const kindBtn = (active, color) => ({ border: `2px solid ${active ? color : PAL.line}`, background: active ? color + "22" : PAL.white, color: PAL.ink, borderRadius: 12, padding: "12px 10px", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", textAlign: "center", flex: 1 });
  const KindPick = ({ value, onChange }) => (
    <div className="flex gap-2">
      {BOWLS.map(([k, l, g], i) => <button key={k} onClick={() => onChange(k)} style={kindBtn(value === k, [PAL.sky, PAL.sun][i])}>{l}<div style={{ fontSize: 12, fontWeight: 600, color: PAL.mute, marginTop: 2 }}>{g} г</div></button>)}
    </div>
  );
  const QtyRow = ({ value, onChange, kind, onEnter }) => (
    <div className="flex items-center gap-2 mt-3">
      <input type="number" min={1} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onEnter()} style={{ ...STY.input, width: 90, fontSize: 20, fontWeight: 800, textAlign: "center" }} />
      <span style={{ fontSize: 14, color: PAL.mute }}>шт × {bowlG(kind)} г = <b style={{ color: PAL.ink }}>{(Number(value) || 0) * bowlG(kind)} г</b></span>
    </div>
  );

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}>
      {/* шапка: остаток + график */}
      <section style={{ gridColumn: "1 / -1", background: PAL.panel, color: PAL.panelText, borderRadius: 22, padding: "22px 24px" }}>
        <div className="grid gap-5" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr)" }}>
          <div>
            <div style={{ fontSize: 13, color: PAL.mintPale, opacity: .85 }}>Табака на складе</div>
            {editStock === null ? (
              <div style={{ fontSize: 56, fontWeight: 800, letterSpacing: -2, lineHeight: 1.05, color: PAL.mint, cursor: "text" }} title="Нажми, чтобы поправить" onClick={() => setEditStock(stock)}>
                {stock.toLocaleString("ru-RU")} <span style={{ fontSize: 22, color: PAL.mintPale, letterSpacing: 0 }}>г</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input autoFocus type="number" value={editStock} onChange={(e) => setEditStock(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commitStock(); if (e.key === "Escape") setEditStock(null); }} style={{ ...STY.input, width: 160, fontSize: 28, fontWeight: 800 }} />
                <Btn onClick={commitStock}>Сохранить</Btn><Btn tone="ghost" onClick={() => setEditStock(null)}>Отмена</Btn>
              </div>
            )}
            <div className="flex flex-wrap gap-2 mt-3">
              <Pill light color={PAL.sky}>сегодня продано {todaySold} шт</Pill>
              <Pill light color={PAL.mint}>за {range} дн. ушло {soldRange} г</Pill>
              {daysLeft !== null && <Pill light color={daysLeft < 5 ? PAL.coral : PAL.lilac}>хватит примерно на {daysLeft} дн.</Pill>}
            </div>
            <div className="flex flex-wrap gap-2 mt-4 items-center">
              {clearAsk
                ? <><span style={{ fontSize: 13, color: PAL.coral, fontWeight: 700 }}>Обнулить склад?</span><Btn small tone="coral" onClick={clearStock}>Да, обнулить</Btn><Btn small tone="ghost" onClick={() => setClearAsk(false)}>Нет</Btn></>
                : <button onClick={() => setClearAsk(true)} style={{ border: "none", background: "transparent", color: PAL.mintPale, cursor: "pointer", fontFamily: "inherit", fontSize: 13, textDecoration: "underline", padding: 0 }}>Очистить склад</button>}
            </div>
          </div>
          <div>
            <div className="flex justify-end gap-1 mb-1">
              {[7, 14, 30].map((n) => <button key={n} onClick={() => setRange(n)} style={{ border: "none", borderRadius: 8, padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: range === n ? PAL.mint : "rgba(255,255,255,.1)", color: range === n ? PAL.panel : PAL.mintPale }}>{n} дней</button>)}
            </div>
            <ResponsiveContainer width="100%" height={190}>
              <AreaChart data={chart} margin={{ left: -6, right: 6, top: 6 }}>
                <defs><linearGradient id="gstock" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={PAL.mint} stopOpacity={.6} /><stop offset="100%" stopColor={PAL.mint} stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,.08)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: PAL.mintPale }} axisLine={false} tickLine={false} interval={range > 14 ? 3 : 1} />
                <YAxis tick={{ fontSize: 11, fill: PAL.mintPale }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ ...STY.tip, background: PAL.white, color: PAL.ink }} formatter={(v) => `${v} г`} />
                <Area type="monotone" dataKey="остаток" stroke={PAL.mint} strokeWidth={2.5} fill="url(#gstock)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* поставка */}
      <Card title="Добавить табак" aside="вручную, в граммах" style={{ gridColumn: "span 4" }}>
        <div className="flex items-center gap-2">
          <input type="number" min={1} placeholder="0" value={supply.grams} onChange={(e) => setSupply({ ...supply, grams: e.target.value })} onKeyDown={(e) => e.key === "Enter" && doSupply()} style={{ ...STY.input, fontSize: 24, fontWeight: 800 }} />
          <span style={{ fontSize: 16, color: PAL.mute }}>г</span>
        </div>
        <div className="flex gap-2 mt-2 flex-wrap">
          {[250, 500, 1000].map((g) => <Btn key={g} small tone="ghost" onClick={() => setSupply({ ...supply, grams: String((Number(supply.grams) || 0) + g) })}>+{g}</Btn>)}
        </div>
        <input placeholder="Поставщик или комментарий" value={supply.note} onChange={(e) => setSupply({ ...supply, note: e.target.value })} style={{ ...STY.input, marginTop: 10 }} />
        <div className="mt-3"><Btn onClick={doSupply} disabled={!(Number(supply.grams) > 0)}>Добавить на склад</Btn></div>
      </Card>

      {/* продажа */}
      <Card title="Продажа кальянов" style={{ gridColumn: "span 4" }}>
        <KindPick value={sale.kind} onChange={(k) => setSale({ ...sale, kind: k })} />
        <QtyRow value={sale.qty} onChange={(v) => setSale({ ...sale, qty: v })} kind={sale.kind} onEnter={doSale} />
        <div className="flex gap-2 mt-2">
          {[1, 2, 5].map((n) => <Btn key={n} small tone="ghost" onClick={() => setSale({ ...sale, qty: String((Number(sale.qty) || 0) + n) })}>+{n}</Btn>)}
        </div>
        <div className="mt-3"><Btn onClick={doSale} disabled={!(Number(sale.qty) > 0)}>Продано — списать {(Number(sale.qty) || 0) * bowlG(sale.kind)} г</Btn></div>
      </Card>

      {/* списание */}
      <Card title="Списание" style={{ gridColumn: "span 4" }}>
        <KindPick value={wo.kind} onChange={(k) => setWo({ ...wo, kind: k })} />
        <QtyRow value={wo.qty} onChange={(v) => setWo({ ...wo, qty: v })} kind={wo.kind} onEnter={doWo} />
        <select value={wo.note} onChange={(e) => setWo({ ...wo, note: e.target.value })} style={{ ...STY.input, marginTop: 10 }}>
          <option value="">Причина…</option>
          {["перезабивка", "пересох", "брак", "дегустация", "проба для гостя", "другое"].map((r) => <option key={r}>{r}</option>)}
        </select>
        <div className="mt-3"><Btn tone="coral" onClick={doWo} disabled={!(Number(wo.qty) > 0)}>Списать {(Number(wo.qty) || 0) * bowlG(wo.kind)} г</Btn></div>
      </Card>

      {/* из файла */}
      <Card title="Из файла" aside="фото накладной, инвентаризационный лист или PDF" style={{ gridColumn: "span 12" }}>
        <div className="flex items-center gap-3 flex-wrap">
          <div style={{ display: "flex", background: PAL.paper, border: `1px solid ${PAL.line}`, borderRadius: 10, padding: 3, gap: 3 }}>
            {[["add", "Поставка — добавить к остатку"], ["replace", "Инвентаризация — заменить остаток"]].map(([k, l]) => (
              <button key={k} onClick={() => setFileMode(k)} style={{ border: "none", borderRadius: 8, padding: "6px 12px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", background: fileMode === k ? PAL.white : "transparent", color: fileMode === k ? PAL.ink : PAL.mute }}>{l}</button>
            ))}
          </div>
          <input ref={fileRef} type="file" accept="image/*,application/pdf" onChange={onFile} style={{ display: "none" }} />
          <Btn tone="ink" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? "Читаю файл…" : "Выбрать файл"}</Btn>
        </div>
        {fileErr && <div style={{ marginTop: 10, fontSize: 13, color: PAL.coral }}>{fileErr}. Попробуй другое фото — чтобы названия и цифры были в кадре и читались.</div>}
        {found && (
          <div className="mt-3" style={{ padding: "12px 14px", borderRadius: 12, background: PAL.mintPale, fontSize: 14 }}>
            <div className="flex items-center gap-3 flex-wrap">
              <span>В файле «{found.name}»: <b style={{ fontSize: 22 }}>{foundTotal} г</b> <span style={{ color: PAL.mute }}>({found.items.length} строк)</span>
                {fileMode === "add"
                  ? <span style={{ color: PAL.mute }}> · остаток станет <b style={{ color: PAL.ink }}>{stock + foundTotal} г</b></span>
                  : <span style={{ color: PAL.mute }}> · сейчас {stock} г, разница <b style={{ color: foundTotal - stock >= 0 ? PAL.mintDeep : PAL.coral }}>{foundTotal - stock > 0 ? "+" : ""}{foundTotal - stock} г</b></span>}
              </span>
              {fileMode === "add"
                ? <Btn onClick={() => { add({ type: "supply", grams: foundTotal, note: `накладная ${found.name}` }); setFound(null); setToast(`+${foundTotal} г на склад`); }} disabled={!foundTotal}>Добавить {foundTotal} г</Btn>
                : <Btn onClick={() => { const diff = foundTotal - stock; if (diff) add({ type: "adjust", grams: diff, note: `инвентаризация по файлу ${found.name}` }); setFound(null); setToast(`Остаток: ${foundTotal} г`); }}>Заменить остаток на {foundTotal} г</Btn>}
              <Btn tone="ghost" onClick={() => setFound((f) => ({ ...f, open: !f.open }))}>{found.open ? "Скрыть строки" : "Проверить строки"}</Btn>
              <Btn tone="ghost" onClick={() => setFound(null)}>Отмена</Btn>
            </div>
            {found.docTotal !== null && found.docTotal !== foundTotal && (
              <div style={{ marginTop: 8, fontSize: 13, color: PAL.coral, fontWeight: 600 }}>В документе напечатан итог {found.docTotal} г, по строкам получилось {foundTotal} г — проверь строки, что-то прочиталось неверно.
                <button onClick={() => setFound((f) => ({ ...f, items: [{ id: -1, name: "итог из документа", grams: f.docTotal, calc: "", assumed: false }], open: false }))} style={{ marginLeft: 8, border: "none", background: "transparent", color: PAL.mintDeep, cursor: "pointer", fontFamily: "inherit", fontWeight: 700, textDecoration: "underline" }}>Взять итог из документа</button>
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

      {/* журнал */}
      <Card title="Движения" aside={`${ledger.length} записей`} style={{ gridColumn: "span 12" }}>
        <div style={{ overflowX: "auto", maxHeight: 440, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
            <thead><tr><th style={th}>Дата</th><th style={th}>Операция</th><th style={th}>Что</th><th style={{ ...th, textAlign: "right" }}>Шт</th><th style={{ ...th, textAlign: "right" }}>Граммы</th><th style={{ ...th, textAlign: "right" }}>Остаток</th><th style={th} /></tr></thead>
            <tbody>
              {(() => { let bal = stock; return [...ledger].reverse().map((l) => { const row = (
                <tr key={l.id}>
                  <td style={{ ...td, color: PAL.mute, whiteSpace: "nowrap" }}>{fmtShort(new Date(l.date + "T12:00:00"))}{l.ts ? <span style={{ fontSize: 12 }}> {fmtTime(l.ts)}</span> : null}</td>
                  <td style={td}><Pill color={TYPES[l.type].color}>{TYPES[l.type].label}</Pill></td>
                  <td style={{ ...td, color: PAL.mute }}>{l.note}</td>
                  <td style={num}>{l.qty || "—"}</td>
                  <td style={{ ...num, fontWeight: 800, color: l.grams > 0 ? PAL.mintDeep : PAL.coral }}>{l.grams > 0 ? "+" : ""}{l.grams}</td>
                  <td style={{ ...num, fontWeight: 700 }}>{bal}</td>
                  <td style={{ ...td, textAlign: "right" }}><Btn small tone="coral" onClick={() => remove(l.id)}>×</Btn></td>
                </tr>); bal -= l.grams; return row; }); })()}
              {ledger.length === 0 && <tr><td colSpan={7} style={{ padding: 20, textAlign: "center", color: PAL.mute }}>Пока пусто — добавь табак</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
