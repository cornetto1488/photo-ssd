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
        <div class="k-tiles" id="kTiles"></div>
      </div>
      <div class="k-map"><canvas id="kMap"></canvas><div class="k-maplabel" id="kMapLabel"></div></div>
      <div class="k-cams" id="kCams"></div>
      <div class="k-ticker" id="kTicker"></div>
    </div>
    <button class="k-exit" id="kExit" title="Выйти из киоска">✕</button>`;
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
async function kioskMap() {
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

// ---- камеры ----
function kioskStopCams() {
  kk.gen++;
  const box = $("#kCams"); if (box) { box.querySelectorAll("video").forEach((v) => { v.removeAttribute("src"); v.load(); }); box.innerHTML = ""; }
}
async function kioskCams() {
  kioskStopCams();
  const box = $("#kCams"); if (!box) return;
  if (kNight()) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  if (typeof cams === "undefined") return;
  if (!cams.loaded) await camsLoadConfig();
  if (!kk.on) return;
  const ids = homeCamsIds().slice(0, 3), gen = kk.gen;
  if (!ids.length) { box.classList.add("hidden"); return; }
  box.innerHTML = ids.map((n) => { const c = cams.list.find((x) => x.n === n); return `<div class="k-cam" data-n="${n}"><video muted autoplay playsinline></video><span>${kEsc(c ? camName(c) : "Камера " + n)}</span><em>подключаюсь…</em></div>`; }).join("");
  $$(".k-cam", box).forEach((tile, i) => {
    const n = Number(tile.dataset.n), v = $("video", tile), msg = $("em", tile);
    const start = async () => {
      if (gen !== kk.gen || !kk.on) return;
      msg.classList.remove("hidden"); msg.textContent = "подключаюсь…";
      try {
        const d = await post("/api/cameras/archive-url", { camera: n, slot: "h", live: true });
        if (gen !== kk.gen || !d.stream) return;
        v.src = camVideoSrc(d.stream);
      } catch (e) { msg.textContent = "нет сигнала"; setTimeout(start, 15000); }
    };
    v.addEventListener("playing", () => msg.classList.add("hidden"));
    const retry = () => { if (gen === kk.gen && kk.on) setTimeout(start, 6000); };
    v.addEventListener("error", retry); v.addEventListener("ended", retry);
    setTimeout(start, i * 700);
  });
}

function kioskStart() {
  kioskBuild();
  kk.on = true; kk.gen++;
  document.body.classList.add("kiosk-mode");
  kioskClock(); kioskWeather(); kioskPoke();
  [2500, 8000, 20000].forEach((ms) => setTimeout(() => { if (kk.on) kioskWeather(); }, ms)); // погода подгружается чуть позже
  kk.timers.push(setInterval(kioskClock, 1000));
  kioskTiles(); kk.timers.push(setInterval(kioskTiles, 30000));
  kk.timers.push(setInterval(kioskWeather, 60000));
  kioskMap(); kk.timers.push(setInterval(kioskMap, 10 * 60000));
  kioskTicker(); kk.timers.push(setInterval(kioskTicker, 90000));
  kioskCams(); kk.timers.push(setInterval(kioskCams, 8 * 60000));
  // защита экрана: лёгкий сдвиг картинки раз в минуту; ночью экран затемняется
  kk.timers.push(setInterval(() => { const d = $("#kDrift"); if (d) d.style.transform = `translate(${Math.round(Math.random() * 20 - 10)}px, ${Math.round(Math.random() * 20 - 10)}px)`; }, 60000));
  let wasNight = kNight();
  kk.timers.push(setInterval(() => { if (kNight() !== wasNight) { wasNight = kNight(); kioskCams(); } }, 30000));
  try { const el = document.documentElement; if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {}); } catch (e) {}
  document.addEventListener("keydown", kioskKey);
}
function kioskKey(e) { if (e.key === "Escape" && kk.on) kioskExit(); }
function kioskStop() {
  kk.on = false; kk.timers.forEach((t) => clearInterval(t)); kk.timers = [];
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
