"use strict";
// ZALET HOME — уют: камин, окно с настоящей погодой, сцены света, тёплые фото.

// ---------- камин ----------
const fire = (() => {
  const cv = $("#fireCanvas"), ctx = cv.getContext("2d");
  let W = 0, H = 0, dpr = 1, raf = 0, parts = [], sparks = [], boost = 0, t0 = performance.now();
  function resize() {
    const r = cv.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function emit(n) {
    const base = H * 0.80, cx = W * 0.66, spread = Math.min(W * 0.20, 150);
    for (let i = 0; i < n; i++) {
      const x = cx + (Math.random() - 0.5) * spread * 1.6 * Math.random() * 1.4;
      parts.push({ x, y: base - Math.random() * 6, vx: (Math.random() - 0.5) * 0.4, vy: -(0.9 + Math.random() * 1.6) * (1 + boost * 0.6),
        life: 0, max: 40 + Math.random() * 40, r: 10 + Math.random() * 16 * (1 + boost * 0.4), off: Math.random() * 100 });
    }
  }
  function spark(n) {
    const base = H * 0.78, cx = W * 0.66;
    for (let i = 0; i < n; i++) sparks.push({ x: cx + (Math.random() - 0.5) * 120, y: base, vx: (Math.random() - 0.5) * 1.6, vy: -(1.5 + Math.random() * 3), life: 0, max: 60 + Math.random() * 80 });
  }
  function drawRoom(t) {
    // тёмная комната, тёплый отсвет на стене
    const flick = 0.85 + Math.sin(t * 7.3) * 0.05 + Math.sin(t * 13.1) * 0.04 + boost * 0.1;
    ctx.fillStyle = "#0d0907"; ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * 0.66, H * 0.72, 10, W * 0.66, H * 0.72, Math.max(W, H) * 0.85);
    g.addColorStop(0, `rgba(255,120,40,${0.42 * flick})`); g.addColorStop(0.35, `rgba(150,55,20,${0.20 * flick})`); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // портал камина
    const px = W * 0.66, pw = Math.min(W * 0.52, 380), ph = H * 0.62, top = H * 0.86 - ph;
    ctx.fillStyle = "#1c120d"; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(px - pw / 2 - 18, top - 18, pw + 36, ph + 30, 10) : ctx.rect(px - pw / 2 - 18, top - 18, pw + 36, ph + 30); ctx.fill();
    // кирпичи
    ctx.save(); ctx.beginPath(); ctx.rect(px - pw / 2 - 18, top - 18, pw + 36, ph + 30); ctx.clip();
    for (let row = 0; row * 14 < ph + 30; row++) for (let col = -1; col * 34 < pw + 60; col++) {
      const bx = px - pw / 2 - 18 + col * 34 + (row % 2) * 17, by = top - 18 + row * 14;
      ctx.fillStyle = `rgba(${90 + (row * 7 + col * 13) % 30},${40 + (col * 5) % 14},${26},${0.35 * flick})`; ctx.fillRect(bx + 1, by + 1, 31, 11);
    }
    ctx.restore();
    // топка (арка)
    ctx.fillStyle = "#050302"; ctx.beginPath();
    ctx.moveTo(px - pw / 2 + 12, H * 0.86); ctx.lineTo(px - pw / 2 + 12, top + ph * 0.34);
    ctx.quadraticCurveTo(px, top - ph * 0.08, px + pw / 2 - 12, top + ph * 0.34); ctx.lineTo(px + pw / 2 - 12, H * 0.86); ctx.fill();
    // полка
    ctx.fillStyle = "#2a1a12"; ctx.fillRect(px - pw / 2 - 34, top - 30, pw + 68, 14);
    ctx.fillStyle = `rgba(255,150,80,${0.18 * flick})`; ctx.fillRect(px - pw / 2 - 34, top - 17, pw + 68, 2);
    // свечи на полке
    [[-0.38, 22], [-0.3, 30], [0.36, 18]].forEach(([k, h], i) => {
      const cx = px + pw * k, cy = top - 30;
      ctx.fillStyle = "#e9dcc6"; ctx.fillRect(cx - 5, cy - h, 10, h);
      const fl = Math.sin(t * 9 + i * 2) * 1.2;
      const cg = ctx.createRadialGradient(cx, cy - h - 6, 0, cx, cy - h - 6, 26); cg.addColorStop(0, "rgba(255,190,90,.55)"); cg.addColorStop(1, "rgba(255,150,60,0)");
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy - h - 6, 26, 0, 7); ctx.fill();
      ctx.fillStyle = "#ffd27a"; ctx.beginPath(); ctx.ellipse(cx + fl * 0.4, cy - h - 6, 3, 7 + fl, 0, 0, 7); ctx.fill();
    });
    // пол
    const fg = ctx.createLinearGradient(0, H * 0.86, 0, H); fg.addColorStop(0, `rgba(120,50,20,${0.35 * flick})`); fg.addColorStop(1, "#080504");
    ctx.fillStyle = fg; ctx.fillRect(0, H * 0.86, W, H * 0.14);
    return { px, pw };
  }
  function drawLogs(px) {
    const y = H * 0.82;
    [[-60, 0, 0.12], [55, 0, -0.1], [0, -14, 0.02]].forEach(([dx, dy, a]) => {
      ctx.save(); ctx.translate(px + dx, y + dy); ctx.rotate(a);
      ctx.fillStyle = "#3a2214"; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-70, -9, 140, 18, 9) : ctx.rect(-70, -9, 140, 18); ctx.fill();
      ctx.fillStyle = "rgba(255,110,30,.55)"; ctx.fillRect(-60, 3, 120, 3);
      ctx.restore();
    });
    // угли
    const eg = ctx.createRadialGradient(px, y + 6, 4, px, y + 6, 110); eg.addColorStop(0, "rgba(255,140,40,.8)"); eg.addColorStop(1, "rgba(255,60,10,0)");
    ctx.fillStyle = eg; ctx.beginPath(); ctx.ellipse(px, y + 8, 110, 16, 0, 0, 7); ctx.fill();
  }
  function draw(now) {
    const t = (now - t0) / 1000;
    boost = Math.max(0, boost - 0.004);
    const { px } = drawRoom(t);
    drawLogs(px);
    emit(window.innerWidth < 600 ? 3 : 5);
    ctx.globalCompositeOperation = "lighter";
    parts = parts.filter((p) => ++p.life < p.max);
    for (const p of parts) {
      const k = p.life / p.max;
      p.x += p.vx + Math.sin((t * 3 + p.off + p.life * 0.08)) * 0.5 + (px - p.x) * 0.008;
      p.y += p.vy;
      const r = p.r * (1 - k * 0.7);
      const c = k < 0.25 ? [255, 230, 150] : k < 0.55 ? [255, 150, 50] : [210, 60, 20];
      const a = (1 - k) * 0.42;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, `rgba(${c},${a})`); g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
    }
    if (Math.random() < 0.08 + boost * 0.3) spark(1);
    sparks = sparks.filter((s) => ++s.life < s.max && s.y > 0);
    for (const s of sparks) {
      s.x += s.vx + Math.sin(s.life * 0.15) * 0.4; s.y += s.vy; s.vy *= 0.985;
      ctx.fillStyle = `rgba(255,${170 + Math.random() * 60},90,${1 - s.life / s.max})`; ctx.fillRect(s.x, s.y, 1.8, 1.8);
    }
    ctx.globalCompositeOperation = "source-over";
    // левая часть темнее — под текст
    const sh = ctx.createLinearGradient(0, 0, W * 0.6, 0); sh.addColorStop(0, "rgba(8,6,5,.88)"); sh.addColorStop(1, "rgba(8,6,5,0)");
    ctx.fillStyle = sh; ctx.fillRect(0, 0, W * 0.6, H);
    raf = requestAnimationFrame(draw);
  }
  function start() { resize(); cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  window.addEventListener("resize", () => { if (W) resize(); });
  return { start, stop };
})();

function renderMood() {
  const h = new Date().getHours();
  const m = h < 5 ? ["НОЧЬ", "ТИХАЯ НОЧЬ", "Угли ещё тлеют. Всё спокойно, дом спит."] :
    h < 11 ? ["УТРО", "ДОБРОЕ УТРО", "Кофе, мягкий свет и никуда не спешить."] :
    h < 17 ? ["ДЕНЬ", "ДОМА ХОРОШО", "Тепло, тихо, всё работает как надо."] :
    h < 22 ? ["ВЕЧЕР", "ВЕЧЕР У КАМИНА", "Плед, чай и тихий треск поленьев."] : ["ПОЗДНО", "ПОРА ОТДЫХАТЬ", "Приглушите свет — камин догорит сам."];
  $("#fireMood").textContent = m[0]; $("#fireTitle").textContent = m[1]; $("#fireText").textContent = m[2];
}

// ---------- окно и погода ----------
const WEATHER = { 0: ["Ясно", "clear"], 1: ["Почти ясно", "clear"], 2: ["Переменная облачность", "cloud"], 3: ["Пасмурно", "cloud"], 45: ["Туман", "fog"], 48: ["Изморозь", "fog"],
  51: ["Морось", "rain"], 53: ["Морось", "rain"], 55: ["Сильная морось", "rain"], 56: ["Ледяная морось", "rain"], 57: ["Ледяная морось", "rain"],
  61: ["Небольшой дождь", "rain"], 63: ["Дождь", "rain"], 65: ["Ливень", "rain"], 66: ["Ледяной дождь", "rain"], 67: ["Ледяной дождь", "rain"],
  71: ["Небольшой снег", "snow"], 73: ["Снег", "snow"], 75: ["Снегопад", "snow"], 77: ["Снежная крупа", "snow"],
  80: ["Ливень", "rain"], 81: ["Ливень", "rain"], 82: ["Сильный ливень", "rain"], 85: ["Снегопад", "snow"], 86: ["Сильный снегопад", "snow"],
  95: ["Гроза", "storm"], 96: ["Гроза с градом", "storm"], 99: ["Гроза с градом", "storm"] };
const WICON = { clear: "☀", cloud: "☁", fog: "≋", rain: "☂", snow: "❄", storm: "⚡" };
let weather = null;
async function loadWeather() {
  try {
    weather = await api("/api/home/weather");
    try { localStorage.setItem("zh-weather", JSON.stringify(weather)); } catch (e) {}
  } catch (e) {
    try { weather = JSON.parse(localStorage.getItem("zh-weather") || "null"); } catch (er) {}
  }
  renderWeather();
}
function renderWeather() {
  if (!weather?.current) { $("#wDesc").textContent = "погода недоступна"; $("#wTemp").textContent = "—°"; return; }
  const c = weather.current, w = WEATHER[c.weather_code] || ["—", "cloud"];
  $("#wTemp").textContent = `${c.temperature_2m > 0 ? "+" : ""}${Math.round(c.temperature_2m)}°`;
  $("#wDesc").textContent = w[0];
  const tip = c.temperature_2m < -15 ? "Мороз — лучший повод не выходить" : c.temperature_2m < 0 ? "Холодно — дома теплее" : w[1] === "rain" ? "Дождь — самое время для чая" : c.temperature_2m > 22 ? "Тепло — можно открыть окно" : "Хорошая погода для прогулки";
  $("#wMore").innerHTML = `ОЩУЩАЕТСЯ ${Math.round(c.apparent_temperature)}° · ВЕТЕР ${Math.round(c.wind_speed_10m)} М/С · ВЛАЖНОСТЬ ${c.relative_humidity_2m}%<br><span class="win-tip">${tip}</span>`;
  const d = weather.daily; const DN = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
  $("#wDays").innerHTML = (d?.time || []).slice(1, 4).map((t, i) => {
    const ww = WEATHER[d.weather_code[i + 1]] || ["", "cloud"];
    return `<div><span class="mono-label">${DN[new Date(t).getDay()]}</span><i>${WICON[ww[1]]}</i><b>${Math.round(d.temperature_2m_max[i + 1])}°</b><span>${Math.round(d.temperature_2m_min[i + 1])}°</span></div>`;
  }).join("");
  const hr = new Date().getHours();
  win.setWeather(w[1], weather.source === "wttr.in" ? hr >= 7 && hr < 19 : !!c.is_day);
}
const win = (() => {
  const cv = $("#windowCanvas"), ctx = cv.getContext("2d");
  let W = 0, H = 0, dpr = 1, raf = 0, kind = "clear", day = true, drops = [], stars = [], flash = 0, t0 = performance.now();
  function resize() {
    const r = cv.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: 50 }, () => ({ x: Math.random() * W, y: Math.random() * H * 0.6, p: Math.random() * 6 }));
  }
  function setWeather(k, d) { kind = k; day = d; drops = []; }
  function draw(now) {
    const t = (now - t0) / 1000;
    // небо
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    const dark = !day;
    if (dark) { sky.addColorStop(0, "#070a18"); sky.addColorStop(1, "#1a1530"); }
    else if (kind === "clear") { sky.addColorStop(0, "#3c6fb0"); sky.addColorStop(1, "#f0b48a"); }
    else { sky.addColorStop(0, "#4b5262"); sky.addColorStop(1, "#8a8f9c"); }
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    if (dark && (kind === "clear" || kind === "cloud")) stars.forEach((s) => { ctx.fillStyle = `rgba(255,255,255,${0.3 + Math.sin(t * 2 + s.p) * 0.3})`; ctx.fillRect(s.x, s.y, 1.4, 1.4); });
    if (kind === "clear") {
      const ox = W * 0.72, oy = H * 0.26;
      const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, 70); g.addColorStop(0, dark ? "rgba(230,230,255,.5)" : "rgba(255,230,160,.8)"); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ox, oy, 70, 0, 7); ctx.fill();
      ctx.fillStyle = dark ? "#e8e6f5" : "#fff1c2"; ctx.beginPath(); ctx.arc(ox, oy, 18, 0, 7); ctx.fill();
      if (dark) { ctx.fillStyle = "#0d1022"; ctx.beginPath(); ctx.arc(ox + 8, oy - 5, 16, 0, 7); ctx.fill(); }
    }
    if (kind === "cloud" || kind === "rain" || kind === "snow" || kind === "storm" || kind === "fog") {
      for (let i = 0; i < 5; i++) {
        const x = ((t * 6 + i * W / 4) % (W + 200)) - 100, y = 30 + i * 22;
        ctx.fillStyle = dark ? "rgba(60,62,80,.55)" : "rgba(230,232,240,.45)";
        ctx.beginPath(); ctx.ellipse(x, y, 70, 18, 0, 0, 7); ctx.ellipse(x + 40, y - 8, 46, 16, 0, 0, 7); ctx.fill();
      }
    }
    // дома напротив с тёплыми окнами
    ctx.fillStyle = dark ? "#0b0b12" : "#3a3a48";
    const hs = [[0.02, 0.5], [0.2, 0.62], [0.42, 0.45], [0.62, 0.58], [0.82, 0.5]];
    hs.forEach(([x, hh], i) => {
      const bx = x * W, bw = W * 0.18, by = H * (1 - hh * 0.6);
      ctx.fillStyle = dark ? "#0b0b12" : "#3d3e4c"; ctx.fillRect(bx, by, bw, H - by);
      for (let r = 0; r < 6; r++) for (let c = 0; c < 3; c++) {
        const lit = ((i * 7 + r * 3 + c * 5) % 5) < (dark ? 2 : 1);
        if (!lit) continue;
        ctx.fillStyle = `rgba(255,${180 + ((r + c) % 3) * 20},100,${dark ? 0.85 : 0.35})`;
        ctx.fillRect(bx + 8 + c * (bw - 16) / 3, by + 10 + r * 16, (bw - 16) / 3 - 6, 8);
      }
    });
    // осадки
    if (kind === "rain" || kind === "storm") {
      while (drops.length < 140) drops.push({ x: Math.random() * W, y: Math.random() * -H, v: 6 + Math.random() * 5 });
      ctx.strokeStyle = "rgba(200,215,255,.45)"; ctx.lineWidth = 1; ctx.beginPath();
      drops.forEach((d) => { d.y += d.v; d.x -= 1; if (d.y > H) { d.y = -10; d.x = Math.random() * W; } ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + 2, d.y - 10); }); ctx.stroke();
    }
    if (kind === "snow") {
      while (drops.length < 110) drops.push({ x: Math.random() * W, y: Math.random() * H, v: 0.4 + Math.random() * 1.2, r: 0.8 + Math.random() * 2, p: Math.random() * 6 });
      ctx.fillStyle = "rgba(255,255,255,.9)";
      drops.forEach((d) => { d.y += d.v; d.x += Math.sin(t + d.p) * 0.4; if (d.y > H) { d.y = -4; d.x = Math.random() * W; } ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 7); ctx.fill(); });
    }
    if (kind === "fog") { ctx.fillStyle = "rgba(200,200,210,.25)"; ctx.fillRect(0, 0, W, H); }
    if (kind === "storm") { if (Math.random() < 0.004) flash = 1; if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash * 0.6})`; ctx.fillRect(0, 0, W, H); flash -= 0.05; } }
    // запотевшее стекло, тёплый отсвет из комнаты
    const room = ctx.createLinearGradient(0, H, 0, H * 0.5); room.addColorStop(0, "rgba(255,140,60,.35)"); room.addColorStop(1, "rgba(255,140,60,0)");
    ctx.fillStyle = room; ctx.fillRect(0, 0, W, H);
    // рама
    ctx.strokeStyle = "#2a1c14"; ctx.lineWidth = 10; ctx.strokeRect(5, 5, W - 10, H - 10);
    ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.moveTo(0, H * 0.42); ctx.lineTo(W, H * 0.42); ctx.stroke();
    // подоконник: кружка с паром
    const sx = W * 0.8, sy = H - 12;
    ctx.fillStyle = "#3a2618"; ctx.fillRect(0, H - 12, W, 12);
    ctx.fillStyle = "#e8d9c4"; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(sx - 12, sy - 22, 24, 22, 4) : ctx.rect(sx - 12, sy - 22, 24, 22); ctx.fill();
    ctx.strokeStyle = "#e8d9c4"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(sx + 13, sy - 12, 6, -1.4, 1.4); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); const ph = t * 1.5 + i * 2; for (let y = 0; y < 26; y += 2) ctx.lineTo(sx - 6 + i * 6 + Math.sin(ph + y * 0.25) * 3, sy - 26 - y); ctx.stroke(); }
    raf = requestAnimationFrame(draw);
  }
  function start() { resize(); cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  window.addEventListener("resize", () => { if (W) resize(); });
  return { start, stop, setWeather };
})();

// анимации камина и окна — только когда главная на экране
function cozyRun(on) {
  if (on && !document.hidden) { fire.start(); win.start(); } else { fire.stop(); win.stop(); }
}
document.addEventListener("visibilitychange", () => cozyRun(page === "home"));

// ---------- тёплые фото ----------
const COZY = [
  ["photo-1704400398712-36422dfbe4ec", "Зимний Омск"], ["photo-1705217813555-cb87950fedcc", "Двор в снегу"], ["photo-1705217813588-67b68a16c935", "Варежки на заборе"],
  ["photo-1705217886824-41ffc20bae20", "Скамейки в снегу"], ["photo-1705217848876-b6413e3f414b", "Солнце сквозь деревья"], ["photo-1705217887093-e43b578f9b1f", "Тихая улица"],
  ["photo-1705217886799-959ac4a015ec", "Вечерний Омск"], ["photo-1704400398595-3ddbcf4dc74a", "Вид из окна"], ["photo-1704400397786-5e0388613ac0", "Огни праздника"],
  ["photo-1575457180622-9ca8a083c50a", "Омское лето"],
];
$("#cozyStrip").innerHTML = COZY.sort(() => Math.random() - 0.5).slice(0, 5).map(([id, cap], i) =>
  `<figure style="--d:${i * 2.4}s"><img loading="lazy" src="https://images.unsplash.com/${id}?w=700&q=70&auto=format&fit=crop" alt="" onload="this.classList.add('show')" onerror="this.closest('figure').remove()"></figure>`).join("");

function cozyStart() { renderMood(); loadWeather(); timers.weather = setInterval(loadWeather, 15 * 60000); timers.mood = setInterval(renderMood, 60000); }
