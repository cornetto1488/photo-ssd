"use strict";
// Режим обоев (Wallpaper Engine) и киоска без PIN: адрес вида /?wp=1&token=КЛЮЧ#kiosk
(() => {
  const q = new URLSearchParams(location.search);
  let t = q.get("token") || "";
  try { if (t) sessionStorage.setItem("zh-token", t); else t = sessionStorage.getItem("zh-token") || ""; } catch (e) {}
  window.ZH_TOKEN = t;
  if (q.get("wp") === "1") {
    document.documentElement.classList.add("wp");
    const b64d = (s) => { try { return decodeURIComponent(escape(atob(s))); } catch (e) { return ""; } };
    const folders = b64d(q.get("folders") || "").split(";").map((x) => x.split("|")).filter((x) => x.length >= 2 && x[0].trim() && x[1].trim()).map((x) => ({ n: x[0].trim(), p: x.slice(1).join("|").trim() })).slice(0, 8);
    const z = Number(q.get("zone"));
    window.ZH_WP = { zone: Number.isFinite(z) && q.get("zone") !== null ? Math.max(0, Math.min(500, z)) : 190, orange: q.get("zmode") !== "off", folders, quick: q.get("quick") !== "0" };
    // обои присылают изменения свойств (ключ, зона, папки) — пересобираем адрес и перезагружаемся, защита от зацикливания
    window.wallpaperPropertyListener = {
      applyUserProperties(p) {
        const cur = new URLSearchParams(location.search); let changed = false;
        const set = (k, v) => { if (String(cur.get(k) ?? "") !== String(v)) { cur.set(k, v); changed = true; } };
        const b64e = (s) => btoa(unescape(encodeURIComponent(s)));
        if (p.token && String(p.token.value || "").trim()) set("token", String(p.token.value).trim());
        if (p.nocams) set("nocams", p.nocams.value ? "1" : "0");
        if (p.zonewidth) set("zone", Math.round(p.zonewidth.value));
        if (p.zonemode) set("zmode", p.zonemode.value);
        if (p.quick) set("quick", p.quick.value ? "1" : "0");
        if (p.folders) set("folders", b64e(String(p.folders.value || "")));
        if (!changed) return;
        let n = 0; try { n = Number(sessionStorage.getItem("zh-wp-reloads") || 0); sessionStorage.setItem("zh-wp-reloads", String(n + 1)); } catch (e) {}
        if (n < 4) location.replace(location.origin + "/?" + cur.toString() + "#kiosk");
      },
    };
  }
  if (q.get("nocams") === "1") window.ZH_NOCAMS = true;
  if (t) {
    const rf = window.fetch.bind(window);
    window.fetch = (u, o = {}) => {
      if (typeof u === "string" && u.startsWith("/")) { const h = new Headers(o.headers || {}); if (!h.has("Authorization")) h.set("Authorization", "Bearer " + t); o = { ...o, headers: h }; }
      return rf(u, o);
    };
  }
})();
// ZALET HOME — панель дома.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let page = "home";
let started = false;
let status = null;
let devices = [];
let logSource = "";
const timers = {};

// ---------- утилиты ----------
function fmtBytes(b) {
  if (!b) return "0 Б";
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"]; let i = 0; b = Number(b);
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (b >= 100 || i === 0 ? b.toFixed(0) : b.toFixed(1)).replace(".", ",") + " " + u[i];
}
function fmtUptime(s) {
  s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d} дн ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
}
function plural(n, a, b, c) { n = Math.abs(n) % 100; const n1 = n % 10; if (n > 10 && n < 20) return c; if (n1 > 1 && n1 < 5) return b; if (n1 === 1) return a; return c; }
function ago(ts) {
  if (!ts) return "—"; const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return "только что"; if (s < 3600) return Math.floor(s / 60) + " мин назад";
  if (s < 86400) return Math.floor(s / 3600) + " ч назад"; return Math.floor(s / 86400) + " дн назад";
}
function toast(msg, bad) {
  const t = $("#toast"); t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("show");
  clearTimeout(timers.toast); timers.toast = setTimeout(() => t.classList.remove("show"), 2600);
}
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", ...opts, headers: { ...(opts.headers || {}), "Content-Type": "application/json" } });
  if (r.status === 401 && !path.startsWith("/api/home/login") && !path.startsWith("/api/home/pin")) { showLock(); throw new Error("Нужен вход"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || ("Ошибка " + r.status)); e.data = j; e.status = r.status; throw e; }
  return j;
}
const post = (path, body) => api(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} };

// ---------- клавиатура PIN ----------
function makePad(padEl, dotsEl, msgEl, onDone) {
  let len = 4, value = "", busy = false;
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];
  const letters = { 2: "ABC", 3: "DEF", 4: "GHI", 5: "JKL", 6: "MNO", 7: "PQRS", 8: "TUV", 9: "WXYZ" };
  padEl.innerHTML = keys.map((k) => k === "" ? `<span></span>` :
    `<button type="button" data-k="${k}" class="${k === "⌫" ? "ghost" : ""}">${k}${letters[k] ? `<small>${letters[k]}</small>` : ""}</button>`).join("");
  const draw = () => {
    dotsEl.innerHTML = Array.from({ length: len }, (_, i) => `<i class="${i < value.length ? "on" : ""}"></i>`).join("");
  };
  const press = (k, btn) => {
    if (busy) return;
    if (btn) {
      btn.classList.add("press"); setTimeout(() => btn.classList.remove("press"), 120);
      const r = document.createElement("span"); r.className = "ripple";
      const s = btn.offsetWidth; r.style.width = r.style.height = s + "px"; r.style.left = r.style.top = "0px";
      btn.appendChild(r); setTimeout(() => r.remove(), 560);
    }
    if (k === "⌫") { value = value.slice(0, -1); draw(); buzz(8); return; }
    if (value.length >= len) return;
    value += k; draw(); buzz(10);
    if (value.length === len) { busy = true; setTimeout(() => onDone(value), 140); }
  };
  padEl.addEventListener("click", (e) => { const b = e.target.closest("[data-k]"); if (b) press(b.dataset.k, b); });
  const onKey = (e) => {
    if (padEl.offsetParent === null) return; // клавиатура скрыта
    if (/^\d$/.test(e.key)) press(e.key, padEl.querySelector(`[data-k="${e.key}"]`));
    else if (e.key === "Backspace") press("⌫", padEl.querySelector(`[data-k="⌫"]`));
  };
  document.addEventListener("keydown", onKey);
  draw();
  return {
    setLength(n) { len = n || 4; value = ""; busy = false; draw(); },
    get length() { return len; },
    reset() { value = ""; busy = false; dotsEl.classList.remove("shake", "ok"); draw(); },
    fail(msg) {
      dotsEl.classList.add("shake"); buzz([40, 60, 40]);
      if (msgEl) { msgEl.textContent = msg; msgEl.classList.add("bad"); }
      setTimeout(() => { dotsEl.classList.remove("shake"); value = ""; busy = false; draw(); }, 520);
    },
    ok() { dotsEl.classList.add("ok"); buzz(20); },
    lock(on) { padEl.querySelectorAll("button").forEach((b) => b.disabled = on); },
  };
}

// ---------- вход ----------
const pad = makePad($("#pinPad"), $("#pinDots"), $("#pinMsg"), async (pin) => {
  try {
    await post("/api/home/login", { pin });
    pad.ok(); $("#pinMsg").textContent = " "; $("#pinMsg").classList.remove("bad");
    setTimeout(() => {
      $("#pinWrap").classList.add("leave");
      setTimeout(() => { $("#login").classList.add("hidden"); $("#pinWrap").classList.remove("leave"); $("#app").classList.remove("hidden"); pad.reset(); start(); }, 520);
    }, 420);
  } catch (e) {
    const d = e.data || {};
    if (d.locked) { pad.fail("Заблокировано"); lockCountdown(d.locked); }
    else pad.fail(d.left > 0 ? `Неверный PIN · осталось попыток: ${d.left}` : "Неверный PIN");
  }
});
function lockCountdown(sec) {
  pad.lock(true); clearInterval(timers.lock);
  const m = $("#pinMsg"); m.classList.add("bad");
  const upd = () => {
    if (sec <= 0) { clearInterval(timers.lock); pad.lock(false); m.textContent = "Можно пробовать снова"; m.classList.remove("bad"); return; }
    m.textContent = `Слишком много попыток · подождите ${sec >= 60 ? Math.floor(sec / 60) + " мин " : ""}${sec % 60} с`; sec--;
  };
  upd(); timers.lock = setInterval(upd, 1000);
}
async function showLock() {
  Object.entries(timers).forEach(([k, t]) => { if (k !== "toast") clearInterval(t); });
  started = false; try { cozyRun(false); } catch (e) {}
  $("#boot").classList.add("done");
  $("#app").classList.add("hidden"); $("#login").classList.remove("hidden");
  try {
    const info = await api("/api/home/pin-info");
    pad.setLength(info.length || 4);
    $("#pinTitle").textContent = info.enabled ? "ВВЕДИТЕ PIN" : "PIN НЕ ЗАДАН";
    if (info.locked) lockCountdown(info.locked);
  } catch (e) { $("#pinMsg").textContent = "Нет связи с роутером"; }
}
async function logout() {
  try { await post("/api/home/logout"); } catch (e) {}
  showLock();
}
$("#logoutBtn").onclick = logout;

// ---------- смена PIN ----------
let cp = { step: 0, current: "", next: "" };
const cpPad = makePad($("#cpPad"), $("#cpDots"), $("#cpMsg"), async (pin) => {
  const msg = $("#cpMsg");
  if (cp.step === 0) { cp.current = pin; cp.step = 1; setCpStep(); return; }
  if (cp.step === 1) { cp.next = pin; cp.step = 2; setCpStep(); return; }
  if (pin !== cp.next) { cp.step = 1; cpPad.fail("Коды не совпали — ещё раз"); setTimeout(setCpStep, 560); return; }
  try {
    await post("/api/home/pin", { current: cp.current, next: cp.next });
    cpPad.ok(); msg.textContent = "PIN изменён"; msg.classList.remove("bad");
    setTimeout(closeCp, 900); toast("PIN изменён · другие входы сброшены");
  } catch (e) { cp.step = 0; cpPad.fail(e.message); setTimeout(setCpStep, 560); }
});
function setCpStep() {
  const titles = ["ТЕКУЩИЙ PIN", "НОВЫЙ PIN", "ПОВТОРИТЕ НОВЫЙ PIN"];
  $("#cpTitle").textContent = titles[cp.step];
  $("#cpLen").style.display = cp.step === 1 ? "flex" : "none";
  if (cp.step !== 2) { $("#cpMsg").textContent = cp.step === 1 ? "Выберите длину и введите новый код" : " "; $("#cpMsg").classList.remove("bad"); }
  cpPad.setLength(cp.step === 0 ? pad.length : cp.step === 1 ? (cp.newLen || 4) : cp.next.length);
}
$("#cpLen").innerHTML = [4, 6, 8].map((n) => `<button data-len="${n}" class="${n === 4 ? "active" : ""}">${n} цифр${n === 4 ? "ы" : ""}</button>`).join("");
$$("#cpLen button").forEach((b) => b.onclick = () => {
  cp.newLen = Number(b.dataset.len); $$("#cpLen button").forEach((x) => x.classList.toggle("active", x === b)); cpPad.setLength(cp.newLen);
});
function openCp() { cp = { step: 0, current: "", next: "", newLen: 4 }; $$("#cpLen button").forEach((x) => x.classList.toggle("active", x.dataset.len === "4")); setCpStep(); $("#pinModal").classList.remove("hidden"); }
function closeCp() { $("#pinModal").classList.add("hidden"); cpPad.reset(); }
$("#pinBtn").onclick = openCp;
$("#pinModalClose").onclick = closeCp;
$("#pinModal").onclick = (e) => { if (e.target.id === "pinModal") closeCp(); };

// ---------- навигация ----------
function go(p) {
  if (p === "more") { openMore(); return; }
  if (p === "network" || p === "access") p = "router";
  page = p;
  $$("[data-page]").forEach((a) => a.classList.toggle("active", a.dataset.page === p));
  $$(".page").forEach((s) => s.classList.toggle("active", s.id === "page-" + p));
  try { history.replaceState(null, "", "#" + p); } catch (e) {}
  window.scrollTo({ top: 0, behavior: "smooth" });
  cozyRun(p === "home");
  if (p !== "home") homeCamsStop();
  ({ home: () => { loadStatus(); homeCamsStart(); }, devices: () => loadDevices(), pc: loadStatus, photos: loadPhotos, cameras: loadCameras, router: () => { loadStatus(); loadClients(); loadAccess(); }, logs: loadLogs, vault: loadVault, services: () => { loadStatus(); loadServiceInfo(); } })[p]?.();
}
const NAV_ICONS = {"home":"<path d=\"M3 11.5 12 4l9 7.5M5.5 9.6V20h13V9.6M10 20v-5.5h4V20\"/>","devices":"<path d=\"M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3z\"/>","vacuum":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 3v3\"/>","cameras":"<path d=\"M3 7h13v10H3zM16 10.5l5-3v9l-5-3\"/>","photos":"<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2.5\"/><circle cx=\"9\" cy=\"10\" r=\"2\"/><path d=\"m21 16-5-5-8 8\"/>","stats":"<path d=\"M4 20V11M10 20V4M16 20v-6M22 20H2\"/>","logs":"<path d=\"M4 6h16M4 12h16M4 18h10\"/>","pc":"<rect x=\"3\" y=\"4\" width=\"18\" height=\"12\" rx=\"2\"/><path d=\"M8 20h8M12 16v4\"/>","router":"<rect x=\"3\" y=\"14\" width=\"18\" height=\"6\" rx=\"2\"/><path d=\"M7 17h.01M11 17h.01M8.5 10.5a5 5 0 0 1 7 0M6 7.5a8.5 8.5 0 0 1 12 0\"/>","vault":"<circle cx=\"8\" cy=\"15\" r=\"4\"/><path d=\"m11 12 9-9M16 7l3 3\"/>","services":"<rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"1.5\"/>","more":"<circle cx=\"5\" cy=\"12\" r=\"1.2\"/><circle cx=\"12\" cy=\"12\" r=\"1.2\"/><circle cx=\"19\" cy=\"12\" r=\"1.2\"/>","kiosk":"<rect x=\"2\" y=\"4\" width=\"20\" height=\"13\" rx=\"2\"/><path d=\"M8 21h8M12 17v4\"/>"};
const NAV_GROUPS = [["ДОМ",[["home","Дом"],["devices","Устройства"],["vacuum","Пылесос"],["cameras","Камеры"]]],["ДАННЫЕ",[["photos","Фото"],["stats","Статистика"],["logs","Журналы"]]],["СИСТЕМА",[["pc","ПК"],["router","Роутер"],["vault","Пароли"],["kiosk","Киоск"],["services","Сервисы"]]]];
function openMore() {
  const old = $("#moreSheet"); if (old) old.remove();
  const inTab = new Set(["home", "devices", "cameras", "photos"]);
  const groups = NAV_GROUPS.map(([g, items]) => [g, items.filter(([k]) => !inTab.has(k))]).filter(([, items]) => items.length);
  const el = document.createElement("div"); el.className = "sheet"; el.id = "moreSheet";
  el.innerHTML = '<div class="sheet-card"><div class="sheet-grip"></div>' + groups.map(([g, items]) =>
    '<div class="mono-label sheet-group">' + g + '</div><div class="sheet-grid">' + items.map(([k, t]) =>
      '<button data-go="' + k + '"><svg viewBox="0 0 24 24" class="ni">' + NAV_ICONS[k] + "</svg><span>" + t + "</span></button>").join("") + "</div>").join("") + "</div>";
  document.body.appendChild(el);
  const close = () => { el.classList.add("closing"); setTimeout(() => el.remove(), 180); };
  el.onclick = (e) => { if (e.target === el) close(); };
  $$("[data-go]", el).forEach((b) => b.onclick = () => { close(); go(b.dataset.go); });
}
$$("[data-page]").forEach((a) => a.onclick = () => go(a.dataset.page));

// быстрые действия
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act;
  if (act === "pc-off" && !(await askConfirm({ icon: "⏻", title: "Выключить компьютер?", text: "Windows корректно завершит работу. Несохранённые файлы лучше сохранить.", yes: "Да, выключить", danger: true }))) return;
  if (act === "pc-on" && !(await askConfirm({ icon: "⏻", title: "Включить компьютер?", text: "Отправлю сигнал Wake-on-LAN — ПК загрузится примерно за минуту.", yes: "Включить" }))) return;
  if (act === "alloff" && !(await askConfirm({ icon: "✦", title: "Выключить весь свет?", text: "Погаснут все лампы и выключатели. Компьютер не затронется.", yes: "Выключить" }))) return;
  b.disabled = true;
  try {
    if (act === "pc-on") { await post("/api/home/pc?action=on"); toast("Включаю компьютер…"); }
    if (act === "pc-off") { await post("/api/home/pc?action=off"); toast("Компьютер выключается"); }
    if (act === "alloff") { const r = await post("/api/home/alloff"); toast(`Выключено: ${r.done}${r.failed ? `, не ответили: ${r.failed}` : ""}`); loadDevices(true); }
    setTimeout(loadStatus, 1500);
  } catch (err) { toast(err.message, true); }
  finally { b.disabled = false; }
});

// ---------- часы ----------
function tick() {
  const d = new Date(); $("#clock").textContent = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const h = d.getHours();
  $("#greet").textContent = h < 5 ? "ДОБРОЙ НОЧИ" : h < 12 ? "ДОБРОЕ УТРО" : h < 18 ? "ДОБРЫЙ ДЕНЬ" : "ДОБРЫЙ ВЕЧЕР";
}

// ---------- статус дома ----------
async function loadStatus() {
  try { status = await api("/api/home/status"); } catch (e) { $("#heroSub").textContent = e.message; return; }
  renderTiles(); renderPC(); try { renderRouterStats(); } catch (e) {} renderServices(); renderMarquee(); renderHouse(); renderLaunch(); try { renderAlerts(); } catch (e) {}
}
function tile({ label, num, val, sub, ok, bar, accent }) {
  return `<div class="tile ${accent ? "accent" : ""}">
    <div class="head"><div class="mono-label">${num ? `<span class="acc">// ${num}</span> ` : ""}${esc(label)}</div>
    ${ok === undefined ? "" : `<span class="dot ${ok ? "ok" : "bad"}"></span>`}</div>
    <div class="val">${val}</div><div class="sub">${sub}</div>
    ${bar === undefined ? "" : `<div class="bar"><i style="width:${Math.max(2, Math.min(100, bar))}%"></i></div>`}
  </div>`;
}
function renderTiles() {
  const s = status; if (!s) return;
  const r = s.router, sv = s.services;
  const usedSSD = s.ssd.total ? (1 - s.ssd.free / s.ssd.total) * 100 : 0;
  const memUsed = r.memTotal ? (1 - r.memAvail / r.memTotal) * 100 : 0;
  const problems = [];
  if (!s.internet) problems.push("нет интернета");
  if (!sv["v2raya"]) problems.push("VPN выключен");
  if (!sv["smbd"]) problems.push("Samba не работает");
  $("#heroSub").textContent = problems.length ? "Внимание: " + problems.join(", ") + "." :
    `Интернет есть, роутер работает ${fmtUptime(r.uptime)}, на SSD ${s.photos.files.toLocaleString("ru-RU")} ${plural(s.photos.files, "файл", "файла", "файлов")}.`;
  $("#tiles").innerHTML = [
    tile({ num: "01", label: "Интернет", val: s.internet ? "В СЕТИ" : "НЕТ", sub: "DNS через AdGuard · шифрованный", ok: s.internet }),
    tile({ num: "02", label: "Компьютер", val: s.pc.online ? "ВКЛЮЧЁН" : "ВЫКЛЮЧЕН", sub: s.pc.ip, ok: s.pc.online, accent: s.pc.online }),
    tile({ num: "03", label: "Роутер", val: fmtUptime(r.uptime).toUpperCase(), sub: `нагрузка ${r.load} · ${r.temp ? r.temp.toFixed(0) + "°C" : ""} · RAM ${memUsed.toFixed(0)}%`, bar: memUsed, ok: true }),
    tile({ num: "04", label: "SSD", val: fmtBytes(s.ssd.free), sub: `свободно из ${fmtBytes(s.ssd.total)}`, bar: usedSSD }),
    tile({ num: "05", label: "Фото ZALET", val: s.photos.files.toLocaleString("ru-RU"), sub: `${fmtBytes(s.photos.bytes)} · последний ${ago(s.photos.last)}`, accent: true }),
    tile({ num: "06", label: "Обход блокировок", val: sv["xray"] ? "РАБОТАЕТ" : (sv["v2raya"] ? "ОЖИДАЕТ" : "ВЫКЛ"), sub: "v2raya · ru-blocked → Германия", ok: !!sv["xray"] }),
    tile({ num: "07", label: "Удалённый доступ", val: sv["tailscaled"] ? "TAILSCALE" : "—", sub: `ZeroTier: ${sv["zerotier-one"] ? "запасной, в сети" : "выключен"}`, ok: !!sv["tailscaled"] }),
    tile({ num: "08", label: "Сетевая папка", val: sv["smbd"] ? "SAMBA" : "ВЫКЛ", sub: "\\\\192.168.1.1\\SSD", ok: !!sv["smbd"] }),
  ].join("");
}

// ---------- ПК ----------
function renderPC() {
  if (!status) return;
  const on = status.pc.online;
  $("#pcCard").innerHTML = `
    <div class="head" style="display:flex;justify-content:space-between"><div class="mono-label">СОСТОЯНИЕ</div><span class="state"><span class="dot ${on ? "ok" : "bad"}"></span>${on ? "в сети" : "не отвечает"}</span></div>
    <div class="pc-state ${on ? "grad" : ""}">${on ? "Включён" : "Выключен"}</div>
    <div class="muted small">IP ${esc(status.pc.ip)} · обновлено ${new Date().toLocaleTimeString("ru-RU")}</div>
    <div class="pc-actions">
      <button class="btn btn-acc" data-act="pc-on" ${on ? "disabled" : ""}>⏻ Включить</button>
      <button class="btn btn-danger" data-act="pc-off" ${on ? "" : "disabled"}>Выключить</button>
    </div>`;
}

// ---------- устройства ----------
const val = (d, ...codes) => { for (const c of codes) { const s = (d.status || []).find((x) => x.code === c); if (s) return s.value; } };
async function loadDevices(fresh) {
  if (!devices.length) $("#rooms").innerHTML = `<div class="devices">${'<div class="skeleton"></div>'.repeat(6)}</div>`;
  try { devices = (await api("/api/home/devices" + (fresh ? "?fresh=1" : ""))).devices || []; }
  catch (e) { $("#rooms").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  renderDevices(); renderHouse(); renderMarquee();
}
function devCard(d) {
  let on = false, controls = "";
  if (d.kind === "light") {
    on = !!val(d, "switch_led");
    const bv2 = val(d, "bright_value_v2"), bv1 = val(d, "bright_value");
    const pct = d.bright >= 0 && d.bright !== undefined ? d.bright : bv2 !== undefined ? Math.round((bv2 - 10) / 990 * 100) : bv1 !== undefined ? Math.round((bv1 - 10) / 990 * 100) : 50;
    const tv2 = val(d, "temp_value_v2"), tv1 = val(d, "temp_value");
    const tp = d.temp >= 0 && d.temp !== undefined ? d.temp : tv2 !== undefined ? Math.round(tv2 / 10) : tv1 !== undefined ? Math.round(tv1 / 10) : 50;
    controls = (d.power === "off" ? `<div class="power-note">⚡ Нет питания — «${esc(d.powerSwitch)}» выключен. Включу его вместе с лампой.</div>` : "") +
      `<div class="range-row"><span>ЯРКОСТЬ</span><input type="range" min="1" max="100" value="${Math.max(1, pct)}" data-bright="${d.id}"></div>
      <div class="range-row"><span>ТОН</span><input type="range" class="range-temp" min="0" max="100" value="${tp}" data-temp="${d.id}"></div>`;
  } else if (d.kind === "switch" || d.kind === "plug") {
    on = !!val(d, "switch_1");
    const cd = Number(val(d, "countdown_1") || 0);
    controls = `<div class="sw-row"><button class="btn btn-sm" data-timer="${d.id}">⏲ ${cd > 0 && on ? "через " + Math.ceil(cd / 60) + " мин" : "Таймер"}</button>${devices.some((x) => x.kind === "light" && x.room === d.room && d.room) ? `<span class="mono-label">питает лампы комнаты</span>` : ""}</div>`;
  } else if (d.kind === "pc") {
    on = status ? status.pc.online : !!val(d, "switch_1");
  }
  const canToggle = ["light", "switch", "plug"].includes(d.kind);
  if (d.kind === "pc") {
    controls = `<div class="pc-btns" style="margin-left:0"><button class="btn btn-acc" data-act="pc-on" ${on ? "disabled" : ""}>⏻ Включить</button>
      <button class="btn btn-danger" data-act="pc-off" ${on ? "" : "disabled"}>Выключить</button></div>`;
  }
  const kindName = { light: "лампа", switch: "выключатель", plug: "розетка", pc: "компьютер · Маруся", gateway: "шлюз", other: "устройство" }[d.kind] || "";
  return `<div class="dev ${on ? "on" : ""} ${d.online ? "" : "offline"}" data-dev="${d.id}">
    <div class="top-row">
      ${d.icon ? `<img src="${esc(d.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<img alt="">`}
      <div style="min-width:0">
        <div class="name">${esc(d.name)}</div>
        <div class="meta"><span class="dot ${d.online ? "ok" : "bad"}" style="width:6px;height:6px"></span> ${d.online ? (d.local ? "по сети дома" : "в сети") : "не в сети"} · ${kindName}${d.guess ? ` <span class="guess" title="Лампы Bluetooth Beacon не сообщают состояние. Показываю последнюю команду с учётом выключателя на стене.">≈</span>` : ""}</div>
      </div>
      ${canToggle ? `<label class="switch"><input type="checkbox" ${on ? "checked" : ""} data-toggle="${d.id}" ${d.online ? "" : "disabled"}><i></i></label>` : ""}
    </div>
    ${controls ? `<div class="controls">${controls}</div>` : ""}
  </div>`;
}
function renderDevices() {
  const rooms = {};
  devices.forEach((d) => { const r = d.room || (d.kind === "pc" ? "Компьютер" : d.kind === "gateway" ? "Служебные" : "Без комнаты"); (rooms[r] ||= []).push(d); });
  const order = Object.keys(rooms).sort((a, b) => (a === "Служебные") - (b === "Служебные") || a.localeCompare(b, "ru"));
  $("#rooms").innerHTML = order.map((r) => {
    const list = rooms[r]; const onCount = list.filter((d) => d.kind === "light" ? val(d, "switch_led") : val(d, "switch_1")).length;
    return `<div class="room"><div class="room-title"><h3>${esc(r)}</h3><span class="mono-label">${list.length} ${plural(list.length, "устройство", "устройства", "устройств")} · включено ${onCount}</span></div>
      <div class="devices">${list.map(devCard).join("")}</div></div>`;
  }).join("") || `<p class="muted">Устройств не найдено.</p>`;
}
function setLocal(id, code, value) {
  const d = devices.find((x) => x.id === id); if (!d) return;
  const s = (d.status ||= []).find((x) => x.code === code); if (s) s.value = value; else d.status.push({ code, value });
}
async function sendCmd(id, commands, okMsg) {
  try { await post("/api/home/command", { id, commands }); commands.forEach((c) => setLocal(id, c.code, c.value)); if (okMsg) toast(okMsg); }
  catch (e) { toast(e.message.includes("permission") ? "Нет прав на управление — включите Control в Tuya" : e.message, true); loadDevices(true); }
}
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.dataset.toggle) {
    const d = devices.find((x) => x.id === t.dataset.toggle); if (!d) return;
    const on = t.checked; t.closest(".dev").classList.toggle("on", on);
    const code = d.kind === "light" ? "switch_led" : "switch_1";
    // лампа без питания: сначала включаем выключатель комнаты
    if (d.kind === "light" && on && d.power === "off") {
      const sw = devices.find((x) => x.kind === "switch" && x.room === d.room);
      if (sw) { await sendCmd(sw.id, [{ code: "switch_1", value: true }]); setLocal(sw.id, "switch_1", true); d.power = "on"; await new Promise((r) => setTimeout(r, 2500)); }
    }
    await sendCmd(d.id, [{ code, value: on }], `${d.name}: ${on ? "включено" : "выключено"}`);
    renderDevices();
  }
});
document.addEventListener("input", (e) => {
  const t = e.target; const id = t.dataset.bright || t.dataset.temp; if (!id) return;
  clearTimeout(timers["sl" + id]);
  timers["sl" + id] = setTimeout(() => {
    const v = Number(t.value);
    if (t.dataset.bright) sendCmd(id, [{ code: "switch_led", value: true }, { code: "bright_value_v2", value: Math.round(10 + v / 100 * 990) }]);
    else sendCmd(id, [{ code: "switch_led", value: true }, { code: "work_mode", value: "white" }, { code: "temp_value_v2", value: Math.round(v * 10) }]);
    t.closest(".dev")?.classList.add("on");
    const cb = t.closest(".dev")?.querySelector("[data-toggle]"); if (cb) cb.checked = true;
  }, 350);
});
$("#devRefresh").onclick = () => loadDevices(true);

// ---------- фото ----------
async function loadPhotos() {
  try {
    const [st, items] = await Promise.all([api("/api/v1/stats"), api("/api/v1/items?limit=36")]);
    const kinds = Object.fromEntries((st.byKind || []).map((k) => [k.key, k]));
    const stat = (label, v, sub) => `<div class="tile"><div class="mono-label">${label}</div><div class="val">${v}</div><div class="sub">${sub}</div></div>`;
    $("#photoStats").innerHTML = [
      stat("Всего на SSD", st.total.toLocaleString("ru-RU"), fmtBytes(st.bytes)),
      stat("Фото", ((kinds.photo?.count || 0) + (kinds.live?.count || 0)).toLocaleString("ru-RU"), fmtBytes((kinds.photo?.bytes || 0) + (kinds.live?.bytes || 0))),
      stat("Видео", (kinds.video?.count || 0).toLocaleString("ru-RU"), fmtBytes(kinds.video?.bytes || 0)),
      stat("Скриншоты", (kinds.screenshot?.count || 0).toLocaleString("ru-RU"), fmtBytes(kinds.screenshot?.bytes || 0)),
    ].join("");
  } catch (e) { $("#photoStats").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  if (!gal.items.length) galReset();
}

// ---------- галерея ----------
const gal = { kind: "", album: "", year: "", items: [], total: 0, loading: false, done: false };
const GAL_KINDS = [["", "Все"], ["photo", "Фото"], ["live", "Live"], ["video", "Видео"], ["screenshot", "Скриншоты"]];
$("#galChips").innerHTML = GAL_KINDS.map(([k, v]) => `<button class="chip ${k === "" ? "active" : ""}" data-gk="${k}">${v}</button>`).join("");
$$("#galChips .chip").forEach((c) => c.onclick = () => { gal.kind = c.dataset.gk; $$("#galChips .chip").forEach((x) => x.classList.toggle("active", x === c)); galReset(); });
const monthKey = (it) => { const d = new Date((it.date || it.time) * 1000); return d.getFullYear() + "-" + d.getMonth(); };
const monthTitle = (it) => { const d = new Date((it.date || it.time) * 1000); return d.toLocaleDateString("ru-RU", { month: "long", year: "numeric" }); };
function galReset() { gal.items = []; gal.total = 0; gal.done = false; $("#gallery").innerHTML = ""; galMore(); }
async function galMore() {
  if (gal.loading || gal.done) return;
  gal.loading = true; $("#galMore").style.display = "grid";
  try {
    let q = `/api/v1/items?limit=120&offset=${gal.items.length}${gal.kind ? "&kind=" + gal.kind : ""}${gal.album ? "&album=" + encodeURIComponent(gal.album) : ""}`;
    if (gal.year) q += `&from=${Math.floor(new Date(+gal.year, 0, 1) / 1000)}&to=${Math.floor(new Date(+gal.year + 1, 0, 1) / 1000)}`;
    const r = await api(q);
    const start = gal.items.length;
    gal.items.push(...(r.items || [])); gal.total = r.total;
    if (gal.items.length >= r.total || !(r.items || []).length) gal.done = true;
    $("#galCount").innerHTML = `${gal.album ? `<a class="chip active" id="galAlbumX">${esc(gal.album)} ✕</a> ` : ""}${gal.total.toLocaleString("ru-RU")} ${plural(gal.total, "файл", "файла", "файлов")}`;
    const ax = $("#galAlbumX"); if (ax) ax.onclick = () => { gal.album = ""; galReset(); };
    // дорисовываем по месяцам
    let html = "", lastKey = start > 0 ? monthKey(gal.items[start - 1]) : "";
    let grid = start > 0 ? $("#gallery .gal-grid:last-of-type") : null;
    const chunks = [];
    for (let i = start; i < gal.items.length; i++) {
      const it = gal.items[i], k = monthKey(it);
      if (k !== lastKey) { chunks.push({ title: monthTitle(it), cells: [] }); lastKey = k; }
      const cell = `<a data-gi="${i}"><img loading="lazy" src="/api/v1/thumb?id=${encodeURIComponent(it.id)}" alt="" onload="this.classList.add('show')" onerror="this.style.opacity=.12">${it.kind === "video" ? `<span class="badge">▶</span>` : it.kind === "live" ? `<span class="badge">LIVE</span>` : ""}</a>`;
      if (!chunks.length && grid) grid.insertAdjacentHTML("beforeend", cell); else chunks[chunks.length - 1].cells.push(cell);
    }
    html = chunks.map((c) => `<div class="gal-month"><h3>${esc(c.title)}</h3></div><div class="gal-grid">${c.cells.join("")}</div>`).join("");
    $("#gallery").insertAdjacentHTML("beforeend", html);
    if (!gal.items.length) $("#gallery").innerHTML = `<p class="muted">Пока пусто.</p>`;
  } catch (e) { toast(e.message, true); }
  gal.loading = false; $("#galMore").style.display = gal.done ? "none" : "grid";
}
$("#gallery").addEventListener("click", (e) => { const a = e.target.closest("[data-gi]"); if (a) lbOpen(Number(a.dataset.gi)); });
new IntersectionObserver((en) => { if (en[0].isIntersecting && page === "photos") galMore(); }, { rootMargin: "800px" }).observe($("#galMore"));

// ---------- просмотр: листание свайпом, стрелками, клавишами ----------
let lbIndex = -1, lbList = null; // lbList — свой список (в этот день, места), иначе галерея
const lbItems = () => lbList || gal.items;
function lbOpen(i) { lbIndex = i; $("#lightbox").classList.remove("hidden"); document.body.style.overflow = "hidden"; lbShow(0); }
function lbClose() { $("#lightbox").classList.add("hidden"); document.body.style.overflow = ""; $("#lbMedia").innerHTML = ""; lbIndex = -1; lbList = null; }
let heicLib = null;
function loadHeicLib() {
  if (!heicLib) heicLib = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/libheif-js@1.17.1/libheif-wasm/libheif-bundle.js";
    s.onload = async () => { try { let l = window.libheif(); if (l && l.then) l = await l; res(l); } catch (e) { rej(e); } };
    s.onerror = () => { heicLib = null; rej(new Error("декодер HEIC не загрузился")); };
    document.head.appendChild(s);
  });
  return heicLib;
}
async function lbDecodeHeic(it, url) {
  const media = $("#lbMedia"); if (!media) return;
  const stale = () => lbItems()[lbIndex] !== it;
  const note = document.createElement("div"); note.className = "lb-note"; note.textContent = "Открываю оригинал HEIC…"; media.appendChild(note);
  try {
    const [lib, buf] = await Promise.all([loadHeicLib(), fetch(url).then((r) => r.arrayBuffer())]);
    const img = new lib.HeifDecoder().decode(new Uint8Array(buf))[0];
    const w = img.get_width(), h = img.get_height();
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const ctx = cv.getContext("2d");
    const id = ctx.createImageData(w, h);
    await new Promise((res, rej) => img.display(id, (d) => d ? res(d) : rej(new Error("не удалось раскрыть"))));
    ctx.putImageData(id, 0, 0);
    // уменьшаем до экранного размера: быстрее и легче
    const k = Math.min(1, 2600 / Math.max(w, h)), c2 = document.createElement("canvas"); c2.width = Math.round(w * k); c2.height = Math.round(h * k);
    c2.getContext("2d").drawImage(cv, 0, 0, c2.width, c2.height);
    const blob = await new Promise((r) => c2.toBlob(r, "image/jpeg", 0.9));
    if (stale()) return;
    const el = media.querySelector("img"); if (el) el.src = URL.createObjectURL(blob);
    note.remove();
  } catch (e) { if (!stale()) { note.textContent = "Оригинал HEIC не открылся — показано превью. Скачай файл кнопкой ⤓."; setTimeout(() => note.remove(), 6000); } }
}
function lbShow(dir) {
  const it = lbItems()[lbIndex]; if (!it) return;
  const media = $("#lbMedia");
  const fill = () => {
    const url = `/api/v1/file?id=${encodeURIComponent(it.id)}`;
    const thumb = `/api/v1/thumb?id=${encodeURIComponent(it.id)}`;
    if (it.kind === "video" || /\.(mov|mp4|m4v)$/i.test(it.path)) {
      media.innerHTML = `<video src="${url}" poster="${thumb}" controls playsinline autoplay></video>`;
    } else {
      // сначала превью, потом оригинал (HEIC браузеры кроме Safari не показывают — тогда остаётся превью)
      media.innerHTML = `<img src="${thumb}" alt="">`;
      const full = new Image(); full.onload = () => { const im = media.querySelector("img"); if (im && lbIndex === lbItems().indexOf(it)) im.src = url; };
      // HEIC Chrome/Edge не открывают: превью от iPhone — квадратная обрезка, поэтому раскрываем оригинал декодером прямо в браузере
      full.onerror = () => { if (/\.(heic|heif)$/i.test(it.path)) lbDecodeHeic(it, url); };
      full.src = url;
    }
    $("#lbDate").textContent = new Date((it.date || it.time) * 1000).toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
    $("#lbMeta").textContent = `${it.path.split("/").pop()} · ${fmtBytes(it.size)}${it.album ? " · " + it.album : ""}`;
    $("#lbDownload").href = url; $("#lbDownload").setAttribute("download", it.path.split("/").pop());
    $("#lbCount").textContent = `${lbIndex + 1} / ${(lbList ? lbList.length : gal.total).toLocaleString("ru-RU")}`;
    media.className = "lb-media";
  };
  if (dir) { media.className = "lb-media " + (dir > 0 ? "swipe-l" : "swipe-r"); setTimeout(fill, 180); } else fill();
  if (!lbList && lbIndex > gal.items.length - 20) galMore(); // подгружаем дальше заранее
}
function lbStep(d) {
  const n = lbIndex + d;
  if (n < 0 || n >= lbItems().length) { $("#lbMedia").animate([{ transform: "translateX(0)" }, { transform: `translateX(${d > 0 ? -18 : 18}px)` }, { transform: "translateX(0)" }], 260); return; }
  lbIndex = n; lbShow(d);
}
$("#lbClose").onclick = lbClose;
$("#lbPrev").onclick = () => lbStep(-1);
$("#lbNext").onclick = () => lbStep(1);
document.addEventListener("keydown", (e) => {
  if ($("#lightbox").classList.contains("hidden")) return;
  if (e.key === "ArrowLeft") lbStep(-1); else if (e.key === "ArrowRight") lbStep(1); else if (e.key === "Escape") lbClose();
});
(() => {
  let x0 = null, y0 = 0, t0 = 0;
  const st = $("#lbStage");
  st.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); }, { passive: true });
  st.addEventListener("touchmove", (e) => {
    if (x0 === null) return; const dx = e.touches[0].clientX - x0;
    $("#lbMedia").style.transform = `translateX(${dx * .6}px)`; $("#lbMedia").style.transition = "none";
  }, { passive: true });
  st.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    $("#lbMedia").style.transform = ""; $("#lbMedia").style.transition = "";
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) lbStep(dx < 0 ? 1 : -1);
    else if (dy > 120 && Math.abs(dy) > Math.abs(dx)) lbClose(); // смахнуть вниз — закрыть
    x0 = null;
  });
})();

// ---------- подтверждение ----------
function askConfirm({ icon = "?", title, text = "", yes = "Да", no = "Отмена", danger = false }) {
  return new Promise((resolve) => {
    $("#cfIco").textContent = icon; $("#cfTitle").textContent = title; $("#cfText").textContent = text;
    $("#cfYes").textContent = yes; $("#cfNo").textContent = no;
    $(".confirm-card").classList.toggle("danger", danger);
    const m = $("#confirmModal"); m.classList.remove("hidden"); buzz(10);
    const done = (v) => { m.classList.add("hidden"); $("#cfYes").onclick = $("#cfNo").onclick = m.onclick = null; resolve(v); };
    $("#cfYes").onclick = () => done(true);
    $("#cfNo").onclick = () => done(false);
    m.onclick = (e) => { if (e.target === m) done(false); };
  });
}

// ---------- мои проекты ----------
async function checkSites() {
  try {
    const r = await api("/api/home/sites");
    (r.sites || []).forEach((s) => {
      const el = $(`[data-site="${s.url}"]`); if (!el) return;
      el.innerHTML = `<span class="dot ${s.ok ? "ok" : "bad"}"></span>${s.ok ? `онлайн · ${s.ms} мс` : "недоступен"}`;
    });
  } catch (e) {}
}

// ---------- сеть ----------
let clients = [];
async function loadClients() {
  try { clients = (await api("/api/home/clients")).clients || []; } catch (e) { $("#clients").innerHTML = `<tr><td class="err">${esc(e.message)}</td></tr>`; return; }
  renderClients();
}
function renderClients() {
  const q = $("#clientSearch").value.toLowerCase();
  const list = clients.filter((c) => !q || (c.name + c.ip + c.mac + (c.vendor || "")).toLowerCase().includes(q));
  const online = clients.filter((c) => c.online).length;
  const src = { custom: "ваше имя", dhcp: "имя устройства", tuya: "умный дом", vendor: "по производителю" };
  $("#clients").innerHTML = `<thead><tr><th></th><th>Устройство · ${online} в сети из ${clients.length}</th><th>IP</th><th class="hide-m">MAC</th><th></th></tr></thead><tbody>` +
    list.map((c) => `<tr class="${c.online ? "" : "off"}"><td style="width:24px"><span class="dot ${c.online ? "ok" : ""}"></span></td>
      <td><b class="cl-name">${esc(c.name || "без имени")}</b><span class="cl-sub">${c.source ? src[c.source] || "" : "не представилось"}${c.vendor && c.source !== "vendor" ? " · " + esc(c.vendor) : ""}</span></td>
      <td class="mono">${esc(c.ip)}</td><td class="mono hide-m">${esc(c.mac)}</td>
      <td class="cl-acts"><button class="icon-btn" data-cl="rename" data-mac="${esc(c.mac)}" title="Переименовать">✎</button>${c.online ? "" : `<button class="icon-btn" data-cl="wol" data-mac="${esc(c.mac)}" title="Разбудить по сети">⏻</button>`}</td></tr>`).join("") + "</tbody>";
}
$("#clientSearch").oninput = renderClients;

// ---------- журналы ----------
const LOG_SOURCES = [["", "Все"], ["zalet", "ZALET"], ["pc", "ПК и Маруся"], ["vpn", "VPN"], ["samba", "Samba"], ["tailscale", "Tailscale"], ["zerotier", "ZeroTier"], ["dns", "DNS"], ["wifi", "Wi-Fi"], ["system", "Система"]];
$("#logChips").innerHTML = LOG_SOURCES.map(([k, v]) => `<button class="chip ${k === "" ? "active" : ""}" data-src="${k}">${v}</button>`).join("");
$$("#logChips .chip").forEach((c) => c.onclick = () => { logSource = c.dataset.src; $$("#logChips .chip").forEach((x) => x.classList.toggle("active", x === c)); loadLogs(); });
$("#logSearch").oninput = () => { clearTimeout(timers.ls); timers.ls = setTimeout(loadLogs, 300); };
async function loadLogs() {
  const q = encodeURIComponent($("#logSearch").value);
  try {
    const r = await api(`/api/home/logs?source=${logSource}&q=${q}&limit=500`);
    $("#log").innerHTML = (r.lines || []).map((l) => `<div class="ln ${l.level}"><span class="t">${esc(l.time)}</span><span class="g">${esc(l.tag)}</span><span class="x">${esc(l.text)}</span></div>`).join("") ||
      `<div class="ln"><span class="t"></span><span class="g"></span><span class="x muted">Ничего не найдено</span></div>`;
  } catch (e) { $("#log").innerHTML = `<p class="err" style="padding:0 18px">${esc(e.message)}</p>`; }
}

// ---------- живость: небо, бегущая строка, мозаика ----------
const MONTHS = ["ЯНВАРЯ", "ФЕВРАЛЯ", "МАРТА", "АПРЕЛЯ", "МАЯ", "ИЮНЯ", "ИЮЛЯ", "АВГУСТА", "СЕНТЯБРЯ", "ОКТЯБРЯ", "НОЯБРЯ", "ДЕКАБРЯ"];
const DAYS = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
function renderSky() {
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
  $("#dateLine").textContent = `${DAYS[d.getDay()]} · ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const sky = $("#sky"); if (!sky) return;
  const night = h < 6 || h >= 21;
  sky.className = "sky " + (night ? "night" : h < 10 ? "morning" : h < 17 ? "day" : "");
  // дуга: солнце с 6 до 21, луна с 21 до 6
  let t = night ? ((h >= 21 ? h - 21 : h + 3) / 9) : (h - 6) / 15;
  t = Math.max(0, Math.min(1, t));
  const orb = $("#orb");
  orb.style.left = (12 + t * 76) + "%";
  orb.style.top = (58 - Math.sin(t * Math.PI) * 38) + "%";
  if (!$("#stars").children.length) {
    $("#stars").innerHTML = Array.from({ length: 40 }, () =>
      `<i style="left:${Math.random() * 100}%;top:${Math.random() * 60}%;animation-delay:${(Math.random() * 3).toFixed(2)}s;opacity:${Math.random() * .4}"></i>`).join("");
  }
  $("#skyCap").textContent = night ? "ДОМ · НОЧЬ" : h < 10 ? "ДОМ · УТРО" : h < 17 ? "ДОМ · ДЕНЬ" : "ДОМ · ВЕЧЕР";
}
function renderHouse() { netViz.update(); }

// ---------- карта сети: роутер в центре, вокруг реальные устройства, по линиям бегут пакеты ----------
async function loadClientsQuiet() { try { clients = (await api("/api/home/clients")).clients || []; netViz.update(); } catch (e) {} }
// карта сети — в netmap.js
function renderMarquee() {
  const s = status; if (!s) return;
  const sv = s.services;
  const items = [
    `ИНТЕРНЕТ <b>${s.internet ? "В СЕТИ" : "НЕТ"}</b>`,
    `ПК <b>${s.pc.online ? "ВКЛЮЧЁН" : "ВЫКЛЮЧЕН"}</b>`,
    `НА SSD <b>${s.photos.files.toLocaleString("ru-RU")} ФОТО</b>`,
    `СВОБОДНО <b>${fmtBytes(s.ssd.free)}</b>`,
    `РОУТЕР <b>${fmtUptime(s.router.uptime)}</b>`,
    s.router.temp ? `ТЕМПЕРАТУРА <b>${s.router.temp.toFixed(0)}°C</b>` : "",
    `VPN <b>${sv.xray ? "ГЕРМАНИЯ" : "ВЫКЛ"}</b>`,
    `TAILSCALE <b>${sv.tailscaled ? "ОНЛАЙН" : "ВЫКЛ"}</b>`,
    devices.length ? `УСТРОЙСТВ <b>${devices.filter((d) => d.online).length}/${devices.length}</b>` : "",
    `ПОСЛЕДНИЙ ЗАЛЁТ <b>${ago(s.photos.last).toUpperCase()}</b>`,
  ].filter(Boolean);
  const html = items.map((x) => `<span>${x}</span>`).join("");
  $("#marquee").innerHTML = html + html; // дважды — для бесшовного цикла
}

let mosaicPool = [], mosaicShown = [];
async function loadMosaic() {
  try { mosaicPool = (await api("/api/home/random?count=36")).items || []; } catch (e) { return; }
  const n = Math.min(window.innerWidth < 860 ? 9 : 12, mosaicPool.length);
  mosaicShown = mosaicPool.splice(0, n);
  $("#mosaic").innerHTML = mosaicShown.map((it, i) => `<div class="ph" data-i="${i}">${imgFor(it)}<span class="when">${esc(new Date((it.date || it.time) * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }))}</span></div>`).join("") ||
    `<p class="muted">Здесь появятся ваши фото, когда ZALET выгрузит их на SSD.</p>`;
  $$("#mosaic img").forEach((img) => img.onload = () => img.classList.add("show"));
  $$("#mosaic .ph").forEach((ph) => ph.onclick = () => { const it = mosaicShown[ph.dataset.i]; if (it) window.open(`/api/v1/file?id=${encodeURIComponent(it.id)}`, "_blank"); });
}
const imgFor = (it) => `<img src="/api/v1/thumb?id=${encodeURIComponent(it.id)}" alt="" loading="lazy">`;
function rotateMosaic() {
  if (page !== "home" || !mosaicPool.length || !mosaicShown.length) return;
  const i = Math.floor(Math.random() * mosaicShown.length);
  const ph = $(`#mosaic .ph[data-i="${i}"]`); if (!ph) return;
  const next = mosaicPool.shift(); mosaicPool.push(mosaicShown[i]); mosaicShown[i] = next;
  const img = new Image(); img.alt = ""; img.src = `/api/v1/thumb?id=${encodeURIComponent(next.id)}`;
  img.onload = () => {
    const old = ph.querySelector("img"); ph.insertBefore(img, old);
    requestAnimationFrame(() => { img.classList.add("show"); old.classList.remove("show"); });
    setTimeout(() => old.remove(), 1300);
    ph.querySelector(".when").textContent = new Date((next.date || next.time) * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  };
}

// ---------- встроенное окно сервиса ----------
function openViewer(title, url) {
  $("#viewerTitle").textContent = title;
  $("#viewerOpen").href = url;
  const f = $("#viewerFrame"); f.classList.remove("ready");
  f.onload = () => f.classList.add("ready");
  f.src = url;
  $("#viewer").classList.remove("hidden");
}
$("#viewerClose").onclick = () => { $("#viewer").classList.add("hidden"); $("#viewerFrame").src = "about:blank"; };

// ---------- плитки быстрого доступа ----------
const IMG = (n) => `https://apodmarchuk.ru/assets/ph/${n}`;
function tilesDef() {
  const host = location.hostname;
  const sv = status?.services || {};
  return [
    { t: "Устройства", s: "свет и выключатели", i: "◐", img: IMG("st-auto.jpg"), page: "devices", ok: !!status?.tuya },
    { t: "Компьютер", s: status?.pc.online ? "включён" : "выключен", i: "⏻", img: IMG("st-srv.jpg"), page: "pc", ok: status?.pc.online },
    { t: "Фото", s: `${(status?.photos.files || 0).toLocaleString("ru-RU")} на SSD`, i: "▣", img: mosaicShown[0] ? `/api/v1/thumb?id=${encodeURIComponent(mosaicShown[0].id)}` : IMG("st-net.jpg"), page: "photos", ok: true },
    { t: "Роутер", s: "LuCI · все настройки", i: "⌁", img: IMG("about-rack.jpg"), view: ["Роутер · LuCI", "/cgi-bin/luci/"], ok: true },
    { t: "VPN", s: "v2raya · обход блокировок", i: "⛨", img: IMG("tile-vpn.jpg"), view: ["Обход блокировок · v2raya", `http://${host}:2017`], ok: !!sv.xray },
    { t: "Роутер", s: "сеть, доступ, ключи", i: "⌘", img: IMG("st-net.jpg"), page: "router", ok: true },
    { t: "Tailscale", s: "удалённый доступ", i: "✶", img: IMG("tile-optic.jpg"), link: "https://login.tailscale.com/admin/machines", ok: !!sv.tailscaled },
    { t: "Журналы", s: "что происходит", i: "≡", img: IMG("tile-cross.jpg"), page: "logs", ok: true },
    { t: "ZeroTier", s: "запасной вход", i: "◇", img: IMG("tile-optic.jpg"), link: "https://my.zerotier.com/network/633e31d8a24936c0", ok: !!sv["zerotier-one"] },
    { t: "Tuya", s: "облако умного дома", i: "☁", img: IMG("st-auto.jpg"), link: "https://platform.tuya.com/cloud/basic?id=p1791753104488dqxkt4&toptab=related&region=EU&deviceTab=all", ok: !!status?.tuya },
    { t: "Терминал РТК", s: "192.168.0.1", i: "⇄", img: IMG("tile-cross.jpg"), link: "http://192.168.0.1", ok: !!status?.internet },
    { t: "Исходники", s: "GitHub · сборки", i: "⌥", img: IMG("about-rack.jpg"), link: "https://github.com/cornetto1488/photo-ssd/actions", ok: null },
  ];
}
function launchTile(x, idx) {
  return `<div class="lt" data-lt="${idx}"><div class="bg" style="background-image:url('${x.img}')"></div>
    <div class="ico">${x.i}</div>${x.ok === null || x.ok === undefined ? "" : `<span class="st"><span class="dot ${x.ok ? "ok" : "bad"}"></span></span>`}
    <h4>${esc(x.t)}</h4><p>${esc(x.s)}</p><span class="tag">${x.view ? "ОТКРЫТЬ ЗДЕСЬ" : x.link ? "ВНЕШНЯЯ ССЫЛКА ↗" : "РАЗДЕЛ ПАНЕЛИ"}</span></div>`;
}
function renderLaunch() {
  const defs = tilesDef();
  $("#launchAll").innerHTML = defs.map(launchTile).join("");
  $$("[data-lt]").forEach((el) => el.onclick = () => {
    const x = defs[el.dataset.lt];
    if (x.page) go(x.page); else if (x.view) openViewer(...x.view); else if (x.link) window.open(x.link, "_blank", "noopener");
  });
}

// ---------- сервисы ----------
let svcInfo = null;
async function loadServiceInfo() { try { svcInfo = await api("/api/home/info"); } catch (e) {} renderServices(); }
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-svc]"); if (!b) return;
  const [name, action] = b.dataset.svc.split(":");
  if (action === "stop" && !(await askConfirm({ icon: "■", title: "Остановить службу?", text: `«${svcInfo?.services?.[name] || name}» перестанет работать, пока вы её не запустите.`, yes: "Остановить", danger: true }))) return;
  if (action === "restart" && !(await askConfirm({ icon: "↻", title: "Перезапустить?", text: `«${svcInfo?.services?.[name] || name}» на несколько секунд будет недоступна.`, yes: "Перезапустить" }))) return;
  b.disabled = true;
  try { await post(`/api/home/service?name=${name}&action=${action}`); toast(({ restart: "Перезапущено", stop: "Остановлено", start: "Запущено" })[action] + ": " + (svcInfo?.services?.[name] || name)); setTimeout(loadStatus, 2500); }
  catch (er) { toast(er.message, true); }
  finally { b.disabled = false; }
});
const RUN = { v2raya: "v2raya", tailscale: "tailscaled", zerotier: "zerotier-one", samba4: "smbd", "pc-remote": "pc-remote", dnsmasq: "dnsmasq", "doh-proxy": "doh-proxy", stubby: "stubby", youtubeUnblock: "youtubeUnblock" };
function renderDeepLinks() {
  const ts = svcInfo?.tailscaleIP || "";
  const L = [
    ["✶", "Tailscale · машины", "все устройства в сети", "https://login.tailscale.com/admin/machines"],
    ["✶", "Tailscale · роутер", ts || "exit node и маршруты", ts ? `https://login.tailscale.com/admin/machines/${ts}` : "https://login.tailscale.com/admin/machines"],
    ["✶", "Tailscale · DNS", "split DNS для home.lan", "https://login.tailscale.com/admin/dns"],
    ["✶", "Tailscale · ключи", "срок действия ключей", "https://login.tailscale.com/admin/settings/keys"],
    ["◇", "ZeroTier · сеть", "участники и адреса", "https://my.zerotier.com/network/633e31d8a24936c0"],
    ["☁", "Tuya · устройства", "права Control", "https://platform.tuya.com/cloud/basic?id=p1791753104488dqxkt4&toptab=related&region=EU&deviceTab=all"],
    ["⌁", "LuCI · Wi-Fi", "сети и пароли", "view:/cgi-bin/luci/admin/network/wireless"],
    ["⌁", "LuCI · пакеты", "установка программ", "view:/cgi-bin/luci/admin/system/package-manager"],
    ["⌁", "LuCI · обзор", "состояние роутера", "view:/cgi-bin/luci/admin/status/overview"],
    ["⇄", "Терминал · порты", "переадресация РТК", "http://192.168.0.1/admin/fw-portfw.asp"],
    ["⌥", "GitHub · сборки", "ZALET, панель", "https://github.com/cornetto1488/photo-ssd/actions"],
    ["✦", "apodmarchuk.ru", "ваш сайт", "https://apodmarchuk.ru"],
  ];
  $("#deepLinks").innerHTML = L.map(([i, t, s, u]) => u.startsWith("view:")
    ? `<a href="#" data-view="${u.slice(5)}" data-title="${esc(t)}"><i>${i}</i><div><b>${esc(t)}</b><span>${esc(s)}</span></div></a>`
    : `<a href="${u}" target="_blank" rel="noopener"><i>${i}</i><div><b>${esc(t)}</b><span>${esc(s)}</span></div></a>`).join("");
  $$("#deepLinks [data-view]").forEach((a) => a.onclick = (e) => { e.preventDefault(); openViewer(a.dataset.title, a.dataset.view); });
}
function renderServices() {
  if (!$("#services")) return;
  const sv = status?.services || {};
  const names = svcInfo?.services || {};
  $("#services").innerHTML = Object.keys(names).sort().map((n) => {
    const running = sv[RUN[n]];
    const known = RUN[n] in sv;
    const on = known ? running : svcInfo?.enabled?.[n];
    return `<div class="card svc"><div class="head"><h4>${esc(names[n])}</h4><span class="state"><span class="dot ${on ? "ok" : "bad"}"></span>${known ? (running ? "работает" : "остановлена") : (on ? "включена" : "выключена")}</span></div>
      <p class="mono-label">/etc/init.d/${esc(n)}</p>
      <div class="svc-actions"><button class="btn" data-svc="${n}:restart">↻ Перезапустить</button>
      <button class="btn btn-danger" data-svc="${n}:stop">■ Стоп</button><button class="btn" data-svc="${n}:start">▶ Старт</button></div></div>`;
  }).join("");
  renderDeepLinks();
}

function renderServicesOld() {
  const sv = status?.services || {};
  const card = (name, ok, desc, addr, links) => `<div class="card svc">
    <div class="head"><h4>${name}</h4>${ok === null ? "" : `<span class="state"><span class="dot ${ok ? "ok" : "bad"}"></span>${ok ? "работает" : "выключен"}</span>`}</div>
    <p>${desc}</p>${addr ? `<div class="addr">${addr}</div>` : ""}
    <div class="links">${links.map(([t, h]) => `<a class="btn" href="${h}" target="_blank" rel="noopener">${t} ↗</a>`).join("")}</div></div>`;
  $("#services").innerHTML = [
    card("Роутер (LuCI)", true, "Все настройки OpenWrt: сеть, Wi-Fi, пакеты, брандмауэр.", "http://192.168.1.2", [["Открыть", "http://192.168.1.2"]]),
    card("ZALET", true, "Выгрузка фото с iPhone, просмотр SSD, корзина, статистика.", "http://192.168.1.1:8099", [["Статус", "/api/v1/ping"]]),
    card("Обход блокировок", !!sv["v2raya"], "v2raya + xray: заблокированное в РФ — через Германию, остальное напрямую.", "http://192.168.1.1:2017", [["v2raya", "http://192.168.1.1:2017"]]),
    card("Сетевая папка", !!sv["smbd"], "Samba: SSD для ПК, iPhone и ТВ. Логин muall.", "\\\\192.168.1.1\\SSD · smb://192.168.1.1", []),
    card("Голосовое управление ПК", !!sv["pc-remote"], "Маруся → виртуальная розетка Tuya → роутер → Wake-on-LAN / выключение.", "", [["Tuya", "https://platform.tuya.com"]]),
    card("Tailscale", !!sv["tailscaled"], "Вход домой откуда угодно, весь интернет телефона через дом.", "router · 100.113.69.110", [["Панель", "https://login.tailscale.com/admin/machines"]]),
    card("ZeroTier", !!sv["zerotier-one"], "Запасной вход домой: сеть 10.10.10.x.", "10.10.10.1", [["Панель", "https://my.zerotier.com"]]),
    card("DNS", !!sv["dnsmasq"], "Шифрованный DNS через AdGuard (DoH, резерв DoT) — режет рекламу во всей сети.", "router.lan · home.lan", []),
    sv["syncthing"] ? card("Syncthing", true, "Больше не нужен — заменён ZALET. Можно удалить.", "http://192.168.1.1:8384", [["Открыть", "http://192.168.1.1:8384"]]) : "",
  ].join("");
}

// ---------- камеры Modus ----------
// Список (порядок, имена, скрытые) хранится на роутере: /api/cameras/config. Новые каналы ищет /api/cameras/scan.
const cams = { home: [], list: [], edit: false, loaded: false, scannedAt: 0, scanning: false, current: null, mode: "archive", busy: false };
let camSaveTimer = null;
const DAY = 24 * 60 * 60 * 1000;

const pad2 = (n) => String(n).padStart(2, "0");
function localDateTimeValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth()+1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
function setCameraPeriod(startMs, endMs) {
  if ($("#camStart")) $("#camStart").value = localDateTimeValue(new Date(startMs));
  if ($("#camEnd")) $("#camEnd").value = localDateTimeValue(new Date(endMs));
}
function setCameraPeriodLastHour() { const e = Date.now(); setCameraPeriod(e - 3600e3, e); }
function camPreset(kind) {
  const now = new Date(), e = now.getTime();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (kind === "15m") setCameraPeriod(e - 15 * 60e3, e);
  else if (kind === "1h") setCameraPeriod(e - 3600e3, e);
  else if (kind === "3h") setCameraPeriod(e - 3 * 3600e3, e);
  else if (kind === "today") setCameraPeriod(midnight, e);
  else if (kind === "yesterday") setCameraPeriod(midnight - DAY, midnight);
  $$(".cam-chips .cam-chip").forEach((c) => c.classList.toggle("on", c.dataset.preset === kind));
}
const camName = (c) => (c.name && c.name.trim()) || `Камера ${c.n}`;

function camsNotice(text, bad) {
  const n = $("#camsNotice"); if (!n) return; n.textContent = text || ""; n.classList.toggle("bad", !!bad);
}
function camsSaveSoon() {
  clearTimeout(camSaveTimer);
  camSaveTimer = setTimeout(() => {
    api("/api/cameras/config", { method: "POST", body: JSON.stringify({ cams: cams.list, scannedAt: cams.scannedAt, home: cams.home }) }).catch(() => toast("Не удалось сохранить порядок камер", true));
  }, 500);
}
async function camsLoadConfig() {
  try {
    const j = await api("/api/cameras/config");
    cams.list = Array.isArray(j.cams) ? j.cams.filter((c) => c && Number.isInteger(c.n)) : [];
    cams.scannedAt = j.scannedAt || 0;
    cams.home = Array.isArray(j.home) ? j.home.filter(Number.isInteger).slice(0, 3) : [];
  } catch (e) { cams.list = []; }
  cams.loaded = true;
}
async function camsScan(manual) {
  if (cams.scanning) return;
  cams.scanning = true;
  const btn = $("#camsScan"); if (btn) { btn.disabled = true; btn.classList.add("spin"); }
  camsNotice("Ищу камеры в Modus…");
  try {
    const j = await api("/api/cameras/scan");
    const known = new Set(cams.list.map((c) => c.n));
    const fresh = (j.cameras || []).filter((n) => !known.has(n));
    fresh.forEach((n) => cams.list.push({ n, name: "", hidden: false }));
    cams.scannedAt = Date.now();
    camsSaveSoon();
    renderCameraGrid();
    camsNotice(fresh.length ? `Найдено новых камер: ${fresh.length} (${fresh.join(", ")}). Всего: ${cams.list.length}.` : `Новых камер нет. Всего: ${cams.list.length}.`);
    if (fresh.length || manual) toast(fresh.length ? `+${fresh.length} камер` : "Новых камер нет");
  } catch (e) {
    camsNotice(`Поиск не удался: ${e.message}`, true);
    if (/сесс|session/i.test(e.message)) camsSessionToggle(true);
  } finally {
    cams.scanning = false;
    if (btn) { btn.disabled = false; btn.classList.remove("spin"); }
  }
}

function renderCameraGrid() {
  const grid = $("#cameraGrid"); if (!grid) return;
  grid.classList.toggle("editing", cams.edit);
  const items = cams.list.filter((c) => cams.edit || !c.hidden);
  if (!items.length) {
    grid.innerHTML = `<div class="cam-empty">Камер пока нет.<br><button class="btn btn-acc" id="camsEmptyScan">🔍 Найти камеры</button></div>`;
    $("#camsEmptyScan").onclick = () => camsScan(true);
    return;
  }
  grid.innerHTML = items.map((c) => `
    <div class="cam-card ${c.hidden ? "is-hidden" : ""} ${cams.current === c.n ? "is-open" : ""}" data-n="${c.n}" ${cams.edit ? 'draggable="true"' : ""}>
      <div class="cam-top">
        <span class="cam-num">${c.n}</span>
        <span class="cam-rec" title="Запись идёт"><i></i>REC</span>
      </div>
      <div class="cam-name">${esc(camName(c))}</div>
      <div class="cam-sub">канал ${c.n}</div>
      ${cams.edit ? `
      <div class="cam-edit">
        <button class="cam-mini" data-act="left" title="Раньше">◀</button>
        <button class="cam-mini" data-act="right" title="Позже">▶</button>
        <button class="cam-mini" data-act="rename" title="Переименовать">✎</button>
        <button class="cam-mini" data-act="hide" title="${c.hidden ? "Показать" : "Скрыть"}">${c.hidden ? "👁" : "🚫"}</button>
      </div>` : `
      <div class="cam-actions">
        <button class="btn cam-live" data-act="live">● Live</button>
        <button class="btn" data-act="archive">Архив</button>
      </div>`}
    </div>`).join("");
  $$(".cam-card", grid).forEach((card) => {
    const n = Number(card.dataset.n);
    card.querySelectorAll("[data-act]").forEach((b) => b.onclick = (ev) => { ev.stopPropagation(); camAction(n, b.dataset.act, b); });
    if (cams.edit) {
      card.ondragstart = (ev) => { ev.dataTransfer.setData("text/plain", String(n)); card.classList.add("drag"); };
      card.ondragend = () => card.classList.remove("drag");
      card.ondragover = (ev) => { ev.preventDefault(); card.classList.add("over"); };
      card.ondragleave = () => card.classList.remove("over");
      card.ondrop = (ev) => {
        ev.preventDefault(); card.classList.remove("over");
        const from = Number(ev.dataTransfer.getData("text/plain"));
        camMove(from, n);
      };
    }
  });
}
function camMove(from, toN) {
  const a = cams.list.findIndex((c) => c.n === from), b = cams.list.findIndex((c) => c.n === toN);
  if (a < 0 || b < 0 || a === b) return;
  const [it] = cams.list.splice(a, 1); cams.list.splice(b, 0, it);
  camsSaveSoon(); renderCameraGrid();
}
function camAction(n, act, btn) {
  const i = cams.list.findIndex((c) => c.n === n); if (i < 0) return;
  if (act === "live") return openCamera(n, "live", btn);
  if (act === "archive") return openCamera(n, "archive", btn);
  if (act === "left" && i > 0) { [cams.list[i - 1], cams.list[i]] = [cams.list[i], cams.list[i - 1]]; }
  else if (act === "right" && i < cams.list.length - 1) { [cams.list[i + 1], cams.list[i]] = [cams.list[i], cams.list[i + 1]]; }
  else if (act === "rename") {
    const v = prompt(`Название камеры ${n}`, cams.list[i].name || "");
    if (v === null) return; cams.list[i].name = v.trim().slice(0, 40);
  } else if (act === "hide") { cams.list[i].hidden = !cams.list[i].hidden; }
  camsSaveSoon(); renderCameraGrid();
}

// ---- Session ID ----
async function camsSessionStatus() {
  const box = $("#camsSessionState"); if (!box) return;
  box.textContent = "Проверяю…"; box.className = "cam-state";
  try {
    const j = await api("/api/cameras/session");
    if (!j.set) { box.textContent = "Session ID не задан"; box.className = "cam-state bad"; }
    else if (j.valid) { box.textContent = `Сессия рабочая (${j.hint})`; box.className = "cam-state ok"; }
    else { box.textContent = `Сессия не принята${j.error ? ": " + j.error : ""} — вставь новый`; box.className = "cam-state bad"; }
  } catch (e) { box.textContent = e.message; box.className = "cam-state bad"; }
}
function camsSessionToggle(force) {
  const p = $("#camsSession"); if (!p) return;
  const show = force === true ? true : p.classList.contains("hidden");
  p.classList.toggle("hidden", !show);
  if (show) camsSessionStatus();
}
async function camsSessionSave() {
  const inp = $("#camsSessionInput"), v = inp.value.trim(); if (!v) return;
  const b = $("#camsSessionSave"); b.disabled = true; b.textContent = "Проверяю…";
  try {
    await post("/api/cameras/session", { session_id: v });
    inp.value = ""; toast("Session ID сохранён");
    await camsSessionStatus();
    if (!cams.list.length) camsScan(false);
  } catch (e) { toast(e.message, true); $("#camsSessionState").textContent = e.message; $("#camsSessionState").className = "cam-state bad"; }
  finally { b.disabled = false; b.textContent = "Сохранить и проверить"; }
}

async function loadCameras() {
  if (!cams.loaded) await camsLoadConfig();
  const grid = $("#cameraGrid");
  if (grid && !grid.dataset.once) { grid.dataset.once = "1"; }
  if (!$("#camStart")?.value || !$("#camEnd")?.value) camPreset("1h");
  tlInit();
  renderCameraGrid();
  // автопоиск: первый заход или раз в сутки подтягиваем новые каналы
  if (!cams.list.length || Date.now() - cams.scannedAt > DAY) camsScan(false);
  else camsNotice(`Камер: ${cams.list.filter((c) => !c.hidden).length}. Выбери период и нажми «Архив» или «Live».`);
}

// ---- плеер ----
async function openCamera(camera, mode, button) {
  if (cams.busy) return;
  let startMs, endMs;
  if (mode === "live") {
    // прямой эфир идёт отдельным эндпоинтом Modus (live-url), период не нужен
  } else {
    startMs = $("#camStart")?.value ? new Date($("#camStart").value).getTime() : NaN;
    endMs = $("#camEnd")?.value ? new Date($("#camEnd").value).getTime() : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) { toast("Проверь начало и конец периода", true); return; }
    if (endMs - startMs > DAY) { toast("Период не больше 24 часов", true); return; }
  }
  cams.busy = true;
  const old = button?.textContent;
  if (button) { button.disabled = true; button.textContent = "…"; }
  camsNotice(`Подключаю камеру ${camera}…`);
  const player = $("#cameraPlayer"), body = $("#cameraPlayerBody");
  try {
    const data = await post("/api/cameras/archive-url", mode === "live" ? { camera, live: true } : { camera, start_ms: startMs, end_ms: endMs, speed: cams.speed > 1 ? cams.speed : 0 });
    cams.current = camera; cams.mode = mode;
    const c = cams.list.find((x) => x.n === camera);
    $("#cameraPlayerTitle").textContent = c ? camName(c) : `Камера ${camera}`;
    $("#cameraPlayerMode").textContent = mode === "live" ? "● LIVE" : "АРХИВ";
    $("#camSpeed")?.classList.toggle("hidden", mode === "live");
    $("#cameraPlayerMode").className = "cam-badge " + (mode === "live" ? "live" : "");
    body.replaceChildren();
    player.classList.remove("hidden");
    if (data && data.stream && /^cam\d+$/.test(data.stream)) {
      const base = "/api/cameras/play/api/";
      const video = document.createElement("video");
      video.controls = true; video.autoplay = true; video.muted = true; video.playsInline = true;
      video.src = camVideoSrc(data.stream);
      const spin = document.createElement("div"); spin.className = "cam-loading"; spin.textContent = "Подключаюсь к камере…";
      video.addEventListener("playing", () => spin.remove());
      video.addEventListener("error", () => {
        spin.textContent = "Не удалось воспроизвести — нажми «Обновить» ещё раз. Поток H.265: нужен Safari или Chrome с аппаратным декодером.";
        spin.classList.add("bad");
      });
      body.append(video, spin);
      const d = data.data || {};
      const fmt = (ms) => ms ? new Date(ms).toLocaleString("ru-RU") : "—";
      $("#cameraPlayerHint").textContent = mode === "live"
        ? "Прямой эфир с камеры. Для просмотра записи выбери период и нажми «Архив»."
        : `Период: ${fmt(startMs)} — ${fmt(endMs)}${cams.speed > 1 ? ` · ускорение ×${cams.speed} (таймлапс)` : ""}. Архив камеры: ${fmt(d.earliest_available_ms)} — ${fmt(d.latest_available_ms)}.`;
      camsNotice("");
      renderCameraGrid();
      player.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      const pre = document.createElement("pre"); pre.textContent = JSON.stringify(data, null, 2); body.appendChild(pre);
      $("#cameraPlayerHint").textContent = "Сервер ответил, но ссылка не распознана.";
    }
  } catch (e) {
    camsNotice(`Не удалось получить поток: ${e.message}`, true);
    toast(e.message || "Ошибка", true);
    if (/сесс|session/i.test(e.message)) camsSessionToggle(true);
  } finally {
    cams.busy = false;
    if (button) { button.disabled = false; button.textContent = old; }
  }
}
function camStep(dir) {
  const vis = cams.list.filter((c) => !c.hidden); if (!vis.length || cams.current == null) return;
  let i = vis.findIndex((c) => c.n === cams.current); i = (i + dir + vis.length) % vis.length;
  openCamera(vis[i].n, cams.mode);
}
$("#camsScan") && ($("#camsScan").onclick = () => camsScan(true));
$("#camsEditBtn") && ($("#camsEditBtn").onclick = () => {
  cams.edit = !cams.edit;
  $("#camsEditBtn").classList.toggle("on", cams.edit);
  $("#camsEditBtn").textContent = cams.edit ? "✓ Готово" : "✎ Порядок";
  renderCameraGrid();
  if (cams.edit) camsNotice("Перетаскивай карточки (или жми ◀ ▶), ✎ — переименовать, 🚫 — скрыть.");
  else camsNotice("");
});
$("#camsSessionBtn") && ($("#camsSessionBtn").onclick = () => camsSessionToggle());
$("#camsSessionSave") && ($("#camsSessionSave").onclick = camsSessionSave);
$("#camsSessionInput") && $("#camsSessionInput").addEventListener("keydown", (e) => { if (e.key === "Enter") camsSessionSave(); });
$("#camLiveAll") && ($("#camLiveAll").onclick = () => { const v = cams.list.find((c) => !c.hidden); if (v) openCamera(v.n, "live"); });
$$(".cam-chips .cam-chip").forEach((c) => c.onclick = () => camPreset(c.dataset.preset));
$("#camStart") && $("#camStart").addEventListener("input", () => $$(".cam-chips .cam-chip").forEach((c) => c.classList.remove("on")));
$("#camEnd") && $("#camEnd").addEventListener("input", () => $$(".cam-chips .cam-chip").forEach((c) => c.classList.remove("on")));
$("#camPrev") && ($("#camPrev").onclick = () => camStep(-1));
$("#camNext") && ($("#camNext").onclick = () => camStep(1));
$("#camReload") && ($("#camReload").onclick = () => cams.current != null && openCamera(cams.current, cams.mode));
$("#cameraPlayerClose") && ($("#cameraPlayerClose").onclick = () => {
  $("#cameraPlayerBody").replaceChildren(); $("#cameraPlayer").classList.add("hidden"); cams.current = null; renderCameraGrid();
});


// ---- таймлайн по суткам и скорость архива ----
cams.speed = 1; cams.win = 15;
const tlPad = (n) => String(n).padStart(2, "0");
const tlDayStr = (d) => `${d.getFullYear()}-${tlPad(d.getMonth() + 1)}-${tlPad(d.getDate())}`;
const tlLabel = (m) => `${tlPad(Math.floor(m / 60))}:${tlPad(m % 60)}`;
let tlTimer = null;
function tlSyncFromInputs() {
  const v = $("#camStart")?.value; if (!v || !$("#camDay")) return;
  const d = new Date(v);
  $("#camDay").value = tlDayStr(d);
  const m = d.getHours() * 60 + d.getMinutes();
  $("#camSlider").value = String(m); $("#camSliderLbl").textContent = tlLabel(m);
  const e = $("#camEnd")?.value ? new Date($("#camEnd").value) : null;
  if (e) { const w = Math.round((e - d) / 60000); $$("#camWin [data-w]").forEach((b) => b.classList.toggle("on", Number(b.dataset.w) === w)); }
}
function tlApply(reopen) {
  const day = $("#camDay").value || tlDayStr(new Date());
  const m = Number($("#camSlider").value);
  $("#camSliderLbl").textContent = tlLabel(m);
  const start = new Date(`${day}T00:00`).getTime() + m * 60000;
  const end = Math.min(start + cams.win * 60000, Date.now());
  if (end <= start) { toast("Это время ещё не наступило", true); return; }
  setCameraPeriod(start, end);
  $$(".cam-chips .cam-chip").forEach((c) => c.classList.remove("on"));
  if (reopen && cams.current != null && cams.mode === "archive") { clearTimeout(tlTimer); tlTimer = setTimeout(() => openCamera(cams.current, "archive"), 250); }
}
function tlInit() {
  if (!$("#camDay")) return;
  const today = new Date(), oldest = new Date(Date.now() - 14 * DAY);
  $("#camDay").max = tlDayStr(today); $("#camDay").min = tlDayStr(oldest);
  tlSyncFromInputs();
}
$("#camSlider") && ($("#camSlider").oninput = () => { $("#camSliderLbl").textContent = tlLabel(Number($("#camSlider").value)); });
$("#camSlider") && ($("#camSlider").onchange = () => tlApply(true));
$("#camDay") && ($("#camDay").onchange = () => tlApply(true));
$$("#camWin [data-w]").forEach((b) => b.onclick = () => { cams.win = Number(b.dataset.w); $$("#camWin [data-w]").forEach((x) => x.classList.toggle("on", x === b)); tlApply(true); });
$("#camWatch") && ($("#camWatch").onclick = () => { const v = cams.current ?? cams.list.find((c) => !c.hidden)?.n; if (v != null) openCamera(v, "archive"); });
$$("#camSpeed [data-sp]").forEach((b) => b.onclick = () => {
  cams.speed = Number(b.dataset.sp);
  $$("#camSpeed [data-sp]").forEach((x) => x.classList.toggle("on", x === b));
  if (cams.current != null && cams.mode === "archive") openCamera(cams.current, "archive");
});
$$(".cam-chips .cam-chip").forEach((c) => c.addEventListener("click", () => setTimeout(tlSyncFromInputs, 0)));

// ---------- камеры на главной (3 слота, камеры выбираются тут же) ----------
// Safari/iPhone играют HLS, остальные — fMP4 (в Chrome «нативный» HLS есть, но он капризнее).
function camVideoSrc(stream) {
  const ua = navigator.userAgent;
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium|Android|Edg/.test(ua));
  const base = "/api/cameras/play/api/";
  const tk = window.ZH_TOKEN ? `&token=${encodeURIComponent(window.ZH_TOKEN)}` : ""; // <video> не умеет слать заголовки
  return apple ? `${base}stream.m3u8?src=${stream}&mp4${tk}` : `${base}stream.mp4?src=${stream}${tk}`;
}
const homeCams = { gen: 0, edit: false };
function homeCamsStop() {
  homeCams.gen++;
  const box = $("#homeCams"); if (box) box.querySelectorAll("video").forEach((v) => { v.removeAttribute("src"); v.load(); });
}
function homeCamsIds() {
  const vis = cams.list.filter((c) => !c.hidden).map((c) => c.n);
  const ids = cams.home.filter((n) => vis.includes(n));
  for (const n of vis) { if (ids.length >= 3) break; if (!ids.includes(n)) ids.push(n); }
  return ids.slice(0, 3);
}
async function homeCamsStart() {
  const box = $("#homeCams"); if (!box) return;
  if (!cams.loaded) await camsLoadConfig();
  if (!cams.list.length) { box.innerHTML = `<div class="cam-empty">Камеры ещё не найдены.<br><button class="btn btn-acc" id="homeCamsFind">🔍 Найти камеры</button></div>`; $("#homeCamsFind").onclick = async () => { await camsScan(true); homeCamsStart(); }; return; }
  const gen = ++homeCams.gen;
  const ids = homeCamsIds();
  const opts = cams.list.filter((c) => !c.hidden).map((c) => `<option value="${c.n}">${esc(camName(c))}</option>`).join("");
  box.classList.toggle("editing", homeCams.edit);
  box.innerHTML = ids.map((n, i) => {
    const c = cams.list.find((x) => x.n === n);
    return `<div class="home-cam" data-slot="${i}" data-n="${n}">
      <video muted autoplay playsinline></video>
      <div class="home-cam-bar"><span class="cam-badge live">● LIVE</span><b>${esc(camName(c))}</b></div>
      <div class="home-cam-msg">Подключаюсь…</div>
      <select class="home-cam-pick">${opts}</select>
    </div>`;
  }).join("");
  box.querySelectorAll(".home-cam").forEach((tile, i) => {
    const n = Number(tile.dataset.n);
    const sel = $("select", tile); sel.value = String(n);
    sel.onchange = () => { const arr = homeCamsIds(); arr[i] = Number(sel.value); cams.home = arr; camsSaveSoon(); homeCamsStart(); };
    tile.onclick = (e) => { if (homeCams.edit || e.target.closest("select")) return; go("cameras"); openCamera(n, "live"); };
    setTimeout(() => { if (gen === homeCams.gen) homeCamStream(tile, n, gen); }, i * 600);
  });
}
async function homeCamStream(tile, n, gen) {
  const msg = $(".home-cam-msg", tile), v = $("video", tile);
  try {
    const d = await post("/api/cameras/archive-url", { camera: n, slot: "h", live: true });
    if (gen !== homeCams.gen || !d.stream) return;
    v.addEventListener("playing", () => msg.classList.add("hidden"), { once: true });
    v.addEventListener("error", () => { msg.textContent = "Нет сигнала · нажми, чтобы открыть"; msg.classList.remove("hidden"); }, { once: true });
    v.src = camVideoSrc(d.stream);
  } catch (e) { msg.textContent = e.message; }
}
$("#homeCamsEdit") && ($("#homeCamsEdit").onclick = () => {
  homeCams.edit = !homeCams.edit;
  $("#homeCamsEdit").textContent = homeCams.edit ? "✓ Готово" : "⚙ Выбрать камеры";
  $("#homeCams").classList.toggle("editing", homeCams.edit);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) homeCamsStop(); else if (page === "home" && started) homeCamsStart();
});

// ---------- запуск ----------
function start() {
  if (started) return; started = true;
  tick(); renderSky(); timers.clock = setInterval(() => { tick(); renderSky(); }, 10000);
  setTimeout(() => $("#boot").classList.add("done"), 700);
  loadDevices(); loadServiceInfo(); loadClientsQuiet(); checkSites(); netViz.start(); cozyStart(); nowStart();
  timers.sites = setInterval(checkSites, 60000);
  timers.netc = setInterval(loadClientsQuiet, 20000);
  const p = (location.hash || "#home").slice(1);
  go(["home", "devices", "pc", "photos", "cameras", "network", "router", "logs", "vault", "access", "services", "stats", "vacuum", "kiosk"].includes(p) ? p : "home");
  timers.status = setInterval(() => { if (["home", "pc", "services"].includes(page)) loadStatus(); }, 10000);
  timers.devs = setInterval(() => { if (page === "devices") loadDevices(); }, 15000);
  timers.logs = setInterval(() => { if (page === "logs" && $("#logLive").checked) loadLogs(); }, 4000);
  timers.clients = setInterval(() => { if (page === "router") { loadClients(); renderRouterStats(); } }, 15000);
  if (!status) loadStatus();
}

// запуск — когда загружены все модули (cozy, vault, access, now)
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const info = await api("/api/home/pin-info");
    if (info.authed || window.ZH_TOKEN) { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); start(); }
    else showLock();
  } catch (e) { showLock(); }
});

// ---- боковая панель: закрепление ----
(() => {
  const apply = (on) => { document.body.classList.toggle("side-pinned", on); const b = $("#sideToggle"); if (b) { b.textContent = on ? "⇤" : "⇥"; b.title = on ? "Свернуть меню" : "Закрепить меню"; } };
  let on = false; try { on = localStorage.getItem("zh-side") === "1"; } catch (e) {}
  apply(on);
  const b = $("#sideToggle"); if (b) b.onclick = () => { on = !on; apply(on); try { localStorage.setItem("zh-side", on ? "1" : "0"); } catch (e) {} };
})();
