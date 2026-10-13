"use strict";
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
  ({ home: loadStatus, devices: () => loadDevices(), pc: loadStatus, photos: loadPhotos, router: () => { loadStatus(); loadClients(); loadAccess(); }, logs: loadLogs, vault: loadVault, services: () => { loadStatus(); loadServiceInfo(); } })[p]?.();
}
function openMore() {
  const items = [["pc", "Компьютер"], ["logs", "Журналы"], ["services", "Сервисы"]];
  const pick = items.map(([k, v]) => `<button class="btn" data-go="${k}">${v}</button>`).join("");
  const t = $("#toast"); t.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">${pick}</div>`; t.classList.remove("bad"); t.classList.add("show");
  t.style.pointerEvents = "auto";
  $$("[data-go]", t).forEach((b) => b.onclick = () => { t.classList.remove("show"); t.style.pointerEvents = "none"; go(b.dataset.go); });
  clearTimeout(timers.toast); timers.toast = setTimeout(() => { t.classList.remove("show"); t.style.pointerEvents = "none"; }, 5000);
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
const gal = { kind: "", items: [], total: 0, loading: false, done: false };
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
    const q = `/api/v1/items?limit=120&offset=${gal.items.length}${gal.kind ? "&kind=" + gal.kind : ""}`;
    const r = await api(q);
    const start = gal.items.length;
    gal.items.push(...(r.items || [])); gal.total = r.total;
    if (gal.items.length >= r.total || !(r.items || []).length) gal.done = true;
    $("#galCount").textContent = `${gal.total.toLocaleString("ru-RU")} ${plural(gal.total, "файл", "файла", "файлов")}`;
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
let lbIndex = -1;
function lbOpen(i) { lbIndex = i; $("#lightbox").classList.remove("hidden"); document.body.style.overflow = "hidden"; lbShow(0); }
function lbClose() { $("#lightbox").classList.add("hidden"); document.body.style.overflow = ""; $("#lbMedia").innerHTML = ""; lbIndex = -1; }
function lbShow(dir) {
  const it = gal.items[lbIndex]; if (!it) return;
  const media = $("#lbMedia");
  const fill = () => {
    const url = `/api/v1/file?id=${encodeURIComponent(it.id)}`;
    const thumb = `/api/v1/thumb?id=${encodeURIComponent(it.id)}`;
    if (it.kind === "video" || /\.(mov|mp4|m4v)$/i.test(it.path)) {
      media.innerHTML = `<video src="${url}" poster="${thumb}" controls playsinline autoplay></video>`;
    } else {
      // сначала превью, потом оригинал (HEIC браузеры кроме Safari не показывают — тогда остаётся превью)
      media.innerHTML = `<img src="${thumb}" alt="">`;
      const full = new Image(); full.onload = () => { const im = media.querySelector("img"); if (im && lbIndex === gal.items.indexOf(it)) im.src = url; }; full.src = url;
    }
    $("#lbDate").textContent = new Date((it.date || it.time) * 1000).toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
    $("#lbMeta").textContent = `${it.path.split("/").pop()} · ${fmtBytes(it.size)}${it.album ? " · " + it.album : ""}`;
    $("#lbDownload").href = url; $("#lbDownload").setAttribute("download", it.path.split("/").pop());
    $("#lbCount").textContent = `${lbIndex + 1} / ${gal.total.toLocaleString("ru-RU")}`;
    media.className = "lb-media";
  };
  if (dir) { media.className = "lb-media " + (dir > 0 ? "swipe-l" : "swipe-r"); setTimeout(fill, 180); } else fill();
  if (lbIndex > gal.items.length - 20) galMore(); // подгружаем дальше заранее
}
function lbStep(d) {
  const n = lbIndex + d;
  if (n < 0 || n >= gal.items.length) { $("#lbMedia").animate([{ transform: "translateX(0)" }, { transform: `translateX(${d > 0 ? -18 : 18}px)` }, { transform: "translateX(0)" }], 260); return; }
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
const netViz = (() => {
  const cv = $("#netCanvas"); const ctx = cv.getContext("2d");
  let nodes = [], packets = [], W = 0, H = 0, dpr = 1, raf = 0, t0 = performance.now();
  const COL = { pc: [255, 90, 31], dev: [59, 224, 140], cl: [154, 163, 214] };
  function resize() {
    const r = cv.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); layout();
  }
  function update() {
    const list = [];
    if (status) list.push({ id: "pc", label: "ПК", type: "pc", on: status.pc.online });
    devices.filter((d) => d.kind !== "pc" && d.kind !== "gateway").forEach((d) =>
      list.push({ id: d.id, label: d.name.replace("Лампочка", "Лампа"), type: "dev", on: d.online && !!(d.kind === "light" ? val(d, "switch_led") : val(d, "switch_1")), online: d.online }));
    clients.filter((c) => c.online && c.ip !== status?.pc.ip).slice(0, window.innerWidth < 600 ? 14 : 24).forEach((c) =>
      list.push({ id: c.mac, label: (c.name || c.ip.split(".").pop()).slice(0, 14), type: "cl", on: true }));
    const old = Object.fromEntries(nodes.map((n) => [n.id, n]));
    nodes = list.map((n, i) => ({ ...n, phase: old[n.id]?.phase ?? Math.random() * 6.28, i }));
    $("#nvCount").textContent = `${nodes.filter((n) => n.type === "cl" || n.on).length} АКТИВНО`;
    layout();
  }
  function layout() {
    const cx = W / 2, cy = H / 2, n = nodes.length || 1;
    nodes.forEach((nd, i) => {
      const ring = nd.type === "cl" ? 0.42 : nd.type === "pc" ? 0.2 : 0.31;
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      nd.bx = cx + Math.cos(a) * Math.min(W, H) * ring * 1.15; nd.by = cy + Math.sin(a) * Math.min(W, H) * ring;
    });
  }
  function draw(now) {
    const t = (now - t0) / 1000, cx = W / 2, cy = H / 2;
    ctx.clearRect(0, 0, W, H);
    // кольца-радар
    for (let k = 1; k <= 3; k++) {
      ctx.beginPath(); ctx.ellipse(cx, cy, Math.min(W, H) * (0.14 * k + 0.06) * 1.15, Math.min(W, H) * (0.14 * k + 0.06), 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(242,240,237,${0.05 - k * 0.008})`; ctx.lineWidth = 1; ctx.stroke();
    }
    const sweep = (t * 0.6) % (Math.PI * 2);
    const grad = ctx.createConicGradient ? ctx.createConicGradient(sweep, cx, cy) : null;
    if (grad) { grad.addColorStop(0, "rgba(255,90,31,.18)"); grad.addColorStop(0.08, "rgba(255,90,31,0)"); grad.addColorStop(1, "rgba(255,90,31,0)");
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(cx, cy, Math.max(W, H), 0, Math.PI * 2); ctx.fill(); }
    // связи и пакеты
    nodes.forEach((nd) => {
      nd.x = nd.bx + Math.sin(t * 0.7 + nd.phase) * 4; nd.y = nd.by + Math.cos(t * 0.6 + nd.phase) * 4;
      const c = COL[nd.type], alpha = nd.on ? 0.35 : 0.1;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nd.x, nd.y);
      ctx.strokeStyle = `rgba(${c},${alpha})`; ctx.lineWidth = nd.type === "pc" ? 1.6 : 1; ctx.setLineDash(nd.on ? [] : [3, 5]); ctx.stroke(); ctx.setLineDash([]);
      if (nd.on && Math.random() < (nd.type === "pc" ? 0.05 : 0.02)) packets.push({ n: nd, p: 0, out: Math.random() < 0.5, sp: 0.5 + Math.random() * 0.6 });
    });
    packets = packets.filter((pk) => (pk.p += pk.sp * 0.016) < 1);
    packets.forEach((pk) => {
      const f = pk.out ? pk.p : 1 - pk.p, x = cx + (pk.n.x - cx) * f, y = cy + (pk.n.y - cy) * f, c = COL[pk.n.type];
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fillStyle = `rgba(${c},.95)`; ctx.shadowColor = `rgb(${c})`; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowBlur = 0;
    });
    // узлы
    ctx.font = "500 10px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
    nodes.forEach((nd) => {
      const c = COL[nd.type], r = nd.type === "pc" ? 7 : 4.5;
      if (nd.on) { ctx.beginPath(); ctx.arc(nd.x, nd.y, r + 6 + Math.sin(t * 2 + nd.phase) * 2, 0, Math.PI * 2); ctx.fillStyle = `rgba(${c},.12)`; ctx.fill(); }
      ctx.beginPath(); ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2); ctx.fillStyle = nd.on ? `rgb(${c})` : "rgba(91,91,100,.9)"; ctx.fill();
      ctx.fillStyle = nd.on ? "rgba(242,240,237,.85)" : "rgba(140,140,150,.6)"; ctx.fillText(nd.label, nd.x, nd.y + r + 13);
    });
    // роутер в центре
    const pulse = 1 + Math.sin(t * 2.2) * 0.06;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 46 * pulse); g.addColorStop(0, "rgba(255,138,76,.55)"); g.addColorStop(1, "rgba(255,90,31,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 46 * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI / 4);
    const s = 26; const lg = ctx.createLinearGradient(-s / 2, -s / 2, s / 2, s / 2); lg.addColorStop(0, "#ff8a4c"); lg.addColorStop(1, "#ff5a1f");
    ctx.fillStyle = lg; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-s / 2, -s / 2, s, s, 7) : ctx.rect(-s / 2, -s / 2, s, s); ctx.fill(); ctx.restore();
    ctx.fillStyle = "rgba(242,240,237,.9)"; ctx.font = "700 11px 'Onest', sans-serif"; ctx.fillText("РОУТЕР", cx, cy + 34);
    raf = requestAnimationFrame(draw);
  }
  function start() { resize(); cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }
  window.addEventListener("resize", () => { if (W) resize(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelAnimationFrame(raf); else if (W) raf = requestAnimationFrame(draw); });
  return { start, update };
})();
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
  $("#launch").innerHTML = defs.slice(0, 8).map(launchTile).join("");
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

// ---------- запуск ----------
function start() {
  if (started) return; started = true;
  tick(); renderSky(); timers.clock = setInterval(() => { tick(); renderSky(); }, 10000);
  setTimeout(() => $("#boot").classList.add("done"), 700);
  loadDevices(); loadServiceInfo(); loadClientsQuiet(); checkSites(); netViz.start(); cozyStart(); nowStart();
  timers.sites = setInterval(checkSites, 60000);
  timers.netc = setInterval(loadClientsQuiet, 20000);
  const p = (location.hash || "#home").slice(1);
  go(["home", "devices", "pc", "photos", "network", "router", "logs", "vault", "access", "services"].includes(p) ? p : "home");
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
    if (info.authed) { $("#app").classList.remove("hidden"); start(); }
    else showLock();
  } catch (e) { showLock(); }
});
