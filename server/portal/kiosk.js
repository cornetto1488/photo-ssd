"use strict";
// ZALET HOME — режим «Киоск»: полноэкранная панель для планшета/телевизора (время, погода, 3D-карта дома, камеры, события).

const kk = { on: false, timers: [], map: null, gen: 0, last: null, exitTimer: null };
const kEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kAgo = (t) => { const s = Math.floor(Date.now() / 1000 - t); if (s < 90) return "только что"; if (s < 3600) return Math.floor(s / 60) + " мин назад"; if (s < 86400) return Math.floor(s / 3600) + " ч назад"; return Math.floor(s / 86400) + " дн назад"; };

function kioskBuild() {
  const root = $("#kiosk"); if (!root || root.dataset.built) return;
  root.dataset.built = "1";
  root.innerHTML = `
    <div class="k-drift" id="kDrift">
      <div class="k-left">
        <div class="k-time" id="kTime">--:--</div>
        <div class="k-date" id="kDate"></div>
        <div class="k-weather" id="kWeather"></div>
        <div class="k-light" id="kLight">
          <div class="k-light-head"><span class="k-lab">СВЕТ <b id="kLightCount"></b></span><em class="k-msg" id="kLightMsg"></em></div>
          <div class="k-light-all"><button class="k-btn on" data-kl="on">${K_ICON.sun}<span>Включить всё</span></button><button class="k-btn off" data-kl="off">${K_ICON.moon}<span>Выключить всё</span></button></div>
          <div class="k-rooms" id="kRooms"></div>
        </div>
        <div class="k-ac" id="kAc"></div>
        <div class="k-quick hidden" id="kQuick"></div>
        <div class="k-vpn hidden" id="kVpn"></div>
        <div class="k-tiles" id="kTiles"></div>
      </div>
      <div class="k-mid"><div class="k-map"><canvas id="kMap"></canvas><div class="k-maplabel" id="kMapLabel"></div></div><div class="k-side"><div class="k-wcard" id="kWCard"></div><div class="k-music" id="kMusic"></div></div></div>
      <div class="k-cams" id="kCams"></div>
      <div class="k-ticker" id="kTicker"></div>
    </div>
    <button class="k-exit" id="kExit" title="Выйти из киоска">✕</button>`;
  kioskWpInit();
  $("#kExit").onclick = kioskExit;
  root.addEventListener("pointerdown", kioskPoke);
  root.addEventListener("mousemove", kioskPoke);
}
function kioskPoke() {
  const b = $("#kExit"); if (!b) return;
  b.classList.add("show"); clearTimeout(kk.exitTimer);
  kk.exitTimer = setTimeout(() => b.classList.remove("show"), 4000);
}
function kioskExit() {
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
  go("home");
}
const kNight = () => { const h = new Date().getHours(); return h >= 23 || h < 7; };

function kioskClock() {
  const d = new Date(), pad = (n) => String(n).padStart(2, "0");
  $("#kTime").innerHTML = `${pad(d.getHours())}<i class="${d.getSeconds() % 2 ? "off" : ""}">:</i>${pad(d.getMinutes())}`;
  const ds = d.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
  $("#kDate").textContent = ds.charAt(0).toUpperCase() + ds.slice(1);
  document.body.classList.toggle("k-night", kNight());
}
function kioskWeather() {
  const el = $("#kWeather"); if (!el) return;
  if (typeof weather === "undefined" || !weather?.current) { el.textContent = ""; return; }
  const c = weather.current, w = WEATHER[c.weather_code] || ["—", "cloud"];
  el.innerHTML = `<b>${c.temperature_2m > 0 ? "+" : ""}${Math.round(c.temperature_2m)}°</b><span>${kEsc(w[0])}<br><small>ощущается ${Math.round(c.apparent_temperature)}° · ветер ${Math.round(c.wind_speed_10m)} м/с</small></span>`;
}
function kioskWeatherCard() {
  const el = $("#kWCard"); if (!el) return;
  if (typeof weather === "undefined" || !weather?.current) { el.innerHTML = '<span class="k-lab">ПОГОДА · ОМСК</span><b class="wc-na">загружаю…</b>'; return; }
  const c = weather.current, w = WEATHER[c.weather_code] || ["—", "cloud"], d = weather.daily, DN = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
  const sg = (n) => (n > 0 ? "+" : "") + Math.round(n) + "°";
  const days = (d?.time || []).slice(1, 4).map((t, i) => { const ww = WEATHER[d.weather_code[i + 1]] || ["", "cloud"];
    return '<div><span>' + DN[new Date(t).getDay()] + '</span><i>' + WICON[ww[1]] + '</i><b>' + sg(d.temperature_2m_max[i + 1]) + '</b><em>' + sg(d.temperature_2m_min[i + 1]) + '</em></div>'; }).join("");
  el.innerHTML = '<span class="k-lab">ПОГОДА · ОМСК</span><div class="wc-top"><i class="wc-ico">' + WICON[w[1]] + '</i><b>' + sg(c.temperature_2m) + '</b></div>' +
    '<div class="wc-desc">' + kEsc(w[0]) + '</div><small>ощущается ' + sg(c.apparent_temperature) + ' · ветер ' + Math.round(c.wind_speed_10m) + ' м/с' + (c.relative_humidity_2m != null ? ' · ' + c.relative_humidity_2m + '%' : '') + '</small>' +
    '<div class="wc-days">' + days + '</div>';
}
async function kioskWeatherLoad() {
  try { if (typeof loadWeather === "function" && (typeof weather === "undefined" || !weather?.current)) await loadWeather(); } catch (e) {}
  kioskWeatherCard();
}

// --- что играет на компьютере: Wallpaper Engine сам отдаёт трек Windows (медиа-интеграция)
function kioskMusic() {
  const el = $("#kMusic"); if (!el) return;
  const st = { title: "", artist: "", thumb: "", playing: false };
  const render = () => {
    const has = !!st.title;
    el.classList.toggle("idle", !has);
    el.classList.toggle("on", has && st.playing);
    el.innerHTML = '<div class="mu-art"' + (st.thumb ? ' style="background-image:url(' + st.thumb + ')"' : "") + '>' + (st.thumb ? "" : "♪") + '</div>' +
      '<div class="mu-txt"><span class="k-lab">' + (has ? (st.playing ? "СЕЙЧАС ИГРАЕТ" : "ПАУЗА") : "МУЗЫКА") + '</span><b>' + kEsc(has ? st.title : "Ничего не играет") + '</b><small>' + kEsc(has ? st.artist : "включи трек на компьютере") + '</small></div>' +
      '<div class="mu-eq"><i></i><i></i><i></i><i></i></div>';
  };
  render();
  try {
    if (window.wallpaperRegisterMediaPropertiesListener) window.wallpaperRegisterMediaPropertiesListener((e) => { st.title = e.title || ""; st.artist = e.artist || ""; render(); });
    if (window.wallpaperRegisterMediaThumbnailListener) window.wallpaperRegisterMediaThumbnailListener((e) => { st.thumb = e.thumbnail || ""; render(); });
    if (window.wallpaperRegisterMediaPlaybackListener) window.wallpaperRegisterMediaPlaybackListener((e) => { st.playing = e.state === 1; render(); });
  } catch (e) {}
}

// ---- v2rayA: смена узла прямо с рабочего стола ----
async function kioskVpn() {
  const el = $("#kVpn"); if (!el) return;
  let j; try { j = await api("/api/home/v2raya"); } catch (e) { if (!kk.vpn) { el.classList.add("hidden"); } return; }
  if (!kk.on) return;
  kk.vpn = j; el.classList.remove("hidden");
  el.innerHTML = '<button class="k-vpnbtn' + (j.running ? "" : " off") + '"><i class="k-vdot"></i><span class="k-lab">V2RAYA</span><b>' + kEsc(j.current || (j.running ? "узел не выбран" : "выключен")) + '</b><em>сменить ▾</em></button>';
  $(".k-vpnbtn", el).onclick = kioskVpnSheet;
}
function kioskVpnSheet() {
  const j = kk.vpn; if (!j) return;
  let sh = $("#kVpnSheet"); if (sh) sh.remove();
  sh = document.createElement("div"); sh.id = "kVpnSheet"; sh.className = "k-sheet";
  sh.innerHTML = '<div class="k-sheet-in"><div class="k-sheet-h"><b>Узел v2rayA</b><em id="kVpnMsg"></em><button class="k-sheet-x" title="Закрыть">✕</button></div><div class="k-nodes">' +
    j.servers.map((s, i) => '<button class="k-node' + (s.on ? " on" : "") + '" data-i="' + i + '"><b>' + kEsc(s.name) + '</b><small>' + kEsc(s.net || "") + (s.ping ? " · " + kEsc(s.ping) : "") + "</small></button>").join("") + "</div></div>";
  $("#kiosk").appendChild(sh);
  const close = () => sh.remove();
  sh.onclick = (e) => { if (e.target === sh) close(); };
  $(".k-sheet-x", sh).onclick = close;
  $$(".k-node", sh).forEach((b) => b.onclick = async () => {
    const s = j.servers[Number(b.dataset.i)]; if (!s || s.on || kk.vpnBusy) return;
    kk.vpnBusy = true; $$(".k-node", sh).forEach((x) => x.disabled = true); b.classList.add("busy");
    const msg = $("#kVpnMsg", sh); msg.textContent = "переключаю…";
    try {
      await post("/api/home/v2raya/connect", { id: s.id, type: s.type, sub: s.sub });
      msg.textContent = "готово";
      setTimeout(async () => { await kioskVpn(); close(); }, 2500);
    } catch (e) { msg.textContent = e.message || "ошибка"; $$(".k-node", sh).forEach((x) => x.disabled = false); b.classList.remove("busy"); }
    kk.vpnBusy = false;
  });
}

function kioskAc() {
  const el = $("#kAc"); if (!el || typeof acMount !== "function") return;
  acMount(el, true); acRefresh();
  kk.timers.push(setInterval(() => { if (!acx.busy) acRefresh(); }, 20000));
}

async function kioskTiles() {
  const safe = (p) => p.catch(() => null);
  const [lights, vac, net] = await Promise.all([safe(api("/api/home/stats/lights?days=1")), safe(api("/api/home/dreame")), safe(api("/api/home/stats/net?hours=24"))]);
  if (!kk.on) return;
  const t = [];
  if (lights) { const on = (lights.devices || []).filter((d) => d.on); t.push(`<div class="k-tile ${on.length ? "lit" : ""}"><span>💡 Свет</span><b>${on.length ? "Горит: " + on.length : "Выключен"}</b><small>${on.length ? kEsc(on.slice(0, 3).map((d) => d.name).join(", ")) : "дома спокойно"}</small></div>`); }
  const s = vac?.status;
  if (s) { const cl = typeof DR_CLEANING !== "undefined" && DR_CLEANING.has(s.state); t.push(`<div class="k-tile ${cl ? "lit" : ""}"><span>🧹 Пылесос</span><b>${kEsc(s.stateText)}</b><small>батарея ${s.battery}%${cl ? " · " + s.cleanArea + " м²" : ""}</small></div>`); }
  const sp = (net?.speed || []).slice(-1)[0];
  t.push(`<div class="k-tile"><span>⚡ Интернет</span><b>${sp ? sp.mbps.toFixed(0) + " Мбит/с" : "—"}</b><small>${sp ? "замер " + kAgo(sp.t) : ""}</small></div>`);
  const pc = typeof status !== "undefined" && status?.pc;
  if (pc) t.push(`<div class="k-tile ${pc.online ? "lit" : ""}"><span>🖥 Компьютер</span><b>${pc.online ? "Включён" : "Выключен"}</b><small></small></div>`);
  $("#kTiles").innerHTML = t.join("");
}
async function kioskMapWp() {
  const cv = $("#kMap"); if (!cv) return;
  if (!kk.map || kk.map.cv !== cv) {
    kk.map = new DreameMap3D(cv, { autoRotate: false, interactive: false, labels: true, cache: true, replayMs: 9000 });
    kk.map.yaw = -0.6; kk.mapLoop = false;
  }
  try {
    if (!kk.hist || Date.now() - kk.histAt > 30 * 60000) {
      const names = await api("/api/home/dreame/rooms").catch(() => ({}));
      const list = [];
      for (let i = 0; i < 5; i++) { try { const m = await api("/api/home/dreame/map?i=" + i); if (!m || !m.paths) break; list.push(m); } catch (e) { break; } }
      if (!kk.on) return;
      if (list.length) { kk.hist = list; kk.histAt = Date.now(); kk.histNames = names; }
    }
  } catch (e) {}
  if (!kk.hist || kk.mapLoop) return;
  kk.mapLoop = true; kk.hi = 0;
  const show = () => {
    if (!kk.on) return;
    const m = kk.hist[kk.hi % kk.hist.length], t = m.t ? new Date(m.t * 1000) : null;
    kk.map.setNames(kk.histNames); kk.map.setData(m);
    $("#kMapLabel").textContent = "уборка " + (kk.hi % kk.hist.length + 1) + " из " + kk.hist.length + (t ? " · " + t.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) + " " + t.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "") + " · " + m.area + " м²";
  };
  kk.map.onReplayDone = () => { clearTimeout(kk.mapT); kk.mapT = setTimeout(() => { kk.hi++; show(); }, 7000); };
  show();
}
async function kioskMap() {
  if (document.documentElement.classList.contains("wp")) return kioskMapWp();
  try {
    const c = await dmLoad(true);
    if (!kk.on) return;
    const cv = $("#kMap");
    if (!kk.map || kk.map.cv !== cv) kk.map = new DreameMap3D(cv, { autoRotate: true, interactive: false, labels: true });
    kk.map.setNames(c.names); kk.map.setData(c.map);
    const t = c.map.t ? new Date(c.map.t * 1000) : null;
    $("#kMapLabel").textContent = t ? "последняя уборка · " + t.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) + " · " + c.map.area + " м²" : "";
  } catch (e) { const l = $("#kMapLabel"); if (l) l.textContent = ""; }
}
async function kioskTicker() {
  let ev; try { ev = (await api("/api/home/events")).events || []; } catch (e) { return; }
  if (!kk.on) return;
  const items = ev.slice(0, 8);
  const el = $("#kTicker"); if (!el) return;
  if (!items.length) { el.innerHTML = ""; return; }
  let i = 0;
  const show = () => { const e = items[i++ % items.length]; el.innerHTML = `<span class="k-dot"></span><b>${kEsc(e.text)}</b><small>${kAgo(e.t)}</small>`; el.classList.remove("swap"); void el.offsetWidth; el.classList.add("swap"); };
  clearInterval(kk.tick); show(); kk.tick = setInterval(show, 7000); kk.timers.push(kk.tick);
}

// ---- обои Wallpaper Engine: оранжевая зона под значки рабочего стола и быстрые папки ----
const K_ICO = {
  drive: '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="9" rx="2.5"/><path d="M7 12.5h.01M11 12.5h6M5 8l1.6-3.2A2 2 0 0 1 8.4 3.7h7.2a2 2 0 0 1 1.8 1.1L19 8"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/></svg>',
};
const kIcoFor = (n, p) => { const s = (n + " " + p).toLowerCase(); return /\\\\|хранил|диск|ssd|nas/.test(s) && !/фото|photo/.test(s) ? K_ICO.drive : /фото|photo|image|картин/.test(s) ? K_ICO.image : /загруз|download/.test(s) ? K_ICO.down : /проект|code|dev|git/.test(s) ? K_ICO.code : K_ICO.folder; };
const kB64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function kioskOpenFolder(path, btn) {
  // обои (встроенный браузер) не умеют открывать ссылки zaletopen:, поэтому говорим с маленьким помощником на этом же ПК (127.0.0.1:18765)
  const flash = (t) => { if (!btn) return; const s = btn.querySelector("span"); if (!s) return; const old = s.dataset.t || (s.dataset.t = s.textContent); s.textContent = t; setTimeout(() => { s.textContent = old; }, 2200); };
  fetch("http://127.0.0.1:18765/open?p=" + kB64u(path), { mode: "no-cors", cache: "no-store" }).catch(() => flash("нет помощника"));
}
function kioskWpInit() {
  const W = window.ZH_WP; if (!W) return;
  // страница обоев не должна прокручиваться (клик по кнопке или фокус могли сдвинуть её вверх)
  const kioskUnscroll = () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); document.querySelectorAll("html, body, #app, main, #page-kiosk, .kiosk, .k-drift").forEach((e) => { if (e.scrollTop || e.scrollLeft) { e.scrollTop = 0; e.scrollLeft = 0; } }); };
  window.addEventListener("scroll", kioskUnscroll, true);
  setInterval(kioskUnscroll, 5000);
  const root = $("#kiosk");
  // ячейка значка Windows в CSS-пикселях (учитываем масштаб страницы), зона начинается в левом верхнем углу экрана
  const dpr = window.devicePixelRatio || 1, cw = W.iw / dpr, ch = W.ih / dpr, pad = 0;
  const zw = W.orange ? Math.round(W.cols * cw + pad) : 0, zh = Math.round(W.slots * ch - ch * 0.07);
  // панель задач Windows не должна закрывать низ; странные значения (0, почти весь экран) отбрасываем
  const tb = screen.height - screen.availHeight;
  const sbPx = (tb > 0 && tb <= 160 ? tb : 48) / dpr + 6;
  document.documentElement.style.setProperty("--wpsb", Math.round(sbPx) + "px");
  document.documentElement.style.setProperty("--wpz", zw + "px");
  document.documentElement.style.setProperty("--wpzh", zh + "px");
  if (W.orange && !$("#wpZone")) {
    const el = document.createElement("div"); el.id = "wpZone"; el.className = "wp-zone";
    el.style.cssText = "width:" + zw + "px;height:" + zh + "px;--cw:" + cw + "px;--ch:" + ch + "px;--pad:" + pad + "px;";
    let slots = ""; for (let i = 0; i < W.cols * W.slots; i++) slots += "<i></i>";
    el.innerHTML = '<div class="wp-slots" style="grid-template-columns:repeat(' + W.cols + ',' + cw + 'px);grid-auto-rows:' + ch + 'px">' + slots + "</div>";
    root.appendChild(el);
  }
  if (!$("#wpBrand")) { const b = document.createElement("div"); b.id = "wpBrand"; b.className = "wp-brand"; b.innerHTML = '<b>ZA</b>LET <small>HOME</small>'; root.appendChild(b); }
  const q = $("#kQuick");
  if (q && W.quick && W.folders.length) {
    q.classList.remove("hidden");
    q.innerHTML = '<div class="k-lab">БЫСТРЫЙ ДОСТУП</div><div class="k-quick-row">' + W.folders.map((f, i) =>
      '<button class="k-q' + (i === 0 ? " main" : "") + '" data-i="' + i + '" title="' + kEsc(f.p) + '"><i>' + kIcoFor(f.n, f.p) + "</i><span>" + kEsc(f.n) + "</span></button>").join("") + "</div>";
    $$(".k-q", q).forEach((b) => b.onclick = () => { const f = W.folders[Number(b.dataset.i)]; if (f) kioskOpenFolder(f.p, b); });
  }
}

// ---- свет: всё сразу и по комнатам ----
const K_ICON = {
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/></svg>',
  bulb: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3z"/></svg>',
};
const kLampOn = (d) => d.kind === "light" ? !!kVal(d, "switch_led") : !!kVal(d, "switch_1");
const kVal = (d, code) => { const s = (d.status || []).find((x) => x.code === code); return s ? s.value : undefined; };
function kRoomsMap() {
  const rooms = {};
  (kk.devs || []).filter((d) => d.kind === "light" || d.kind === "switch").forEach((d) => { const r = d.room || "Без комнаты"; (rooms[r] ||= { name: r, lights: [], switches: [] })[d.kind === "light" ? "lights" : "switches"].push(d); });
  return Object.values(rooms).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}
async function kioskDevices(fresh) {
  try { kk.devs = (await api("/api/home/devices" + (fresh ? "?fresh=1" : ""))).devices || []; } catch (e) { return; }
  if (kk.on) kioskRenderRooms();
}
function kioskRenderRooms() {
  const box = $("#kRooms"); if (!box) return;
  const rooms = kRoomsMap();
  let totalOn = 0, totalAll = 0;
  box.innerHTML = rooms.map((r) => {
    const lampsOn = r.lights.filter(kLampOn).length, swOn = r.switches.some(kLampOn);
    const on = lampsOn > 0 || (!r.lights.length && swOn);
    totalAll += r.lights.length || r.switches.length; totalOn += r.lights.length ? lampsOn : (swOn ? r.switches.length : 0);
    const sub = r.lights.length ? (lampsOn ? lampsOn + " из " + r.lights.length : "выключено") : (swOn ? "включено" : "выключено");
    return '<button class="k-room' + (on ? " on" : "") + '" data-room="' + kEsc(r.name) + '"><i class="k-ri">' + K_ICON.bulb + '</i><span class="k-rn">' + kEsc(r.name) + '</span><span class="k-rs">' + sub + "</span></button>";
  }).join("") || '<span class="muted">Устройства света не найдены</span>';
  const c = $("#kLightCount"); if (c) c.textContent = totalAll ? "· " + totalOn + " из " + totalAll : "";
  kioskLayoutRooms();
  $$("[data-room]", box).forEach((b) => b.onclick = () => {
    const r = rooms.find((x) => x.name === b.dataset.room); if (!r) return;
    const on = !(r.lights.some(kLampOn) || (!r.lights.length && r.switches.some(kLampOn)));
    kioskPower([r], on, r.name + (on ? ": включаю…" : ": выключаю…"));
  });
}
// ровная сетка без «сирот»: число колонок подбирается так, чтобы строки были одинаковыми, неполная последняя строка центрируется
function kioskLayoutRooms() {
  const box = $("#kRooms"); if (!box) return;
  const tiles = $$(".k-room", box), n = tiles.length; if (!n) return;
  const gap = 10, minW = 150, maxCols = Math.max(1, Math.floor((box.clientWidth + gap) / (minW + gap)));
  let cols = Math.min(n, maxCols);
  if (n > cols) { // ищем делитель n, чтобы все строки были полными; иначе — равномерные строки
    let best = 0; for (let c = Math.min(maxCols, n); c >= 2; c--) if (n % c === 0) { best = c; break; }
    cols = best || Math.ceil(n / Math.ceil(n / maxCols));
  }
  box.style.gridTemplateColumns = "repeat(" + cols * 2 + ", minmax(0, 1fr))";
  const rem = n % cols;
  tiles.forEach((t, i) => {
    t.style.gridColumnEnd = "span 2";
    t.style.gridColumnStart = rem && i === n - rem ? String(cols - rem + 1) : "auto"; // неполная последняя строка — по центру
  });
}
async function kioskPower(rooms, on, msg) {
  if (kk.busy) return; kk.busy = true;
  const m = $("#kLightMsg"); if (m) { m.textContent = msg || ""; m.className = "busy"; }
  $$(".k-btn, .k-room", $("#kLight")).forEach((b) => b.disabled = true);
  const send = (d, code, v) => post("/api/home/command", { id: d.id, commands: [{ code, value: v }] }).then(() => { const s = (d.status ||= []).find((x) => x.code === code); if (s) s.value = v; else d.status.push({ code, value: v }); return true; }).catch(() => false);
  const results = [];
  try {
    const lights = rooms.flatMap((r) => r.lights).filter((d) => d.online), sws = rooms.flatMap((r) => r.switches).filter((d) => d.online);
    if (on) {
      // сначала питание (выключатели комнат), потом лампы
      if (sws.length) { results.push(...await Promise.all(sws.map((d) => send(d, "switch_1", true)))); if (lights.some((d) => d.power === "off" || sws.length)) await new Promise((r) => setTimeout(r, 2500)); }
      results.push(...await Promise.all(lights.map((d) => send(d, "switch_led", true))));
    } else {
      // сначала лампы, затем выключатели
      results.push(...await Promise.all(lights.map((d) => send(d, "switch_led", false))));
      results.push(...await Promise.all(sws.map((d) => send(d, "switch_1", false))));
    }
    const bad = results.filter((x) => !x).length;
    if (m) { m.textContent = bad ? "не ответили: " + bad : (on ? "включено" : "выключено"); m.className = bad ? "bad" : "ok"; }
  } catch (e) { if (m) { m.textContent = "ошибка"; m.className = "bad"; } }
  finally {
    kk.busy = false;
    $$(".k-btn", $("#kLight")).forEach((b) => b.disabled = false);
    setTimeout(() => { const mm = $("#kLightMsg"); if (mm) { mm.textContent = ""; mm.className = ""; } }, 4000);
    kioskRenderRooms(); setTimeout(() => kioskDevices(true), 2500);
  }
}
window.addEventListener("resize", () => { if (kk.on) kioskLayoutRooms(); });
function kioskLightBind() {
  $$("[data-kl]", $("#kLight")).forEach((b) => b.onclick = async () => {
    const on = b.dataset.kl === "on";
    if (!on) { // «выключить всё» — штатная команда панели (лампы, выключатели, розетки)
      if (kk.busy) return; kk.busy = true; const m = $("#kLightMsg"); m.textContent = "выключаю всё…"; m.className = "busy";
      try { const r = await post("/api/home/alloff"); m.textContent = "выключено: " + r.done + (r.failed ? ", не ответили: " + r.failed : ""); m.className = r.failed ? "bad" : "ok"; }
      catch (e) { m.textContent = "ошибка"; m.className = "bad"; }
      kk.busy = false; setTimeout(() => { m.textContent = ""; m.className = ""; }, 4000); setTimeout(() => kioskDevices(true), 1500);
      return;
    }
    kioskPower(kRoomsMap(), true, "включаю весь свет…");
  });
}

// ---- камеры ----
function kioskStopCams() {
  kioskCamClose();
  kk.gen++;
  (kk.snaps || []).forEach((s) => { try { s.stop(); } catch (e) {} }); kk.snaps = [];
  const box = $("#kCams"); if (box) { box.querySelectorAll("video").forEach((v) => { v.removeAttribute("src"); v.load(); }); box.innerHTML = ""; }
}
async function kioskCams() {
  kioskStopCams();
  const box = $("#kCams"); if (!box) return;
  const hevc = (() => { try { return new URLSearchParams(location.search).get("snap") !== "1" && !!document.createElement("video").canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"'); } catch (e) { return false; } })();
  const snapMode = !hevc && typeof Worker !== "undefined" && !!window.HevcSnap; // у обоев Wallpaper Engine нет видеодекодеров: рисуем ключевые кадры
  const wpMode = document.documentElement.classList.contains("wp"); // на обоях камеры работают и ночью
  if ((kNight() && !wpMode) || window.ZH_NOCAMS || (!hevc && !snapMode)) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  if (typeof cams === "undefined") return;
  if (!cams.loaded) await camsLoadConfig();
  if (!kk.on) return;
  const ids = homeCamsIds().slice(0, 3), gen = kk.gen;
  if (!ids.length) { box.classList.add("hidden"); return; }
  box.innerHTML = ids.map((n) => { const c = cams.list.find((x) => x.n === n); return `<div class="k-cam" data-n="${n}">${snapMode ? "<canvas></canvas>" : "<video muted autoplay playsinline></video>"}<span>${kEsc(c ? camName(c) : "Камера " + n)}</span><em>подключаюсь…</em></div>`; }).join("");
  $$(".k-cam", box).forEach((tile, i) => {
    const n = Number(tile.dataset.n), v = $("video", tile), cv = $("canvas", tile), msg = $("em", tile);
    let snap = null;
    const start = async () => {
      if (gen !== kk.gen || !kk.on) return;
      msg.classList.remove("hidden"); msg.textContent = "подключаюсь…";
      try {
        if (snapMode) {
          if (snap) snap.stop();
          snap = HevcSnap.start(null, cv, { intervalMs: 5000, maxW: 960,
            getUrl: async () => { const d = await post("/api/cameras/archive-url", { camera: n, slot: "h", live: true }); if (!d.stream) throw new Error("нет потока"); return camVideoSrc(d.stream); },
            onWarn: () => { if (!cv.width || cv.width === 300) msg.textContent = "нет сигнала"; },
            onFrame: () => msg.classList.add("hidden"),
            onError: () => { if (snap) snap.stop(); if (gen === kk.gen && kk.on) setTimeout(start, 6000); } });
          kk.snaps.push(snap);
        } else {
          const d = await post("/api/cameras/archive-url", { camera: n, slot: "h", live: true });
          if (gen !== kk.gen || !d.stream) return;
          v.src = camVideoSrc(d.stream);
        }
      } catch (e) { msg.textContent = "нет сигнала"; setTimeout(start, 15000); }
    };
    if (v) {
      v.addEventListener("playing", () => msg.classList.add("hidden"));
      const retry = () => { if (gen === kk.gen && kk.on) setTimeout(start, 6000); };
      v.addEventListener("error", retry); v.addEventListener("ended", retry);
    }
    setTimeout(start, i * 900);
    tile.addEventListener("click", () => kioskCamOpen(n, snapMode, $("span", tile).textContent));
  });
}

// ---- камера на весь экран по нажатию (закрывается нажатием, сама — через 5 минут) ----
function kioskCamOpen(n, snapMode, title) {
  kioskCamClose();
  const ov = document.createElement("div"); ov.className = "k-camfull"; ov.id = "kCamFull";
  ov.innerHTML = (snapMode ? "<canvas></canvas>" : "<video muted autoplay playsinline></video>") +
    '<div class="k-camfull-bar"><i class="k-vdot"></i><b>' + kEsc(title) + '</b><em>подключаюсь…</em><span class="k-camfull-x">✕</span></div>';
  $("#kiosk").appendChild(ov);
  const msg = $("em", ov), gen = kk.gen;
  ov.addEventListener("click", kioskCamClose);
  const start = async () => {
    if (!$("#kCamFull") || gen !== kk.gen) return;
    try {
      const d = await post("/api/cameras/archive-url", { camera: n, slot: "h", live: true });
      if (!$("#kCamFull") || !d.stream) return;
      if (snapMode) {
        // постоянный поток: кадр раз в секунду в полном размере (пока окно открыто)
        kk.camFull = HevcSnap.start(camVideoSrc(d.stream), $("canvas", ov), { intervalMs: 1000, maxW: 1920,
          onFrame: () => { msg.textContent = "в эфире"; },
          onError: () => { if (kk.camFull) kk.camFull.stop(); kk.camFull = null; msg.textContent = "переподключаюсь…"; setTimeout(start, 3000); } });
      } else {
        const v = $("video", ov); v.src = camVideoSrc(d.stream);
        v.addEventListener("playing", () => { msg.textContent = "в эфире"; });
      }
    } catch (e) { msg.textContent = "нет сигнала"; }
  };
  start();
  kk.camFullTimer = setTimeout(kioskCamClose, 5 * 60000);
}
function kioskCamClose() {
  clearTimeout(kk.camFullTimer);
  if (kk.camFull) { try { kk.camFull.stop(); } catch (e) {} kk.camFull = null; }
  const ov = $("#kCamFull");
  if (ov) { const v = $("video", ov); if (v) { v.removeAttribute("src"); v.load(); } ov.remove(); }
}

function kioskStart() {
  kioskBuild();
  kk.on = true; kk.gen++;
  document.body.classList.add("kiosk-mode");
  kioskClock(); kioskWeather(); kioskPoke(); kioskWeatherLoad(); if (!kk.musicOn && $("#kMusic")) { kk.musicOn = true; kioskMusic(); }
  [2500, 8000, 20000].forEach((ms) => setTimeout(() => { if (kk.on) kioskWeather(); }, ms)); // погода подгружается чуть позже
  kk.timers.push(setInterval(kioskClock, 1000));
  kioskTiles(); kk.timers.push(setInterval(kioskTiles, 30000));
  kioskAc();
  kioskVpn(); kk.timers.push(setInterval(() => { if (!kk.vpnBusy && !$("#kVpnSheet")) kioskVpn(); }, 60000));
  kioskLightBind(); kioskDevices(false); kk.timers.push(setInterval(() => { if (!kk.busy) kioskDevices(false); }, 45000));
  kk.timers.push(setInterval(kioskWeather, 60000));
  kk.timers.push(setInterval(kioskWeatherLoad, 15 * 60000));
  kioskMap(); kk.timers.push(setInterval(kioskMap, 10 * 60000));
  kioskTicker(); kk.timers.push(setInterval(kioskTicker, 90000));
  kioskCams(); kk.timers.push(setInterval(kioskCams, 8 * 60000));
  // защита экрана: лёгкий сдвиг картинки раз в минуту; ночью экран затемняется
  kk.timers.push(setInterval(() => { const d = $("#kDrift"); if (d) d.style.transform = `translate(${Math.round(Math.random() * 20 - 10)}px, ${Math.round(Math.random() * 20 - 10)}px)`; }, 60000));
  let wasNight = kNight();
  kk.timers.push(setInterval(() => { if (kNight() !== wasNight) { wasNight = kNight(); kioskCams(); } }, 30000));
  const wp = document.documentElement.classList.contains("wp");
  try { const el = document.documentElement; if (!wp && !document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {}); } catch (e) {}
  document.addEventListener("keydown", kioskKey);
}
function kioskKey(e) { if (e.key === "Escape" && kk.on) kioskExit(); }
function kioskStop() {
  kk.on = false; kk.timers.forEach((t) => clearInterval(t)); kk.timers = []; clearTimeout(kk.mapT); kk.mapLoop = false;
  kioskStopCams();
  if (kk.map) { kk.map.stop(); }
  document.body.classList.remove("kiosk-mode", "k-night");
  document.removeEventListener("keydown", kioskKey);
}

const _goKiosk = go;
go = function (p) {
  if (p !== "kiosk" && kk.on) kioskStop();
  _goKiosk(p);
  if (p === "kiosk" && !kk.on) kioskStart();
};
