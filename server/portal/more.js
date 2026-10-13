"use strict";
// ZALET HOME 3.6 — агенты ПК, фото (в этот день, места, альбомы, файлы SSD), автоматика, флешка, ночь и зима.

const fmtDate = (ts, o = { day: "numeric", month: "long", year: "numeric" }) => new Date(ts * 1000).toLocaleDateString("ru-RU", o);
const thumb = (id) => `/api/v1/thumb?id=${encodeURIComponent(id)}`;

// ---------- навигация: новые страницы ----------
const _go = go;
go = function (p) {
  _go(p);
  clearInterval(timers.agents);
  if (p === "pc") { loadAgents(); timers.agents = setInterval(loadAgents, 5000); }
  if (p === "photos") photoTab(curPhotoTab, true);
  if (p === "router") loadUSB();
  if (p === "home") { loadHomeDay(); loadEvents("#homeEvents", 8); }
};

// ---------- агенты ПК ----------
let agents = [];
async function loadAgents() {
  try { agents = (await api("/api/home/pc/agent")).agents || []; } catch (e) { return; }
  renderAgents();
}
const pctBar = (v) => `<div class="bar"><i style="width:${Math.max(2, Math.min(100, v || 0))}%"></i></div>`;
function renderAgents() {
  const el = $("#agents");
  if (!agents.length) {
    el.innerHTML = `<div class="card agent-empty"><div class="gate-ico">⌨</div><h3 class="display">АГЕНТ ZALET</h3>
      <p class="muted">Маленькая программа для компьютера: показывает загрузку процессора, память, температуру и диски, делает скриншоты, выключает и усыпляет по таймеру, выводит сообщения на экран.
      Для Windows — один файл: заменяет прежний PC-Remote, голосовое выключение через Марусю продолжит работать.</p>
      <button class="btn btn-acc" data-agent-get>⤓ Скачать агент</button></div>`;
    return;
  }
  el.innerHTML = agents.map((a, i) => {
    const s = a.stats || {}, u = a.user || {}, g = s.gpu || {};
    const tm = s.timer ? `<div class="agent-timer">⏲ ${s.timer.mode === "sleep" ? "Уснёт" : "Выключится"} в ${new Date(s.timer.at * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} <button class="btn btn-sm" data-ag="cancel">Отменить</button></div>` : "";
    const temp = s.cpuTemp ? `${Math.round(s.cpuTemp)}°C` : "";
    return `<div class="card agent ${a.online ? "" : "offline"}" data-host="${esc(a.host)}">
      <div class="agent-head">
        <div><div class="mono-label"><span class="dot ${a.online ? "ok" : "bad"}"></span> ${a.online ? "НА СВЯЗИ" : "НЕ В СЕТИ · " + (a.seen ? ago(a.seen).toUpperCase() : "")}</div>
          <h3 class="display">${esc(a.host)}</h3><p class="muted small">${esc(s.os || "")}${s.uptime ? " · работает " + fmtUptime(s.uptime) : ""}${a.session && u.user ? " · " + esc(u.user) : a.online ? " · никто не вошёл" : ""}</p>
          ${a.session && u.window ? `<p class="small agent-win">▸ ${esc(u.window)}</p>` : ""}</div>
        <div class="agent-shot" data-ag="shot" title="Обновить скриншот">${a.shotAt ? `<img src="/api/home/pc/shot?host=${encodeURIComponent(a.host)}&t=${a.shotAt}" alt="">` : `<span>📷<br>Скриншот</span>`}${a.shotAt ? `<em>${ago(a.shotAt)}</em>` : ""}</div>
      </div>
      ${tm}
      <div class="agent-metrics">
        <div><span class="mono-label">ПРОЦЕССОР</span><b>${Math.round(s.cpu || 0)}%</b>${pctBar(s.cpu)}<em>${esc((s.cpuName || "").replace(/\s+/g, " ").slice(0, 38))}${temp ? " · " + temp : ""}</em></div>
        <div><span class="mono-label">ПАМЯТЬ</span><b>${Math.round(s.ramPct || 0)}%</b>${pctBar(s.ramPct)}<em>${fmtBytes(s.ramUsed)} из ${fmtBytes(s.ramTotal)}</em></div>
        ${s.gpuName ? `<div><span class="mono-label">ВИДЕОКАРТА</span><b>${Math.round(s.gpuTemp || 0)}°C</b>${pctBar(g.load)}<em>${esc(s.gpuName)} · ${Math.round(g.load || 0)}%${g.power ? " · " + Math.round(g.power) + " Вт" : ""}</em></div>` : ""}
        ${(s.disks || []).map((d) => `<div><span class="mono-label">ДИСК ${esc(d.name)}</span><b>${fmtBytes(d.free)}</b>${pctBar(d.size ? (1 - d.free / d.size) * 100 : 0)}<em>свободно из ${fmtBytes(d.size)}${d.label ? " · " + esc(d.label) : ""}</em></div>`).join("")}
      </div>
      <canvas class="agent-chart" id="agc${i}"></canvas>
      <div class="agent-acts">
        <button class="btn btn-sm" data-ag="shot">📷 Скриншот</button>
        <button class="btn btn-sm" data-ag="lock">🔒 Заблокировать</button>
        <button class="btn btn-sm" data-ag="message">💬 Сообщение</button>
        <button class="btn btn-sm" data-ag="timer">⏲ Таймер</button>
        <button class="btn btn-sm" data-ag="vol-">🔉</button><button class="btn btn-sm" data-ag="mute">🔇</button><button class="btn btn-sm" data-ag="vol+">🔊</button>
        <button class="btn btn-sm" data-ag="sleep">☾ Сон</button>
        <button class="btn btn-sm" data-ag="restart">↻ Перезагрузить</button>
        <button class="btn btn-sm btn-danger" data-ag="shutdown">⏻ Выключить</button>
      </div></div>`;
  }).join("") + `<p class="muted small agent-more">Ещё компьютер? <a href="#" data-agent-get>Скачать агент</a> и запустить — он появится здесь.</p>`;
  agents.forEach((a, i) => drawAgentChart($("#agc" + i), a.history || []));
}
function drawAgentChart(cv, h) {
  if (!cv) return;
  const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height, pts = h.slice(-120);
  if (pts.length < 2) return;
  const line = (k, col, max) => {
    c.beginPath(); pts.forEach((p, i) => { const x = i / (pts.length - 1) * W, y = H - 2 - (Number(p[k]) || 0) / max * (H - 6); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.strokeStyle = col; c.lineWidth = 1.6; c.stroke();
  };
  line("cpu", "#ff8a4c", 100); line("ram", "rgba(154,163,214,.9)", 100); if (pts.some((p) => p.temp)) line("temp", "rgba(59,224,140,.8)", 100);
}
async function agentCmd(host, body, okMsg) {
  try { await post("/api/home/pc/agent", { host, ...body }); if (okMsg) toast(okMsg); }
  catch (e) { toast(e.message, true); }
}
document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-agent-get]") || e.target.closest("#agentGet")) { e.preventDefault(); agentDownload(); return; }
  const b = e.target.closest("[data-ag]"); if (!b) return;
  const host = b.closest("[data-host]").dataset.host, a = b.dataset.ag;
  if (a === "shot") {
    const before = agents.find((x) => x.host === host)?.shotAt || 0;
    await agentCmd(host, { action: "shot" }, "Делаю скриншот…");
    for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 1000)); await loadAgents(); const now = agents.find((x) => x.host === host)?.shotAt || 0; if (now > before) { openShot(host, now); break; } }
    return;
  }
  if (a === "lock") return agentCmd(host, { action: "lock" }, "Компьютер заблокирован");
  if (a === "mute") return agentCmd(host, { action: "mute" });
  if (a === "vol+" || a === "vol-") return agentCmd(host, { action: "volume", minutes: a === "vol+" ? 5 : -5 });
  if (a === "cancel") return agentCmd(host, { action: "cancel" }, "Таймер отменён");
  if (a === "sleep" && await askConfirm({ icon: "☾", title: `Усыпить ${host}?`, text: "Компьютер уйдёт в сон. Разбудить можно отсюда или голосом.", yes: "Усыпить" })) return agentCmd(host, { action: "sleep" }, "Компьютер засыпает");
  if (a === "restart" && await askConfirm({ icon: "↻", title: `Перезагрузить ${host}?`, text: "Несохранённые файлы лучше сохранить — перезагрузка через 10 секунд.", yes: "Перезагрузить", danger: true })) return agentCmd(host, { action: "restart" }, "Перезагрузка через 10 секунд");
  if (a === "shutdown" && await askConfirm({ icon: "⏻", title: `Выключить ${host}?`, text: "Windows корректно завершит работу через 10 секунд.", yes: "Выключить", danger: true })) return agentCmd(host, { action: "shutdown" }, "Выключение через 10 секунд");
  if (a === "message") openForm('<span class="acc">// СООБЩЕНИЕ</span>', host, `<form class="form" id="amForm"><label>Текст на экране компьютера<textarea class="field" id="amText" rows="3" maxlength="300" placeholder="Ужин готов! 🍝"></textarea></label><div class="form-acts"><button class="btn btn-acc">Отправить</button></div></form>`, () => {
    $("#amForm").onsubmit = (ev) => { ev.preventDefault(); closeForm(); agentCmd(host, { action: "message", text: $("#amText").value }, "Сообщение показано"); };
  });
  if (a === "timer") openForm('<span class="acc">// ТАЙМЕР</span>', host, `<div class="form"><div class="seg" id="tmMode"><button data-m="shutdown" class="active">Выключить</button><button data-m="sleep">Усыпить</button></div>
      <div class="timer-opts">${[[15, "через 15 мин"], [30, "через 30 мин"], [60, "через 1 час"], [90, "через 1,5 часа"], [120, "через 2 часа"], [180, "через 3 часа"]].map(([m, l]) => `<button class="btn" data-tmm="${m}">${l}</button>`).join("")}</div>
      <label>Или своё время, минут<input class="field" id="tmCustom" type="number" min="1" max="1440" placeholder="45"></label><button class="btn btn-acc" id="tmGo">Поставить</button></div>`, () => {
    let mode = "shutdown";
    $$("#tmMode button").forEach((x) => x.onclick = () => { mode = x.dataset.m; $$("#tmMode button").forEach((y) => y.classList.toggle("active", y === x)); });
    const set = (m) => { closeForm(); agentCmd(host, { action: "timer", minutes: m, mode }, `${mode === "sleep" ? "Уснёт" : "Выключится"} через ${m} мин`); setTimeout(loadAgents, 4000); };
    $$("[data-tmm]").forEach((x) => x.onclick = () => set(Number(x.dataset.tmm)));
    $("#tmGo").onclick = () => { const m = Number($("#tmCustom").value); if (m > 0) set(m); };
  });
});
function openShot(host, t) {
  openForm('<span class="acc">// СКРИНШОТ</span>', host, `<div class="shot-view"><img src="/api/home/pc/shot?host=${encodeURIComponent(host)}&t=${t}" alt=""><div class="form-acts"><a class="btn" href="/api/home/pc/shot?host=${encodeURIComponent(host)}&t=${t}" download="screen-${esc(host)}.jpg">⤓ Скачать</a><button class="btn btn-acc" id="shotAgain">↻ Ещё раз</button></div></div>`, () => {
    $("#shotAgain").onclick = () => { closeForm(); $(`[data-host="${CSS.escape(host)}"] [data-ag="shot"]`)?.click(); };
  });
  $(".form-card").classList.add("wide");
}
function agentDownload() {
  openForm('<span class="acc">// АГЕНТ ZALET</span>', "Скачать агент", `<div class="form">
    <label class="flag"><input type="checkbox" id="adVoice" checked><span>Это главный ПК — выключать его голосом через Марусю</span></label>
    <div class="dl-grid">
      <a class="dl" id="adWin"><i>⊞</i><b>Windows</b><span>ZALET-Agent.exe · один файл</span></a>
      <a class="dl" id="adLin"><i>🐧</i><b>Linux</b><span>zalet-agent · x86-64</span></a>
    </div>
    <div class="howto"><div class="mono-label">КАК УСТАНОВИТЬ</div>
      <p><b>Windows:</b> запустите ZALET-Agent.exe и разрешите права администратора. Агент встанет вместо прежнего PC-Remote и будет запускаться сам. Повторный запуск exe покажет состояние или предложит удалить.</p>
      <p><b>Linux:</b> в терминале: <code>chmod +x zalet-agent && sudo ./zalet-agent</code>. Удалить: <code>sudo /opt/zalet/zalet-agent uninstall</code>.</p>
      <p class="muted">В агент вшит ключ доступа к роутеру — не выкладывайте файл в интернет.</p></div></div>`, () => {
    const upd = () => { const v = $("#adVoice").checked ? "1" : "0"; $("#adWin").href = `/api/home/pc/download?os=windows&voice=${v}`; $("#adLin").href = `/api/home/pc/download?os=linux&voice=${v}`; };
    $("#adVoice").onchange = upd; upd();
  });
}

// ---------- фото: вкладки ----------
let curPhotoTab = "gallery";
$$("#photoTabs button").forEach((b) => b.onclick = () => photoTab(b.dataset.pt));
function photoTab(t, quiet) {
  curPhotoTab = t;
  $$("#photoTabs button").forEach((b) => b.classList.toggle("active", b.dataset.pt === t));
  $$(".ptab").forEach((x) => x.classList.toggle("active", x.id === "pt-" + t));
  ({ day: loadDayTab, places: loadPlaces, albums: loadAlbums, files: () => loadFiles(fDir) })[t]?.();
}
// фильтр по году
(() => { const y = new Date().getFullYear(); $("#galYear").innerHTML += Array.from({ length: 16 }, (_, i) => `<option value="${y - i}">${y - i}</option>`).join(""); })();
$("#galYear").onchange = () => { gal.year = $("#galYear").value; galReset(); };

// просмотр произвольного списка фото в общем окне
function viewList(items, i) { lbList = items; lbOpen(i); }

// «В этот день»
let dayData = null;
async function getDay() { if (!dayData) try { dayData = await api("/api/home/onthisday"); } catch (e) { dayData = { days: [] }; } return dayData; }
async function loadHomeDay() {
  const d = await getDay(); const el = $("#homeDay");
  if (!d.days.length) { el.innerHTML = ""; return; }
  const all = d.days.flatMap((g) => g.items.map((it) => ({ ...it, _ago: g.ago })));
  el.innerHTML = `<div class="section-head"><div class="mono-label"><span class="acc">// ПАМЯТЬ</span> В ЭТОТ ДЕНЬ · ${esc(new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" }).toUpperCase())}</div><a class="btn btn-sm" href="#" id="dayAll">Все →</a></div>
    <div class="day-strip">${all.slice(0, 14).map((it, i) => `<a data-di="${i}"><img loading="lazy" src="${thumb(it.id)}" alt="" onload="this.classList.add('show')"><span>${it._ago} ${plural(it._ago, "год", "года", "лет")} назад</span></a>`).join("")}</div>`;
  $$("#homeDay [data-di]").forEach((a) => a.onclick = () => viewList(all, Number(a.dataset.di)));
  $("#dayAll").onclick = (e) => { e.preventDefault(); go("photos"); photoTab("day"); };
}
async function loadDayTab() {
  const d = await getDay();
  $("#dayList").innerHTML = d.days.length ? d.days.map((g, gi) => `<div class="gal-month"><h3>${g.ago} ${plural(g.ago, "год", "года", "лет")} назад · ${g.year}</h3></div>
    <div class="gal-grid">${g.items.map((it, i) => `<a data-dg="${gi}" data-di="${i}"><img loading="lazy" src="${thumb(it.id)}" alt="" onload="this.classList.add('show')">${it.kind === "video" ? '<span class="badge">▶</span>' : ""}</a>`).join("")}</div>`).join("")
    : `<p class="muted">В этот день в прошлые годы снимков нет. Загляните завтра 🙂</p>`;
  $$("#dayList [data-dg]").forEach((a) => a.onclick = () => viewList(d.days[a.dataset.dg].items, Number(a.dataset.di)));
}

// Места
let placesMap = null, placesCluster = null, placesData = null;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
// стили карты должны загрузиться ДО создания карты — иначе плитки и метки съезжают
function loadCSS(href) { return new Promise((res) => { if ([...document.styleSheets].some((s) => s.href === href)) return res(); const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; l.onload = res; l.onerror = res; document.head.appendChild(l); }); }
async function ensureLeaflet() {
  if (window.L && L.markerClusterGroup) return;
  await Promise.all([loadCSS("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"), loadCSS("https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.min.css")]);
  if (!window.L) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js");
  if (!L.markerClusterGroup) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.min.js");
}
async function loadPlaces() {
  if (!placesData) $("#placesList").innerHTML = `<div class="spinner"></div>`;
  let d; try { d = placesData = await api("/api/home/places"); } catch (e) { $("#placesList").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const span = (p) => `${fmtDate(p.from, { month: "short", year: "numeric" })}${p.to - p.from > 86400 * 30 ? " — " + fmtDate(p.to, { month: "short", year: "numeric" }) : ""}`;
  $("#placesList").innerHTML = (d.indexing ? `<p class="muted small places-note">Ищу координаты в фото… обработано ${d.scanned}. Места будут появляться постепенно.</p>` : "") +
    (d.places.map((p, i) => `<a class="place" data-pl="${i}"><img loading="lazy" src="${thumb(p.cover)}" alt="" onload="this.classList.add('show')"><div><b>${esc(p.name || "Определяю место…")}</b><span>${p.count} ${plural(p.count, "снимок", "снимка", "снимков")} · ${span(p)}</span></div><i class="go-map" data-fly="${i}" title="Показать на карте">⌖</i></a>`).join("") || `<p class="muted">Фото с координатами пока не найдены.</p>`);
  $$("#placesList [data-pl]").forEach((a) => a.onclick = (e) => {
    const p = d.places[a.dataset.pl];
    if (e.target.closest("[data-fly]")) { placesMap?.flyTo([p.lat, p.lon], 12, { duration: 0.8 }); $("#placesMap").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    openPlace(p.key, p.name || "Место");
  });
  // названия приходят в фоне — обновим список через немного времени
  if (d.places.some((p) => !p.name)) { clearTimeout(timers.placesNames); timers.placesNames = setTimeout(() => { if (curPhotoTab === "places" && page === "photos") loadPlaces(); }, 8000); }
  try {
    await ensureLeaflet();
    if (!placesMap) {
      placesMap = L.map("placesMap", { zoomControl: true, worldCopyJump: true }).setView([55.03, 73.37], 5);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, subdomains: "abc", attribution: "© OpenStreetMap" }).addTo(placesMap);
    }
    // карта могла создаться в скрытой вкладке — пересчитать размер
    requestAnimationFrame(() => placesMap.invalidateSize());
    if (placesCluster) placesMap.removeLayer(placesCluster);
    placesCluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 55, spiderfyOnMaxZoom: true,
      iconCreateFunction: (c) => {
        const ms = c.getAllChildMarkers(), cover = ms[0].options.pid;
        return L.divIcon({ className: "pin-cluster", html: `<img src="${thumb(cover)}"><b>${c.getChildCount()}</b>`, iconSize: [48, 48], iconAnchor: [24, 24] });
      } });
    const pts = d.points.filter((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && (p.lat || p.lon));
    pts.forEach((p, i) => {
      const m = L.marker([p.lat, p.lon], { pid: p.id, icon: L.divIcon({ className: "pin", html: `<img src="${thumb(p.id)}" loading="lazy">`, iconSize: [40, 40], iconAnchor: [20, 20] }) });
      m.on("click", () => { // все снимки этого места, начиная с нажатого
        const same = pts.filter((x) => x.place === p.place);
        viewList(same, Math.max(0, same.indexOf(p)));
      });
      placesCluster.addLayer(m);
    });
    placesMap.addLayer(placesCluster);
    if (pts.length && !placesMap._zaletFitted) { placesMap.fitBounds(placesCluster.getBounds(), { padding: [30, 30], maxZoom: 11 }); placesMap._zaletFitted = true; }
  } catch (e) { $("#placesMap").innerHTML = `<p class="muted small" style="padding:16px">Карта не загрузилась (нужен интернет) — список мест ниже.</p>`; }
}
async function openPlace(key, name) {
  const r = await api("/api/home/place?key=" + encodeURIComponent(key));
  openForm('<span class="acc">// МЕСТО</span>', name, `<p class="muted small">${r.total} ${plural(r.total, "снимок", "снимка", "снимков")}</p><div class="gal-grid">${r.items.slice(0, 400).map((it, i) => `<a data-pi="${i}"><img loading="lazy" src="${thumb(it.id)}" alt="" onload="this.classList.add('show')">${it.kind === "video" ? '<span class="badge">▶</span>' : ""}</a>`).join("")}</div>`, () => {
    $$("#formBody [data-pi]").forEach((a) => a.onclick = () => { closeForm(); viewList(r.items, Number(a.dataset.pi)); });
  });
  $(".form-card").classList.add("wide");
}

// Альбомы — умные: все фото, по годам, по видам, места, альбомы приложений
const ALBUM_SECTIONS = [["all", ""], ["year", "ПО ГОДАМ"], ["kind", "ПО ВИДУ"], ["place", "МЕСТА"], ["app", "ИЗ ПРИЛОЖЕНИЙ"]];
async function loadAlbums() {
  let r; try { r = await api("/api/home/albums"); } catch (e) { $("#albumsList").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const list = r.albums || [];
  $("#albumsList").innerHTML = ALBUM_SECTIONS.map(([type, title]) => {
    const items = list.filter((a) => a.type === type); if (!items.length) return "";
    return `${title ? `<div class="mono-label album-h">${title}</div>` : ""}<div class="albums-row ${type === "all" ? "big" : ""}">${items.map((a) =>
      `<a class="album" data-at="${type}" data-av="${esc(a.value)}" data-an="${esc(a.name)}"><div class="cover" style="background-image:url('${thumb(a.cover)}')"></div><b>${esc(a.name)}</b><span>${a.count.toLocaleString("ru-RU")}</span></a>`).join("")}</div>`;
  }).join("");
  $$("#albumsList [data-at]").forEach((a) => a.onclick = () => {
    const t = a.dataset.at, v = a.dataset.av;
    if (t === "place") return openPlace(v, a.dataset.an);
    gal.album = t === "app" ? v : ""; gal.kind = t === "kind" ? v : ""; gal.year = t === "year" ? v : "";
    $("#galYear").value = gal.year; $$("#galChips .chip").forEach((x) => x.classList.toggle("active", x.dataset.gk === gal.kind));
    photoTab("gallery"); galReset(); if (t !== "all") toast(a.dataset.an);
  });
}

// Файлы SSD
let fDir = "", fItems = [];
const FICON = { video: "🎬", audio: "🎵", image: "🖼", doc: "📄", sub: "💬" };
async function loadFiles(dir) {
  fDir = dir || "";
  let r; try { r = await api("/api/home/files?dir=" + encodeURIComponent(fDir)); } catch (e) { $("#fList").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  fItems = r.items;
  const parts = fDir ? fDir.split("/") : [];
  $("#fCrumbs").innerHTML = `<a data-fd="">SSD</a>` + parts.map((p, i) => ` / <a data-fd="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`).join("") + `<span class="mono-label"> · свободно ${fmtBytes(r.free)}</span>`;
  $$("#fCrumbs [data-fd]").forEach((a) => a.onclick = () => loadFiles(a.dataset.fd));
  $("#fList").innerHTML = (fDir ? `<div class="fe up" data-fi="-1"><i>↩</i><b>..</b><span></span></div>` : "") + fItems.map((f, i) => `<div class="fe" data-fi="${i}"><i>${f.dir ? "📁" : FICON[f.type] || "📦"}</i><b>${esc(f.name)}</b><span>${f.dir ? "" : fmtBytes(f.size)}</span><span class="when">${ago(f.mtime)}</span>
      <div class="fe-acts">${f.dir ? "" : `<a class="icon-btn" href="${fileURL(f)}&dl=1" title="Скачать">⤓</a>`}<button class="icon-btn" data-fa="ren" title="Переименовать">✎</button><button class="icon-btn" data-fa="del" title="В корзину">✕</button></div></div>`).join("") ||
    `<p class="muted small" style="padding:16px">Пустая папка. Перетащите сюда файлы или нажмите «Загрузить». Для фильмов удобно сделать папку «Фильмы».</p>`;
  $$("#fList .fe").forEach((row) => row.onclick = (e) => {
    if (e.target.closest(".fe-acts")) return;
    const i = Number(row.dataset.fi); if (i < 0) return loadFiles(parts.slice(0, -1).join("/"));
    const f = fItems[i];
    if (f.dir) return loadFiles(join(fDir, f.name));
    if (f.type === "video" || f.type === "audio") return playMedia(f);
    if (f.type === "image") return window.open(fileURL(f), "_blank");
    location.href = fileURL(f) + "&dl=1";
  });
  $$("#fList [data-fa]").forEach((b) => b.onclick = async () => {
    const f = fItems[Number(b.closest(".fe").dataset.fi)];
    if (b.dataset.fa === "del") {
      if (!(await askConfirm({ icon: "✕", title: `Удалить «${f.name}»?`, text: "Файл переместится в корзину SSD (папка .trash-zalet) — его можно вернуть через сетевую папку.", yes: "Удалить", danger: true }))) return;
      try { await post("/api/home/files?dir=" + encodeURIComponent(fDir), { action: "delete", name: f.name }); loadFiles(fDir); } catch (e) { toast(e.message, true); }
    } else openForm('<span class="acc">// SSD</span>', "Переименовать", `<form class="form" id="frForm"><input class="field" id="frName" value="${esc(f.name)}"><div class="form-acts"><button class="btn btn-acc">Сохранить</button></div></form>`, () => {
      $("#frForm").onsubmit = async (ev) => { ev.preventDefault(); try { await post("/api/home/files?dir=" + encodeURIComponent(fDir), { action: "rename", name: f.name, to: $("#frName").value }); closeForm(); loadFiles(fDir); } catch (er) { toast(er.message, true); } };
    });
  });
}
const join = (a, b) => (a ? a + "/" : "") + b;
const fileURL = (f) => "/api/home/files/get?path=" + encodeURIComponent(join(fDir, f.name));
function playMedia(f) {
  const base = f.name.replace(/\.[^.]+$/, "");
  const sub = fItems.find((x) => x.type === "sub" && x.name.replace(/\.[^.]+$/, "").startsWith(base));
  const src = fileURL(f);
  openForm('<span class="acc">// ПЛЕЕР</span>', f.name, f.type === "video"
    ? `<video class="player" src="${src}" controls autoplay playsinline>${sub ? `<track kind="subtitles" srclang="ru" label="Русские" src="/api/home/files/get?path=${encodeURIComponent(join(fDir, sub.name))}&vtt=1" default>` : ""}</video>
       <p class="muted small">Если видео не играет — формат не поддерживается браузером (часто MKV с H.265). Откройте его в VLC по сетевой папке <code>\\\\192.168.1.1\\SSD</code> или ссылкой: <a class="link" href="${src}">прямая ссылка</a>.</p>`
    : `<audio class="player" src="${src}" controls autoplay></audio>`, () => {});
  $(".form-card").classList.add("wide");
  const stop = () => { $("#formBody video, #formBody audio")?.pause(); };
  $("#formClose").addEventListener("click", stop, { once: true });
}
$("#fMkdir").onclick = () => openForm('<span class="acc">// SSD</span>', "Новая папка", `<form class="form" id="fmForm"><input class="field" id="fmName" placeholder="Фильмы"><div class="form-acts"><button class="btn btn-acc">Создать</button></div></form>`, () => {
  $("#fmForm").onsubmit = async (e) => { e.preventDefault(); try { await post("/api/home/files?dir=" + encodeURIComponent(fDir), { action: "mkdir", name: $("#fmName").value }); closeForm(); loadFiles(fDir); } catch (er) { toast(er.message, true); } };
});
function uploadFiles(files) {
  [...files].forEach((file) => {
    const row = document.createElement("div"); row.className = "up-row"; row.innerHTML = `<b>${esc(file.name)}</b><div class="bar"><i style="width:0%"></i></div><span>0%</span>`;
    $("#fUploads").appendChild(row);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/home/files/upload?dir=${encodeURIComponent(fDir)}&name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const p = Math.round(e.loaded / e.total * 100); row.querySelector("i").style.width = p + "%"; row.querySelector("span").textContent = `${p}% · ${fmtBytes(e.loaded)} из ${fmtBytes(e.total)}`; } };
    xhr.onload = () => { const ok = xhr.status === 200; row.querySelector("span").textContent = ok ? "✓ загружено" : "✕ " + (JSON.parse(xhr.responseText || "{}").error || xhr.status); row.classList.add(ok ? "ok" : "bad"); if (ok) { loadFiles(fDir); setTimeout(() => row.remove(), 4000); } };
    xhr.onerror = () => { row.querySelector("span").textContent = "✕ связь оборвалась"; row.classList.add("bad"); };
    xhr.send(file);
  });
}
$("#fUpload").onchange = (e) => { uploadFiles(e.target.files); e.target.value = ""; };
(() => {
  const d = $("#fDrop");
  ["dragenter", "dragover"].forEach((ev) => d.addEventListener(ev, (e) => { e.preventDefault(); d.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => d.addEventListener(ev, (e) => { e.preventDefault(); d.classList.remove("over"); }));
  d.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });
})();

// ---------- события ----------
const EV_ICON = { vpn: "⛨", pc: "🖥", presence: "🏠", schedule: "⏰", system: "⚙", photo: "📷" };
async function loadEvents(sel, n) {
  let r; try { r = await api("/api/home/events"); } catch (e) { return; }
  const list = (r.events || []).slice(0, n || 150);
  $(sel).innerHTML = list.map((e) => `<div class="ev"><i>${EV_ICON[e.kind] || "•"}</i><span>${esc(e.text)}</span><em>${new Date(e.t * 1000).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</em></div>`).join("") || `<p class="muted small">Пока тихо. Здесь появятся события: кто пришёл и ушёл, что включилось по расписанию, как себя чувствует VPN.</p>`;
}

// ---------- флешка ----------
async function loadUSB() {
  let r; try { r = await api("/api/home/usb"); } catch (e) { return; }
  const total = r.packages.reduce((a, p) => a + p.size, 0);
  $("#usbCard").innerHTML = `<div class="usb-row">
      <div class="usb-ico"><svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5M5.5 9.6V20h13V9.6M10 20v-5.5h4V20M15.8 6.6V3.8h2.4v4.8"/></svg></div>
      <div><b>Сделать флешку ZALET HOME</b><p class="muted small">Скачайте архив, распакуйте и запустите «Сделать флешку ZALET» — он сам отформатирует флешку и запишет всё: вход домой для Windows, Linux и Mac, установщики Tailscale, агент ПК. Флешка подключает любой компьютер к дому и открывает эту панель.</p></div></div>
    <div class="kv-list">
      <div><span>Ключ подключения</span><b class="${r.key ? "" : "warn"}">${r.key ? esc(r.keyKind) + " · …" + esc(r.keyTail) : "не задан"}</b></div>
      <div><span>В комплекте</span><b>${r.packages.length} ${plural(r.packages.length, "установщик", "установщика", "установщиков")} Tailscale · ${fmtBytes(total)}</b></div>
    </div>
    <div class="kv-btns"><a class="btn btn-acc" href="/api/home/usb/kit.zip">⤓ Скачать «Сделать флешку»</a><button class="btn btn-sm" id="usbKey">${r.key ? "Заменить ключ" : "Задать ключ"}</button></div>
    <p class="muted small">Если флешка потеряется — удалите её ключ в Tailscale (Settings → Trust credentials), и она перестанет пускать в сеть.</p>`;
  $("#usbKey").onclick = () => openForm('<span class="acc">// ФЛЕШКА</span>', "Ключ подключения", `<form class="form" id="ukForm">
    <p class="muted small">Постоянный ключ — OAuth client secret из Tailscale (Settings → Trust credentials, право Auth Keys: Write, тег tag:usb). Он начинается с <code>tskey-client-</code>.</p>
    <input class="field mono" id="ukKey" placeholder="tskey-client-…" autocomplete="off"><div class="form-acts"><button class="btn btn-acc">Сохранить</button></div></form>`, () => {
    $("#ukForm").onsubmit = async (e) => { e.preventDefault(); try { await post("/api/home/usb", { key: $("#ukKey").value }); closeForm(); toast("Ключ сохранён — новые флешки будут с ним"); loadUSB(); } catch (er) { toast(er.message, true); } };
  });
}

// ---------- ночь и зима ----------
function moodClasses() {
  const d = new Date(), h = d.getHours(), m = d.getMonth();
  document.body.classList.toggle("night", h >= 23 || h < 6);
  document.body.classList.toggle("winter", m === 11 || m <= 1);
}
moodClasses(); setInterval(moodClasses, 60000);
(() => { // лёгкий снег зимой
  const cv = document.createElement("canvas"); cv.className = "snow"; document.body.appendChild(cv);
  const c = cv.getContext("2d"); let flakes = [], W, H;
  const size = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; flakes = Array.from({ length: Math.round(W / 22) }, () => ({ x: Math.random() * W, y: Math.random() * H, r: 0.6 + Math.random() * 1.8, v: 0.3 + Math.random() * 0.8, p: Math.random() * 6 })); };
  size(); addEventListener("resize", size);
  const draw = (t) => {
    if (document.body.classList.contains("winter") && !document.hidden) {
      c.clearRect(0, 0, W, H); c.fillStyle = "rgba(255,255,255,.55)";
      flakes.forEach((f) => { f.y += f.v; f.x += Math.sin(t / 1500 + f.p) * 0.3; if (f.y > H) { f.y = -3; f.x = Math.random() * W; } c.beginPath(); c.arc(f.x, f.y, f.r, 0, 7); c.fill(); });
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
})();
