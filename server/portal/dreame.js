"use strict";
// ZALET HOME — пылесос Dreame: статус, управление, расходники, история уборок (облако Dreamehome через роутер).

const drm = { timer: null, busy: false };
const drEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const drNotice = (t, bad) => { const n = $("#drNotice"); if (n) { n.textContent = t || ""; n.classList.toggle("bad", !!bad); } };

// состояния: что делает прямо сейчас
const DR_CLEANING = new Set([1, 7, 12, 25, 27, 38, 26]);
const DR_PAUSED = new Set([3, 21, 36, 99, 102, 106, 115]);
const DR_HOME = new Set([6, 13, 2, 8, 9, 22, 30, 34, 35, 29]);

function drHM(min) { min = Math.round(min || 0); const h = Math.floor(min / 60), m = min % 60; return h ? `${h} ч ${m} мин` : `${m} мин`; }
function drBattery(p, charging) {
  const col = p <= 20 ? "var(--danger)" : p <= 50 ? "var(--warn)" : "var(--live)";
  return `<div class="dr-batt"><div class="dr-batt-bar"><i style="width:${Math.max(3, p)}%;background:${col}"></i></div><b>${p}%</b>${charging ? '<span class="dr-bolt">⚡</span>' : ""}</div>`;
}

async function loadVacuum() {
  let j;
  try { j = await api("/api/home/dreame"); } catch (e) { drNotice(e.message, true); return; }
  const login = $("#drLogin"), main = $("#drMain");
  if (!j.configured) {
    login.classList.remove("hidden"); main.classList.add("hidden"); $("#drLogout").classList.add("hidden");
    drNotice(""); return;
  }
  login.classList.add("hidden"); $("#drLogout").classList.remove("hidden");
  const s = j.status;
  if (!s) {
    main.classList.add("hidden");
    drNotice(j.error ? `${j.error}` : "Загружаю…", !!j.error);
    if (j.error && /вход не удался|username|password|invalid/i.test(j.error)) { login.classList.remove("hidden"); }
    return;
  }
  main.classList.remove("hidden");
  drNotice(j.stale ? `Облако не отвечает — показано последнее состояние (${j.error || ""})` : "", !!j.stale);
  renderVacuum(s);
  loadVacuumHistory();
}

function renderVacuum(s) {
  const cleaning = DR_CLEANING.has(s.state), paused = DR_PAUSED.has(s.state), err = s.state === 4 || s.error > 0;
  const tone = err ? "bad" : cleaning ? "live" : "idle";
  $("#drHero").innerHTML = `
    <div class="dr-hero-top">
      <div><div class="mono-label">${drEsc(s.model || "DREAME")}</div><h3 class="display">${drEsc(s.name || "Пылесос")}</h3></div>
      <span class="dr-pill ${tone}">${err ? "⚠ " : cleaning ? '<i class="dr-dot"></i>' : ""}${drEsc(s.stateText)}${err && s.error > 0 ? ` · код ${s.error}` : ""}</span>
    </div>
    ${drBattery(s.battery, s.charging === 1)}
    ${cleaning || paused ? `<div class="dr-now"><div><b>${s.cleanArea >= 0 ? s.cleanArea : "—"}</b><span>м² убрано</span></div><div><b>${s.cleanMin >= 0 ? s.cleanMin : "—"}</b><span>минут</span></div></div>` : ""}`;
  const btn = (act, label, cls = "") => `<button class="btn ${cls}" data-dr="${act}">${label}</button>`;
  $("#drActions").innerHTML =
    (cleaning ? btn("pause", "⏸ Пауза") : paused ? btn("start", "▶ Продолжить", "btn-acc") : btn("start", "▶ Начать уборку", "btn-acc")) +
    ((cleaning || paused || s.state === 5) ? btn("dock", "⌂ На базу") : "") +
    ((cleaning || paused) ? btn("stop", "■ Стоп") : "") +
    btn("locate", "🔔 Найти");
  $$("[data-dr]", $("#drActions")).forEach((b) => b.onclick = () => drCmd(b.dataset.dr, b));
  const t = s.totals || {};
  $("#drCards").innerHTML =
    `<div class="card st-mini"><div class="mono-label">УБОРОК ВСЕГО</div><div class="st-big">${t.count >= 0 ? t.count : "—"}</div><div class="muted small">${t.first > 0 ? "с " + new Date(t.first * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : ""}</div></div>` +
    `<div class="card st-mini"><div class="mono-label">УБРАНО ВСЕГО</div><div class="st-big">${t.area >= 0 ? t.area : "—"} <small>м²</small></div><div class="muted small">за всё время</div></div>` +
    `<div class="card st-mini"><div class="mono-label">В РАБОТЕ</div><div class="st-big">${t.minutes >= 0 ? drHM(t.minutes) : "—"}</div><div class="muted small">суммарно</div></div>`;
  $("#drCons").innerHTML = (s.consumables || []).map((c) => {
    const col = c.pct <= 15 ? "var(--danger)" : c.pct <= 40 ? "var(--warn)" : "var(--live)";
    return `<div class="dr-cons"><span>${drEsc(c.name)}</span><div class="st-meter"><i style="width:${Math.max(2, c.pct)}%;background:${col}"></i></div><b>${c.pct}%</b></div>`;
  }).join("") || '<span class="muted small">Данных пока нет</span>';
}

async function drCmd(action, btn) {
  if (drm.busy) return; drm.busy = true;
  const old = btn.textContent; btn.disabled = true; btn.textContent = "…";
  try { await post("/api/home/dreame/cmd", { action }); toast({ start: "Поехал убирать", pause: "Пауза", dock: "Возвращается на базу", stop: "Остановлен", locate: "Пылесос подаёт сигнал" }[action]); setTimeout(loadVacuumFresh, 2500); }
  catch (e) { toast(e.message, true); btn.textContent = old; btn.disabled = false; }
  finally { drm.busy = false; }
}
async function loadVacuumFresh() { try { const j = await api("/api/home/dreame?fresh=1"); if (j.status) renderVacuum(j.status); } catch (e) {} }

async function loadVacuumHistory() {
  let j; try { j = await api("/api/home/dreame/history"); } catch (e) { return; }
  const items = j.items || [];
  if (!items.length) { $("#drHistChart").innerHTML = '<div class="st-empty">История появится после первой уборки.</div>'; $("#drHist").innerHTML = ""; return; }
  const rev = items.slice().reverse();
  $("#drHistChart").innerHTML = barChart(rev.map((x) => x.area || 0), rev.map((x) => new Date(x.t * 1000).getDate() + "." + String(new Date(x.t * 1000).getMonth() + 1).padStart(2, "0")), { h: 140, labelEvery: Math.ceil(rev.length / 10), tip: (i, v) => `${new Date(rev[i].t * 1000).toLocaleString("ru-RU")}: ${v} м², ${drHM(rev[i].min)}` });
  $("#drHist").innerHTML = items.slice(0, 20).map((x) => `
    <div class="card st-row">
      <div class="st-row-main"><b>${new Date(x.t * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}</b><span class="muted small">${new Date(x.t * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}${x.done === false ? " · не завершена" : ""}</span></div>
      <div class="st-row-spark"></div>
      <div class="st-row-num"><b>${x.area ?? "—"} м²</b><span class="muted small">${drHM(x.min)}</span></div>
    </div>`).join("");
}

$("#drForm") && ($("#drForm").onsubmit = async (e) => {
  e.preventDefault();
  const b = $("#drLoginBtn"); b.disabled = true; b.textContent = "Подключаю…";
  try {
    await post("/api/home/dreame/login", { user: $("#drUser").value, password: $("#drPass").value, country: $("#drCountry").value });
    $("#drPass").value = ""; toast("Пылесос подключён"); loadVacuum();
  } catch (er) { drNotice(er.message, true); toast(er.message, true); }
  finally { b.disabled = false; b.textContent = "Подключить"; }
});
$("#drLogout") && ($("#drLogout").onclick = async () => {
  if (!(await askConfirm({ icon: "⏏", title: "Отключить Dreame?", text: "Логин и пароль будут удалены с роутера.", yes: "Отключить", danger: true }))) return;
  try { await post("/api/home/dreame/logout"); toast("Аккаунт отключён"); loadVacuum(); } catch (e) { toast(e.message, true); }
});

// ---- карта ----
let drMapView = null, homeVacView = null;
async function drShowMap() {
  const cv = $("#drMapCanvas"); if (!cv) return;
  let c; try { c = await dmLoad(); } catch (e) { $("#drLegend").innerHTML = '<span class="muted small">' + drEsc(e.message) + "</span>"; return; }
  if (!drMapView || drMapView.cv !== cv) drMapView = new DreameMap3D(cv, { autoRotate: true });
  drMapView.setNames(c.names); drMapView.setData(c.map);
  $("#drMapWhen").textContent = c.map.t ? "· " + new Date(c.map.t * 1000).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "";
  drLegend(c);
}
function drLegend(c) {
  $("#drLegend").innerHTML = c.map.rooms.slice().sort((a, b) => a.id - b.id).map((r) => {
    const col = "hsl(" + DM_HUES[(r.id - 1) % DM_HUES.length] + ",36%,46%)";
    return '<button class="dr-room" data-room="' + r.id + '"><i style="background:' + col + '"></i><b>' + drEsc(c.names[r.id] || "Комната " + r.id) + "</b><span>" + r.area + " м²</span></button>";
  }).join("");
  $$("[data-room]", $("#drLegend")).forEach((b) => b.onclick = async () => {
    const id = b.dataset.room, cur = c.names[id] || "";
    const v = prompt("Название комнаты " + id, cur); if (v === null) return;
    c.names[id] = v.trim().slice(0, 30);
    try { await post("/api/home/dreame/rooms", c.names); } catch (e) { toast(e.message, true); }
    if (drMapView) drMapView.setNames(c.names); if (homeVacView) homeVacView.setNames(c.names); drLegend(c);
  });
}
$("#drMapReplay") && ($("#drMapReplay").onclick = () => drMapView && drMapView.replay());

// ---- карточка на главной ----
async function homeVacStart() {
  const card = $("#homeVac"), head = $("#homeVacHead"); if (!card) return;
  let c, st;
  try { c = await dmLoad(); } catch (e) { card.classList.add("hidden"); head.classList.add("hidden"); return; }
  try { const j = await api("/api/home/dreame"); st = j.status; } catch (e) {}
  card.classList.remove("hidden"); head.classList.remove("hidden");
  const cv = $("#homeVacCanvas");
  if (!homeVacView || homeVacView.cv !== cv) homeVacView = new DreameMap3D(cv, { autoRotate: true, interactive: true, labels: false });
  homeVacView.setNames(c.names); homeVacView.setData(c.map);
  const t = c.map.t ? new Date(c.map.t * 1000) : null;
  const when = t ? t.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) + ", " + t.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";
  $("#homeVacInfo").innerHTML =
    '<div class="mono-label">' + drEsc(when) + "</div>" +
    '<div class="home-vac-stats"><div><b>' + (c.map.area || 0) + "</b><span>м² убрано</span></div><div><b>" + drHM(c.map.min) + "</b><span>в работе</span></div><div><b>" + c.map.rooms.length + "</b><span>комнат</span></div></div>" +
    (st ? '<div class="home-vac-state"><span class="dr-pill ' + (st.state === 4 ? "bad" : DR_CLEANING.has(st.state) ? "live" : "idle") + '">' + drEsc(st.stateText) + "</span>" + drBattery(st.battery, st.charging === 1) + "</div>" : "") +
    '<button class="btn" id="homeVacReplay">↻ Маршрут заново</button>';
  $("#homeVacReplay").onclick = () => homeVacView.replay();
}

const _goVac = go;
go = function (p) {
  _goVac(p);
  clearInterval(drm.timer);
  if (p === "vacuum") { loadVacuum(); drShowMap(); drm.timer = setInterval(loadVacuum, 15000); }
  if (p === "home") homeVacStart();
};
