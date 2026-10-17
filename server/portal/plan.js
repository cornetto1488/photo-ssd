"use strict";
// План дома: мебель и устройства на карте квартиры (карта — с пылесоса Dreame, 1 клетка = 5 см).
// Хранится на роутере (/api/home/plan), рисуется на всех 3D-картах; страница «План дома» — редактор.

// каталог: размеры в клетках (5 см), z — высота блока на карте, lift — подъём над полом (на столе, на стене)
window.PL_TYPES = {
  bed: { n: "Кровать", w: 32, h: 40, z: 3, c: "#3d3d47", i: "🛏" },
  sofa: { n: "Диван", w: 38, h: 16, z: 4, c: "#6a4a34", i: "🛋" },
  desk: { n: "Компьютерный стол", w: 28, h: 14, z: 4, c: "#4c2b2b", i: "🖥" },
  chair: { n: "Кресло", w: 11, h: 11, z: 5, c: "#6b6258", i: "🪑" },
  table: { n: "Круглый столик", w: 18, h: 18, z: 4, c: "#e9e7e3", round: true, i: "◯" },
  beanbag: { n: "Кресло-мешок", w: 16, h: 16, z: 2, c: "#7a7a82", round: true, i: "●" },
  wardrobe: { n: "Шкаф", w: 12, h: 40, z: 11, c: "#d9d6d0", i: "🚪" },
  rack: { n: "Вешалка", w: 30, h: 10, z: 8, c: "#26262c", i: "👕" },
  dresser: { n: "Комод", w: 16, h: 9, z: 4, c: "#e3e0db", i: "▤" },
  shoes: { n: "Обувница", w: 12, h: 6, z: 5, c: "#e3e0db", i: "👟" },
  fridge: { n: "Холодильник", w: 12, h: 13, z: 9, c: "#e7e5e1", i: "🧊" },
  counter: { n: "Кухня с мойкой", w: 30, h: 12, z: 4, c: "#8c9198", i: "🚰" },
  stove: { n: "Плита", w: 10, h: 12, z: 4, c: "#d6d6d6", i: "🍳" },
  dryer: { n: "Сушилка", w: 28, h: 11, z: 5, c: "#b9bdc3", i: "🧺" },
  bath: { n: "Ванна", w: 14, h: 34, z: 3, c: "#f3f3f3", i: "🛁" },
  sink: { n: "Раковина", w: 10, h: 9, z: 4, c: "#f3f3f3", i: "🚿" },
  toilet: { n: "Унитаз", w: 8, h: 13, z: 4, c: "#f3f3f3", i: "🚽" },
  washer: { n: "Стиральная машина", w: 12, h: 11, z: 4, c: "#f0f0f0", i: "🌀" },
  radiator: { n: "Батарея", w: 3, h: 16, z: 3, c: "#e9e9e9", i: "♨" },
  door: { n: "Входная дверь", w: 3, h: 18, z: 10, c: "#8a2b1c", i: "🚪" },
  window: { n: "Окно", w: 2, h: 26, flat: true, c: "#7fc7ff", i: "▭" },
  // устройства — показывают живое состояние
  lamp: { n: "Свет", w: 6, h: 6, dev: "light", c: "#ffb46b", i: "💡" },
  ac: { n: "Кондиционер", w: 18, h: 4, z: 2, lift: 9, dev: "ac", c: "#f4f4f4", i: "❄" },
  pc: { n: "Компьютер", w: 5, h: 10, z: 5, lift: 4, dev: "pc", c: "#1b1b20", i: "💻" },
  router: { n: "Роутер", w: 6, h: 4, z: 1, lift: 4, dev: "router", c: "#f4f4f4", i: "📶" },
  speaker: { n: "Колонка", w: 4, h: 4, z: 2, lift: 4, c: "#2a2a30", i: "🔊" },
  intercom: { n: "Домофон", w: 2, h: 3, z: 2, lift: 6, c: "#e8e8e8", i: "📞" },
};

// стартовая расстановка — по фото квартиры (примерно; дальше двигается в редакторе)
function plDefault() {
  const it = (t, x, y, ext) => Object.assign({ id: Math.random().toString(36).slice(2, 9), t, x, y, w: PL_TYPES[t].w, h: PL_TYPES[t].h }, ext || {});
  return {
    v: 1,
    rooms: { 1: "Зал", 2: "Кухня", 3: "Ванная", 4: "Прихожая" },
    items: [
      // зал
      it("window", 7, 168), it("radiator", 9, 171), it("desk", 10, 182, { w: 14, h: 28 }), it("pc", 12, 196), it("router", 14, 185),
      it("speaker", 18, 204), it("chair", 26, 192), it("rack", 32, 197), it("bed", 56, 156, { w: 40, h: 32 }),
      it("table", 38, 158), it("beanbag", 20, 154), it("ac", 12, 153), it("lamp", 52, 180, { room: "Зал" }),
      // кухня
      it("counter", 4, 2), it("fridge", 36, 2), it("stove", 4, 44, { w: 12, h: 10 }), it("chair", 42, 26), it("dryer", 52, 24),
      it("sofa", 48, 40, { w: 36, h: 14 }), it("window", 84, 26), it("lamp", 24, 30, { room: "Кухня" }),
      // прихожая
      it("door", 1, 66), it("intercom", 2, 86), it("shoes", 2, 92, { w: 6, h: 12 }), it("wardrobe", 37, 62), it("dresser", 2, 104, { w: 9, h: 16 }),
      it("lamp", 24, 88, { room: "Прихожая" }),
      // ванная
      it("bath", 71, 64), it("sink", 47, 66), it("washer", 47, 100), it("toilet", 73, 100), it("lamp", 64, 86, { room: "Ванная" }),
    ],
  };
}

window.zhPlan = null;
window.zhDevState = { rooms: {}, ac: false, pc: false };
function plRefreshMaps() { (window.zhMaps || []).forEach((m) => { m._dirty = true; if (m.start) m.start(); }); }

async function plLoad() {
  try {
    const p = await api("/api/home/plan");
    window.zhPlan = p && Array.isArray(p.items) ? p : plDefault();
    plLoad.ok = true;
  } catch (e) { if (!window.zhPlan) window.zhPlan = plDefault(); }
  plRefreshMaps();
  return window.zhPlan;
}
async function plSave() { await post("/api/home/plan", window.zhPlan); }

// комнаты в Tuya могут называться иначе, чем на плане: «Гостиная» = «Зал», «Коридор» = «Прихожая»…
const PL_ALIAS = [["Зал", /зал|гостин|спальн|комнат|living|bed/i], ["Кухня", /кухн|kitchen/i], ["Прихожая", /прихож|коридор|холл|hall/i], ["Ванная", /ванн|сануз|туалет|bath/i]];
function plCanon(n) { const a = PL_ALIAS.find(([, re]) => re.test(n || "")); return a ? a[0] : n; }
let plDevNames = [];
// живое состояние: свет по комнатам, кондиционер, ПК
async function plPollDevices() {
  if (!plLoad.ok && !ple.dirty) await plLoad(); // при старте могли быть не авторизованы
  const st = { rooms: {}, names: {}, ac: false, pc: false };
  try {
    const d = await api("/api/home/devices");
    for (const x of d.devices || []) {
      const on = (x.status || []).some((s) => (s.code === "switch_led" || s.code === "switch_1") && s.value === true);
      if (x.room) st.names[x.room] = 1;
      if ((x.kind === "light" || x.kind === "switch") && on && x.room) { st.rooms[x.room] = true; st.rooms[plCanon(x.room)] = true; }
    }
    plDevNames = Object.keys(st.names);
  } catch (e) {}
  try { const a = await api("/api/home/daichi"); st.ac = !!((a.devices || [])[0] || {}).on; } catch (e) {}
  try { const p = await api("/api/home/pc/agent"); st.pc = (p.agents || []).some((x) => x.online); } catch (e) {}
  window.zhDevState = st; plRefreshMaps();
}
plLoad().then(() => { plPollDevices(); setInterval(plPollDevices, 30000); });

// ---------- редактор «План дома» ----------
const ple = { cv: null, ctx: null, map: null, cells: null, s: 4, sel: null, drag: null, view3d: null, dirty: false };

function plEsc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function plEditorOpen() {
  const host = $("#planEditor"); if (!host) return;
  if (!window.zhPlan) await plLoad();
  let c; try { c = await dmLoad(); } catch (e) { host.innerHTML = '<div class="card"><p class="muted">Нужна карта с пылесоса Dreame: подключите его на странице «Пылесос».</p></div>'; return; }
  ple.map = c.map;
  const bin = atob(c.map.cells); ple.cells = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) ple.cells[i] = bin.charCodeAt(i);
  if (!host.dataset.built) {
    host.dataset.built = "1";
    host.innerHTML = `
      <div class="plan-grid">
        <div class="card plan-board"><canvas id="planCanvas"></canvas><div class="plan-hint muted small">Тяните предмет мышкой, за уголок — меняйте размер. R — повернуть, Delete — удалить.</div></div>
        <div class="plan-side">
          <div class="card"><div class="mono-label">ДОБАВИТЬ</div><div class="plan-palette" id="planPalette"></div></div>
          <div class="card" id="planProps"></div>
          <div class="card"><div class="mono-label">КОМНАТЫ</div><div id="planRooms"></div></div>
          <div class="plan-actions"><button class="btn btn-acc" id="planSave">Сохранить</button><button class="btn" id="planReset">Расставить по фото заново</button></div>
          <div class="muted small" id="planMsg"></div>
        </div>
      </div>
      <div class="card plan-3d"><div class="mono-label">ТАК ПЛАН ВЫГЛЯДИТ НА 3D-КАРТЕ</div><canvas id="plan3d"></canvas></div>`;
    $("#planPalette").innerHTML = Object.entries(PL_TYPES).map(([k, t]) => `<button class="plan-add" data-t="${k}" title="${plEsc(t.n)}"><i>${t.i}</i><span>${plEsc(t.n)}</span></button>`).join("");
    $$(".plan-add", host).forEach((b) => b.onclick = () => plAdd(b.dataset.t));
    $("#planSave").onclick = async () => { try { await plSave(); ple.dirty = false; $("#planMsg").textContent = "Сохранено — план виден на всех картах."; plRefreshMaps(); } catch (e) { $("#planMsg").textContent = e.message || "Не сохранилось"; } };
    $("#planReset").onclick = () => { if (confirm("Расставить всё заново по фото? Ваши перемещения пропадут (до сохранения).")) { window.zhPlan = plDefault(); ple.sel = null; plChanged(); } };
    ple.cv = $("#planCanvas"); ple.ctx = ple.cv.getContext("2d");
    ple.cv.addEventListener("pointerdown", plDown); window.addEventListener("pointermove", plMove); window.addEventListener("pointerup", () => { ple.drag = null; });
    document.addEventListener("keydown", (e) => {
      if (!ple.sel || !$("#page-plan.active") || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
      if (e.key === "r" || e.key === "R" || e.key === "к" || e.key === "К") plRotate();
      if (e.key === "Delete" || e.key === "Backspace") plDelete();
    });
    new ResizeObserver(() => plDraw()).observe(ple.cv);
    ple.view3d = new DreameMap3D($("#plan3d"), { autoRotate: false, interactive: true, labels: true });
    ple.view3d.setNames(c.names); ple.view3d.setData(c.map); ple.view3d.progress = 1;
  }
  plRooms(); plProps(); plDraw();
}

function plChanged() { ple.dirty = true; $("#planMsg").textContent = "Есть несохранённые изменения"; plProps(); plDraw(); plRefreshMaps(); }
function plItem() { return (window.zhPlan.items || []).find((x) => x.id === ple.sel); }

function plAdd(t) {
  const ty = PL_TYPES[t], m = ple.map; const room = (m.rooms || [])[0];
  const it = { id: Math.random().toString(36).slice(2, 9), t, w: ty.w, h: ty.h, x: Math.round((room ? room.cx : m.w / 2) - ty.w / 2), y: Math.round((room ? room.cy : m.h / 2) - ty.h / 2) };
  if (ty.dev === "light") it.room = Object.values(window.zhPlan.rooms || {})[0] || "";
  window.zhPlan.items.push(it); ple.sel = it.id; plChanged();
}
function plRotate() { const it = plItem(); if (!it) return; const cx = it.x + it.w / 2, cy = it.y + it.h / 2; [it.w, it.h] = [it.h, it.w]; it.x = Math.round(cx - it.w / 2); it.y = Math.round(cy - it.h / 2); plChanged(); }
function plDelete() { const it = plItem(); if (!it) return; window.zhPlan.items = window.zhPlan.items.filter((x) => x !== it); ple.sel = null; plChanged(); }

function plRooms() {
  const el = $("#planRooms"); if (!el) return;
  const rooms = window.zhPlan.rooms || (window.zhPlan.rooms = {});
  el.innerHTML = (ple.map.rooms || []).map((r) => `<label class="plan-room"><span>${r.area} м²</span><input class="field" data-r="${r.id}" value="${plEsc(rooms[r.id] || "")}" placeholder="Комната ${r.id}"></label>`).join("");
  $$("input[data-r]", el).forEach((i) => i.oninput = () => { rooms[i.dataset.r] = i.value.trim(); plChanged(); });
}
function plProps() {
  const el = $("#planProps"); if (!el) return;
  const it = plItem();
  if (!it) { el.innerHTML = '<div class="mono-label">ПРЕДМЕТ</div><p class="muted small">Нажмите на предмет на плане, чтобы изменить его.</p>'; return; }
  const ty = PL_TYPES[it.t] || {};
  const roomNames = [...new Set([...Object.values(window.zhPlan.rooms || {}), ...plDevNames, it.room].filter(Boolean))];
  el.innerHTML = `<div class="mono-label">ПРЕДМЕТ</div><b class="plan-pname">${ty.i || ""} ${plEsc(ty.n || it.t)}</b>
    <div class="muted small">${it.w * 5} × ${it.h * 5} см</div>
    ${ty.dev === "light" ? `<label class="plan-room"><span>Свет комнаты</span><select class="field" id="planLampRoom">${roomNames.map((n) => `<option ${n === it.room ? "selected" : ""}>${plEsc(n)}</option>`).join("")}</select></label>` : ""}
    <div class="plan-actions"><button class="btn" id="planRot">↻ Повернуть</button><button class="btn" id="planDel">Удалить</button></div>`;
  $("#planRot").onclick = plRotate; $("#planDel").onclick = plDelete;
  const lr = $("#planLampRoom"); if (lr) lr.onchange = () => { it.room = lr.value; plChanged(); };
}

// координаты: клетки карты ↔ пиксели холста (план повёрнут так же, как карта пылесоса, без наклона)
function plGeom() {
  const cv = ple.cv, r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const m = ple.map, s = Math.min((r.width - 16) / m.w, (r.height - 16) / m.h);
  return { r, dpr, s, ox: (r.width - m.w * s) / 2, oy: (r.height - m.h * s) / 2 };
}
function plDraw() {
  const cv = ple.cv; if (!cv || !ple.map) return;
  const g = plGeom(), ctx = ple.ctx, m = ple.map;
  cv.width = Math.round(g.r.width * g.dpr); cv.height = Math.round(g.r.height * g.dpr); ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
  ctx.clearRect(0, 0, g.r.width, g.r.height);
  const col = { 255: "#d9d2c6" };
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const v = ple.cells[y * m.w + x]; if (!v) continue;
    ctx.fillStyle = col[v] || `hsl(${(v * 67) % 360},18%,${v === 255 ? 80 : 17}%)`;
    ctx.fillRect(g.ox + x * g.s, g.oy + y * g.s, g.s + 0.5, g.s + 0.5);
  }
  // подписи комнат
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "600 12px Inter, sans-serif";
  for (const r of m.rooms || []) { const n = (window.zhPlan.rooms || {})[r.id] || `Комната ${r.id}`; ctx.fillStyle = "rgba(255,255,255,.28)"; ctx.fillText(n, g.ox + r.cx * g.s, g.oy + r.cy * g.s); }
  if (m.charger) { ctx.fillStyle = "#3be08c"; ctx.beginPath(); ctx.arc(g.ox + m.charger[0] * g.s, g.oy + m.charger[1] * g.s, 4, 0, Math.PI * 2); ctx.fill(); }
  for (const it of window.zhPlan.items || []) {
    const ty = PL_TYPES[it.t] || {}, x = g.ox + it.x * g.s, y = g.oy + it.y * g.s, w = it.w * g.s, h = it.h * g.s, sel = it.id === ple.sel;
    ctx.globalAlpha = ty.dev === "light" ? 0.95 : 0.9;
    ctx.fillStyle = ty.c || "#666";
    ctx.beginPath(); if (ty.round) ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); else ctx.roundRect(x, y, w, h, Math.min(4, w / 3, h / 3)); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = sel ? "#ff5a1f" : "rgba(0,0,0,.55)"; ctx.lineWidth = sel ? 2 : 1; ctx.stroke();
    if (Math.min(w, h) > 12) { ctx.font = `${Math.min(18, Math.min(w, h) * 0.6)}px sans-serif`; ctx.fillStyle = "#111"; ctx.fillText(ty.i || "", x + w / 2, y + h / 2); }
    if (sel) { ctx.fillStyle = "#ff5a1f"; ctx.fillRect(x + w - 5, y + h - 5, 10, 10); }
  }
}
function plHit(px, py) {
  const g = plGeom(), x = (px - g.ox) / g.s, y = (py - g.oy) / g.s, items = window.zhPlan.items || [];
  const sel = items.find((i) => i.id === ple.sel);
  if (sel) { const hx = g.ox + (sel.x + sel.w) * g.s, hy = g.oy + (sel.y + sel.h) * g.s; if (Math.abs(px - hx) < 9 && Math.abs(py - hy) < 9) return { it: sel, resize: true, x, y }; }
  for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return { it, x, y }; }
  return { x, y };
}
function plDown(e) {
  const r = ple.cv.getBoundingClientRect(), hit = plHit(e.clientX - r.left, e.clientY - r.top);
  if (hit.it) { ple.sel = hit.it.id; ple.drag = { it: hit.it, resize: !!hit.resize, dx: hit.x - hit.it.x, dy: hit.y - hit.it.y }; e.preventDefault(); }
  else ple.sel = null;
  plProps(); plDraw();
}
function plMove(e) {
  if (!ple.drag || !ple.cv) return;
  const g = plGeom(), x = (e.clientX - g.r.left - g.ox) / g.s, y = (e.clientY - g.r.top - g.oy) / g.s, it = ple.drag.it;
  if (ple.drag.resize) { it.w = Math.max(2, Math.round(x - it.x)); it.h = Math.max(2, Math.round(y - it.y)); }
  else { it.x = Math.round(x - ple.drag.dx); it.y = Math.round(y - ple.drag.dy); }
  ple.dirty = true; $("#planMsg").textContent = "Есть несохранённые изменения"; plDraw(); plRefreshMaps();
}

const _goPlan = go;
go = function (p) { _goPlan(p); if (p === "plan") plEditorOpen(); };
