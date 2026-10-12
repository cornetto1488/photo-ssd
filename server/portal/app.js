"use strict";
// ZALET HOME — панель дома.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let TOKEN = "";
try { TOKEN = localStorage.getItem("zaletToken") || ""; } catch (e) {}
let page = "home";
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
  const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } });
  if (r.status === 401) { logout(); throw new Error("Неверный токен"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("Ошибка " + r.status));
  return j;
}
const post = (path, body) => api(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

// ---------- вход ----------
async function login(tok) {
  TOKEN = tok.trim();
  try {
    await api("/api/v1/ping");
    try { localStorage.setItem("zaletToken", TOKEN); } catch (e) {}
    $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
    start();
  } catch (e) {
    $("#loginErr").textContent = e.message || "Не получилось войти";
    $("#login").classList.remove("hidden"); $("#app").classList.add("hidden");
  }
}
function logout() {
  try { localStorage.removeItem("zaletToken"); } catch (e) {}
  TOKEN = ""; Object.values(timers).forEach(clearInterval);
  $("#app").classList.add("hidden"); $("#login").classList.remove("hidden");
}
$("#loginBtn").onclick = () => login($("#tokenInput").value);
$("#tokenInput").onkeydown = (e) => { if (e.key === "Enter") login($("#tokenInput").value); };
$("#logoutBtn").onclick = logout;

// ---------- навигация ----------
function go(p) {
  if (p === "more") { openMore(); return; }
  page = p;
  $$("[data-page]").forEach((a) => a.classList.toggle("active", a.dataset.page === p));
  $$(".page").forEach((s) => s.classList.toggle("active", s.id === "page-" + p));
  try { history.replaceState(null, "", "#" + p); } catch (e) {}
  window.scrollTo({ top: 0, behavior: "smooth" });
  ({ home: loadStatus, devices: () => loadDevices(), pc: loadStatus, photos: loadPhotos, network: loadClients, logs: loadLogs, services: loadStatus })[p]?.();
}
function openMore() {
  const items = [["network", "Сеть"], ["services", "Сервисы"]];
  const pick = items.map(([k, v]) => `<button class="btn" data-go="${k}">${v}</button>`).join("");
  const t = $("#toast"); t.innerHTML = `<div style="display:flex;gap:8px">${pick}</div>`; t.classList.remove("bad"); t.classList.add("show");
  t.style.pointerEvents = "auto";
  $$("[data-go]", t).forEach((b) => b.onclick = () => { t.classList.remove("show"); t.style.pointerEvents = "none"; go(b.dataset.go); });
  clearTimeout(timers.toast); timers.toast = setTimeout(() => { t.classList.remove("show"); t.style.pointerEvents = "none"; }, 5000);
}
$$("[data-page]").forEach((a) => a.onclick = () => go(a.dataset.page));

// быстрые действия
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act; b.disabled = true;
  try {
    if (act === "pc-on") { await post("/api/home/pc?action=on"); toast("Включаю компьютер…"); }
    if (act === "pc-off") { if (!confirm("Выключить компьютер?")) return; await post("/api/home/pc?action=off"); toast("Компьютер выключается"); }
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
  renderTiles(); renderPC(); renderServices();
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
  renderDevices();
}
function devCard(d) {
  let on = false, controls = "";
  if (d.kind === "light") {
    on = !!val(d, "switch_led");
    const bv2 = val(d, "bright_value_v2"), bv1 = val(d, "bright_value");
    const pct = bv2 !== undefined ? Math.round((bv2 - 10) / 990 * 100) : bv1 !== undefined ? Math.round((bv1 - 10) / 245 * 100) : 50;
    const tv2 = val(d, "temp_value_v2"), tv1 = val(d, "temp_value");
    const tp = tv2 !== undefined ? Math.round(tv2 / 10) : tv1 !== undefined ? Math.round(tv1 / 2.55) : 50;
    controls = `<div class="range-row"><span>ЯРКОСТЬ</span><input type="range" min="1" max="100" value="${Math.max(1, pct)}" data-bright="${d.id}"></div>
      <div class="range-row"><span>ТОН</span><input type="range" class="range-temp" min="0" max="100" value="${tp}" data-temp="${d.id}"></div>`;
  } else if (d.kind === "switch" || d.kind === "plug") {
    on = !!val(d, "switch_1");
  } else if (d.kind === "pc") {
    on = status ? status.pc.online : !!val(d, "switch_1");
  }
  const canToggle = ["light", "switch", "plug", "pc"].includes(d.kind);
  const kindName = { light: "лампа", switch: "выключатель", plug: "розетка", pc: "компьютер · Маруся", gateway: "шлюз", other: "устройство" }[d.kind] || "";
  return `<div class="dev ${on ? "on" : ""} ${d.online ? "" : "offline"}" data-dev="${d.id}">
    <div class="top-row">
      ${d.icon ? `<img src="${esc(d.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<img alt="">`}
      <div style="min-width:0">
        <div class="name">${esc(d.name)}</div>
        <div class="meta"><span class="dot ${d.online ? "ok" : "bad"}" style="width:6px;height:6px"></span> ${d.online ? "в сети" : "не в сети"} · ${kindName}</div>
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
    if (d.kind === "pc") { try { await post("/api/home/pc?action=" + (on ? "on" : "off")); toast(on ? "Включаю компьютер…" : "Выключаю компьютер…"); } catch (er) { toast(er.message, true); } return; }
    const code = d.kind === "light" ? "switch_led" : "switch_1";
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
    const tq = encodeURIComponent(TOKEN);
    $("#thumbs").innerHTML = (items.items || []).map((it) => {
      const name = it.path.split("/").pop();
      return `<a href="/api/v1/file?id=${encodeURIComponent(it.id)}&token=${tq}" target="_blank" title="${esc(it.path)}">
        <img src="/api/v1/thumb?id=${encodeURIComponent(it.id)}&token=${tq}" loading="lazy" alt="" onerror="this.style.opacity=.15">
        <span class="cap">${esc(name)}</span></a>`;
    }).join("") || `<p class="muted">Пока пусто.</p>`;
  } catch (e) { $("#photoStats").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

// ---------- сеть ----------
let clients = [];
async function loadClients() {
  try { clients = (await api("/api/home/clients")).clients || []; } catch (e) { $("#clients").innerHTML = `<tr><td class="err">${esc(e.message)}</td></tr>`; return; }
  renderClients();
}
function renderClients() {
  const q = $("#clientSearch").value.toLowerCase();
  const list = clients.filter((c) => !q || (c.name + c.ip + c.mac).toLowerCase().includes(q));
  const online = clients.filter((c) => c.online).length;
  $("#clients").innerHTML = `<thead><tr><th></th><th>Устройство · ${online} в сети из ${clients.length}</th><th>IP</th><th>MAC</th></tr></thead><tbody>` +
    list.map((c) => `<tr class="${c.online ? "" : "off"}"><td style="width:24px"><span class="dot ${c.online ? "ok" : ""}"></span></td>
      <td>${esc(c.name || "без имени")}</td><td class="mono">${esc(c.ip)}</td><td class="mono">${esc(c.mac)}</td></tr>`).join("") + "</tbody>";
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

// ---------- сервисы ----------
function renderServices() {
  const sv = status?.services || {};
  const card = (name, ok, desc, addr, links) => `<div class="card svc">
    <div class="head"><h4>${name}</h4>${ok === null ? "" : `<span class="state"><span class="dot ${ok ? "ok" : "bad"}"></span>${ok ? "работает" : "выключен"}</span>`}</div>
    <p>${desc}</p>${addr ? `<div class="addr">${addr}</div>` : ""}
    <div class="links">${links.map(([t, h]) => `<a class="btn" href="${h}" target="_blank" rel="noopener">${t} ↗</a>`).join("")}</div></div>`;
  $("#services").innerHTML = [
    card("Роутер (LuCI)", true, "Все настройки OpenWrt: сеть, Wi-Fi, пакеты, брандмауэр.", "http://192.168.1.2", [["Открыть", "http://192.168.1.2"]]),
    card("ZALET", true, "Выгрузка фото с iPhone, просмотр SSD, корзина, статистика.", "http://192.168.1.1:8099", [["Статус", "/api/v1/ping?token=" + encodeURIComponent(TOKEN)]]),
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
  tick(); timers.clock = setInterval(tick, 10000);
  const p = (location.hash || "#home").slice(1);
  go(["home", "devices", "pc", "photos", "network", "logs", "services"].includes(p) ? p : "home");
  timers.status = setInterval(() => { if (["home", "pc", "services"].includes(page)) loadStatus(); }, 10000);
  timers.devs = setInterval(() => { if (page === "devices") loadDevices(); }, 15000);
  timers.logs = setInterval(() => { if (page === "logs" && $("#logLive").checked) loadLogs(); }, 4000);
  timers.clients = setInterval(() => { if (page === "network") loadClients(); }, 15000);
  if (!status) loadStatus();
}

if (TOKEN) login(TOKEN); else $("#login").classList.remove("hidden");
