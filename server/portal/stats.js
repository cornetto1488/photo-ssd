"use strict";
// ZALET HOME — статистика: свет по дням и часам, скорость интернета, трафик по устройствам. Графики — чистый SVG.

const stx = { tab: "lights", days: 7, hours: 24 };
const esc2 = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function fmtHM(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec ? "<1 мин" : "0";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}
const dayShort = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "");
const weekdayShort = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("ru-RU", { weekday: "short" });
const agoText = (t) => { const s = Math.floor(Date.now() / 1000 - t); if (s < 90) return "только что"; if (s < 3600) return Math.floor(s / 60) + " мин назад"; if (s < 86400) return Math.floor(s / 3600) + " ч назад"; return Math.floor(s / 86400) + " дн назад"; };

// ---- графики ----
function gridLines(W, h, padT, padB) {
  let s = "";
  for (let i = 0; i < 4; i++) { const y = padT + (h - padB - padT) * i / 3; s += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" class="st-grid"/>`; }
  return s;
}
function barChart(vals, labels, { color = "var(--acc)", h = 150, labelEvery = 1, tip } = {}) {
  const W = 700, padB = 22, padT = 8, n = vals.length || 1, max = Math.max(...vals, 0.0001);
  const bw = W / n, gap = Math.min(8, bw * 0.25);
  let s = `<svg viewBox="0 0 ${W} ${h}" class="st-svg" preserveAspectRatio="none">` + gridLines(W, h, padT, padB);
  vals.forEach((v, i) => {
    const bh = Math.max(v > 0 ? 2 : 0, (h - padB - padT) * v / max), x = i * bw + gap / 2, y = h - padB - bh;
    s += `<rect x="${x}" y="${y}" width="${bw - gap}" height="${bh}" rx="3" style="fill:${color}" opacity="${v > 0 ? 1 : .15}"><title>${esc2(tip ? tip(i, v) : labels[i] + ": " + v)}</title></rect>`;
    if (i % labelEvery === 0) s += `<text x="${x + (bw - gap) / 2}" y="${h - 6}" class="st-lab" text-anchor="middle">${esc2(labels[i])}</text>`;
  });
  return s + `</svg>`;
}
function stackedChart(a, b, labels, { colorA, colorB, fmt, h = 150, labelEvery = 1 }) {
  const W = 700, padB = 22, padT = 8, n = a.length || 1, max = Math.max(...a.map((v, i) => v + b[i]), 1);
  const bw = W / n, gap = Math.min(6, bw * 0.25);
  let s = `<svg viewBox="0 0 ${W} ${h}" class="st-svg" preserveAspectRatio="none">` + gridLines(W, h, padT, padB);
  a.forEach((v, i) => {
    const ha = (h - padB - padT) * v / max, hb = (h - padB - padT) * b[i] / max, x = i * bw + gap / 2;
    s += `<rect x="${x}" y="${h - padB - ha}" width="${bw - gap}" height="${ha}" rx="2" style="fill:${colorA}"><title>${esc2(labels[i])}: ↓ ${fmt(v)}</title></rect>`;
    s += `<rect x="${x}" y="${h - padB - ha - hb}" width="${bw - gap}" height="${hb}" rx="2" style="fill:${colorB}"><title>${esc2(labels[i])}: ↑ ${fmt(b[i])}</title></rect>`;
    if (i % labelEvery === 0) s += `<text x="${x + (bw - gap) / 2}" y="${h - 6}" class="st-lab" text-anchor="middle">${esc2(labels[i])}</text>`;
  });
  return s + `</svg>`;
}
function lineChart(pts, { h = 170, unit = "" } = {}) {
  if (!pts.length) return `<div class="st-empty">Замеров пока нет — жми «Замерить скорость» или подожди: роутер мерит сам раз в 6 часов.</div>`;
  const W = 700, padB = 24, padT = 12;
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1), max = Math.max(...pts.map((p) => p.v), 1) * 1.15;
  const X = (t) => (pts.length === 1 ? W / 2 : W * ((t - t0) / (t1 - t0))), Y = (v) => h - padB - (h - padB - padT) * v / max;
  let s = `<svg viewBox="0 0 ${W} ${h}" class="st-svg" preserveAspectRatio="none">` + gridLines(W, h, padT, padB);
  for (let i = 0; i < 4; i++) { const y = padT + (h - padB - padT) * i / 3; s += `<text x="2" y="${y - 3}" class="st-lab">${Math.round(max * (1 - i / 3))}</text>`; }
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t)},${Y(p.v)}`).join(" ");
  if (pts.length > 1) s += `<path d="${line} L${X(t1)},${h - padB} L${X(t0)},${h - padB} Z" style="fill:var(--acc)" opacity=".12"/>`;
  s += `<path d="${line}" fill="none" style="stroke:var(--acc)" stroke-width="2.5" stroke-linejoin="round"/>`;
  pts.forEach((p) => { s += `<circle cx="${X(p.t)}" cy="${Y(p.v)}" r="3.5" style="fill:var(--acc-2)"><title>${new Date(p.t * 1000).toLocaleString("ru-RU")}: ${p.v.toFixed(1)} ${unit}${p.ping ? " · пинг " + p.ping + " мс" : ""}</title></circle>`; });
  const fmtT = (t) => new Date(t * 1000).toLocaleString("ru-RU", t1 - t0 > 2 * 86400 ? { day: "numeric", month: "short" } : { hour: "2-digit", minute: "2-digit" });
  s += `<text x="2" y="${h - 6}" class="st-lab">${fmtT(t0)}</text><text x="${W - 2}" y="${h - 6}" class="st-lab" text-anchor="end">${fmtT(t1)}</text>`;
  return s + `</svg>`;
}
const sparkBars = (vals) => {
  const W = 120, h = 28, max = Math.max(...vals, 0.0001), bw = W / (vals.length || 1);
  return `<svg viewBox="0 0 ${W} ${h}" class="st-spark" preserveAspectRatio="none">${vals.map((v, i) => { const bh = Math.max(v > 0 ? 2 : 0, (h - 2) * v / max); return `<rect x="${i * bw + .5}" y="${h - bh}" width="${Math.max(1, bw - 1.5)}" height="${bh}" rx="1" style="fill:var(--acc-2)" opacity="${v > 0 ? .9 : .15}"/>`; }).join("")}</svg>`;
};
const miniCard = (label, big, sub) => `<div class="card st-mini"><div class="mono-label">${label}</div><div class="st-big">${big}</div><div class="muted small">${sub || ""}</div></div>`;

// ---- свет ----
async function loadStatsLights() {
  let j;
  try { j = await api(`/api/home/stats/lights?days=${stx.days}`); } catch (e) { $("#stLightCards").innerHTML = `<div class="st-empty">${esc2(e.message)}</div>`; return; }
  const devs = j.devices || [], total = devs.reduce((a, d) => a + d.total, 0), on = devs.filter((d) => d.on);
  if (!devs.length) {
    $("#stLightCards").innerHTML = `<div class="card st-card st-empty">Статистика только начала копиться: роутер записывает каждое включение и выключение света. Загляни через пару часов.</div>`;
    ["stLightDaysChart", "stLightHours", "stLightList"].forEach((id) => { $("#" + id).innerHTML = ""; });
    return;
  }
  const top = devs[0];
  $("#stLightCards").innerHTML =
    miniCard("ВСЕГО ГОРЕЛО", fmtHM(total), `за ${stx.days} дн. · в среднем ${fmtHM(total / stx.days)} в день`) +
    miniCard("БОЛЬШЕ ВСЕГО", esc2(top.name || "—"), top.total ? fmtHM(top.total) + (top.room ? " · " + esc2(top.room) : "") : "пока нет данных") +
    miniCard("СЕЙЧАС ГОРИТ", on.length ? String(on.length) : "ничего", on.length ? esc2(on.map((d) => d.name).slice(0, 3).join(", ")) : "весь свет выключен");
  const labels = j.labels.map((l) => (stx.days <= 7 ? weekdayShort(l) + " " + new Date(l + "T12:00:00").getDate() : String(new Date(l + "T12:00:00").getDate())));
  $("#stLightDaysChart").innerHTML = barChart(j.dayTotals.map((v) => v / 3600), labels, { h: 160, labelEvery: stx.days > 14 ? 3 : 1, tip: (i, v) => `${dayShort(j.labels[i])}: ${fmtHM(v * 3600)}` });
  $("#stLightHours").innerHTML = barChart(j.hours.map((v) => v / 3600), Array.from({ length: 24 }, (_, i) => String(i)), { color: "var(--acc-2)", h: 130, labelEvery: 3, tip: (i, v) => `${i}:00–${i + 1}:00 — ${fmtHM(v * 3600)} суммарно` });
  $("#stLightList").innerHTML = devs.map((d) => `
    <div class="card st-row">
      <div class="st-row-main"><b>${esc2(d.name || d.id)}</b><span class="muted small">${esc2(d.room || "")}${d.on ? ` · <span class="st-on">горит с ${new Date(d.since * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>` : ""}</span></div>
      <div class="st-row-spark">${sparkBars(d.days.map((v) => v / 3600))}</div>
      <div class="st-row-num"><b>${fmtHM(d.total)}</b><span class="muted small">${d.count} вкл.</span></div>
    </div>`).join("");
}

// ---- сеть ----
async function loadStatsNet() {
  let j;
  try { j = await api(`/api/home/stats/net?hours=${stx.hours}`); } catch (e) { $("#stNetCards").innerHTML = `<div class="st-empty">${esc2(e.message)}</div>`; return; }
  const speed = (j.speed || []).map((s) => ({ t: s.t, v: s.mbps, ping: s.ping }));
  const wan = j.wan || [], clients = j.clients || [];
  const sumRx = wan.reduce((a, x) => a + x.rx, 0), sumTx = wan.reduce((a, x) => a + x.tx, 0);
  const last = speed[speed.length - 1], avg = speed.length ? speed.reduce((a, s) => a + s.v, 0) / speed.length : 0;
  const min = speed.length ? Math.min(...speed.map((s) => s.v)) : 0, max = speed.length ? Math.max(...speed.map((s) => s.v)) : 0;
  $("#stNetCards").innerHTML =
    miniCard("СКОРОСТЬ СЕЙЧАС", last ? `${last.v.toFixed(0)} <small>Мбит/с</small>` : "—", last ? `пинг ${last.ping} мс · ${agoText(last.t)}` : "замеров нет") +
    miniCard("В СРЕДНЕМ", speed.length ? `${avg.toFixed(0)} <small>Мбит/с</small>` : "—", speed.length ? `от ${min.toFixed(0)} до ${max.toFixed(0)} · ${speed.length} замеров` : "") +
    miniCard("ТРАФИК ЗА ПЕРИОД", fmtBytes(sumRx + sumTx), `↓ ${fmtBytes(sumRx)} · ↑ ${fmtBytes(sumTx)}`);
  $("#stSpeedChart").innerHTML = lineChart(speed, { unit: "Мбит/с" });
  const long = stx.hours > 48;
  const lab = wan.map((x) => new Date(x.t * 1000).toLocaleString("ru-RU", long ? { day: "numeric", month: "short" } : { hour: "2-digit" }));
  $("#stWanChart").innerHTML = wan.length
    ? stackedChart(wan.map((x) => x.rx), wan.map((x) => x.tx), lab, { colorA: "var(--live)", colorB: "var(--acc)", fmt: fmtBytes, labelEvery: Math.ceil(wan.length / 12) })
    : `<div class="st-empty">Данные о трафике копятся — график появится через несколько минут.</div>`;
  const cmax = Math.max(...clients.map((c) => c.up + c.down), 1);
  $("#stClients").innerHTML = clients.length ? clients.map((c) => `
    <div class="card st-row">
      <div class="st-row-main"><b>${esc2(c.name || c.ip)}</b><span class="muted small">${esc2(c.ip)}</span>
        <div class="st-meter"><i style="width:${Math.max(2, 100 * (c.up + c.down) / cmax)}%"></i></div></div>
      <div class="st-row-spark">${sparkBars(c.series || [])}</div>
      <div class="st-row-num"><b>${fmtBytes(c.up + c.down)}</b><span class="muted small"><span class="st-down">↓${fmtBytes(c.down)}</span> <span class="st-up">↑${fmtBytes(c.up)}</span></span></div>
    </div>`).join("") : `<div class="card st-empty">Пока нет данных по устройствам — копится.</div>`;
}

function loadStats() { if (stx.tab === "lights") loadStatsLights(); else loadStatsNet(); }

$$("#statsTabs [data-st]").forEach((b) => b.onclick = () => {
  stx.tab = b.dataset.st;
  $$("#statsTabs button").forEach((x) => x.classList.toggle("active", x === b));
  $("#stLights").classList.toggle("hidden", stx.tab !== "lights");
  $("#stNet").classList.toggle("hidden", stx.tab !== "net");
  loadStats();
});
$$("#stLightDays [data-d]").forEach((b) => b.onclick = () => { stx.days = Number(b.dataset.d); $$("#stLightDays button").forEach((x) => x.classList.toggle("active", x === b)); loadStatsLights(); });
$$("#stNetHours [data-h]").forEach((b) => b.onclick = () => { stx.hours = Number(b.dataset.h); $$("#stNetHours button").forEach((x) => x.classList.toggle("active", x === b)); loadStatsNet(); });
$("#stSpeedNow") && ($("#stSpeedNow").onclick = async () => {
  const btn = $("#stSpeedNow"); btn.disabled = true; btn.textContent = "Меряю… ~10 с";
  try { const r = await api("/api/home/speed"); toast(`${r.mbps.toFixed(0)} Мбит/с · пинг ${r.ping} мс`); await loadStatsNet(); }
  catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = "⚡ Замерить скорость"; }
});

const _goStats = go;
go = function (p) { _goStats(p); if (p === "stats") loadStats(); };
