"use strict";
// ZALET HOME — 3D-карта уборки Dreame: изометрия на canvas, стены, комнаты, маршрут, вращение мышкой/пальцем.

const DM_HUES = [18, 205, 150, 285, 345, 45, 175, 235, 100, 320];

class DreameMap3D {
  constructor(canvas, opts = {}) {
    this.cv = canvas; this.ctx = canvas.getContext("2d");
    this.opts = Object.assign({ autoRotate: true, interactive: true, labels: true, wallH: 9 }, opts);
    this.yaw = -0.55; this.tilt = 0.62; this.zoom = 1;
    this.progress = 1; this.anim = 0; this.names = {};
    this.map = null; this.running = false; this.lastTouch = 0; this.vis = true;
    this.dragging = null; this.selected = new Set(); this.onSelect = null;
    if (this.opts.interactive) this._bind();
    this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(canvas);
    this._io = new IntersectionObserver((e) => { this.vis = e[0].isIntersecting; if (this.vis) this.start(); }, { threshold: 0.05 }); this._io.observe(canvas);
    this.resize();
    (window.zhMaps ||= []).push(this);
  }
  setNames(n) { this.names = n || {}; this._dirty = true; }
  setData(m) {
    this.map = m; this._mapId = (this._mapId || 0) + 1; this._ck = null;
    const bin = atob(m.cells), n = bin.length, c = new Uint8Array(n);
    for (let i = 0; i < n; i++) c[i] = bin.charCodeAt(i);
    this.cells = c; this.w = m.w; this.h = m.h;
    // стены с видимыми гранями, считаем один раз
    const walls = [];
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (c[y * m.w + x] === 255) walls.push(x, y);
    this.walls = walls;
    this.totalPts = m.paths.reduce((a, p) => a + p.p.length / 2, 0);
    this.replay();
  }
  replay() { this.progress = 0; this.anim = performance.now(); this._done = false; this._dirty = true; this.start(); }
  resize() {
    const r = this.cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = Math.max(50, r.width); this.H = Math.max(50, r.height); this.dpr = dpr;
    this.cv.width = Math.round(this.W * dpr); this.cv.height = Math.round(this.H * dpr);
    this._dirty = true;
  }
  _bind() {
    const cv = this.cv; cv.style.touchAction = "pan-y"; cv.style.cursor = "grab";
    cv.addEventListener("pointerdown", (e) => { this.dragging = { x: e.clientX, y: e.clientY, yaw: this.yaw, tilt: this.tilt, moved: false }; cv.setPointerCapture(e.pointerId); cv.style.cursor = "grabbing"; });
    cv.addEventListener("pointermove", (e) => {
      const d = this.dragging; if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { d.moved = true; cv.style.touchAction = "none"; }
      this.yaw = d.yaw + dx * 0.008; this.tilt = Math.max(0.3, Math.min(0.95, d.tilt - dy * 0.004));
      this.lastTouch = performance.now(); this._dirty = true;
    });
    const up = () => { this.dragging = null; cv.style.cursor = "grab"; cv.style.touchAction = "pan-y"; };
    cv.addEventListener("pointerup", (e) => { const d = this.dragging; up(); if (d && !d.moved && this.opts.selectable) this._pick(e); });
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", (e) => { e.preventDefault(); this.zoom = Math.max(0.6, Math.min(2.2, this.zoom * (e.deltaY < 0 ? 1.1 : 0.91))); this.lastTouch = performance.now(); this._dirty = true; }, { passive: false });
  }
  // тап по комнате: обратная проекция точки экрана на пол
  _pick(e) {
    const P = this._proj; if (!P || !this.cells) return;
    const r = this.cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const rx = (sx - P.OX) / P.s, ry = (sy - P.OY) / (P.s * P.sinT);
    const dx = rx * P.cs + ry * P.sn, dy = -rx * P.sn + ry * P.cs;
    const x = Math.floor(dx + P.cx), y = Math.floor(dy + P.cy);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    let id = this.cells[y * this.w + x];
    if (id === 255 || id === 0 || id === 99) { // стена/край: ищем ближайшую комнату рядом
      id = 0;
      for (let rad = 1; rad <= 3 && !id; rad++) for (let oy = -rad; oy <= rad && !id; oy++) for (let ox = -rad; ox <= rad; ox++) {
        const xx = x + ox, yy = y + oy; if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        const v = this.cells[yy * this.w + xx]; if (v > 0 && v < 99) { id = v; break; }
      }
    }
    if (!id || id >= 99) return;
    this.toggle(id);
  }
  toggle(id) {
    if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
    this._dirty = true; this.lastTouch = performance.now();
    if (this.onSelect) this.onSelect([...this.selected].sort((a, b) => a - b));
  }
  clearSelection() { this.selected.clear(); this._dirty = true; if (this.onSelect) this.onSelect([]); }
  start() {
    if (this.running || !this.map) return;
    this.running = true;
    const loop = (t) => {
      if (!this.cv.isConnected) { this.running = false; return; }
      if (!this.vis || document.hidden) { this.running = false; return; }
      const idle = t - this.lastTouch > 3500;
      if (this.opts.autoRotate && idle && !this.dragging && !this.selected.size) { this.yaw += 0.0022; this._dirty = true; }
      if (this.progress < 1) { this.progress = Math.min(1, (t - this.anim) / (this.opts.replayMs || 5000)); this._dirty = true; }
      if (this.progress >= 1 && !this._done) { this._done = true; if (this.onReplayDone) this.onReplayDone(); }
      this._pulse = (t % 1600) / 1600;
      if ((this._dirty || this.opts.autoRotate || this.progress < 1) && t - (this._last || 0) > (document.documentElement.classList.contains("wp") ? 55 : 28)) { this._dirty = false; this._last = t; this.draw(t); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop() { this.running = false; }
  destroy() { this.running = false; this._ro.disconnect(); this._io.disconnect(); }

  color(id, k) { // k: 0 верх, 1 плита снизу, 2 светлее
    if (id === 99) return k === 1 ? "#26262b" : "#3b3b42";
    const h = DM_HUES[(id - 1) % DM_HUES.length];
    return k === 1 ? `hsl(${h},30%,20%)` : k === 2 ? `hsl(${h},62%,60%)` : k === 3 ? `hsl(${h},18%,28%)` : `hsl(${h},36%,42%)`;
  }
  setPlan(pl) { this.plan = pl; this._dirty = true; }
  // мебель и устройства из «Плана дома»: объёмные блоки поверх пола, свет — тёплое свечение, если горит
  _drawPlan(ctx, P, s, sinT, sn, cs, cx, cy) {
    const pl = this.plan || window.zhPlan; if (!pl || !Array.isArray(pl.items) || !pl.items.length) return;
    const types = window.PL_TYPES || {}, st = window.zhDevState || {};
    const rgb = (hex) => { const v = parseInt(String(hex || "#555").slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
    const shade = (c, k) => `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;
    const items = pl.items.map((it) => ({ it, ty: types[it.t] || {}, d: (it.x + it.w / 2 - cx) * sn + (it.y + it.h / 2 - cy) * cs })).sort((a, b) => a.d - b.d);
    const ring = (it, n) => { const pts = [], rx = it.w / 2, ry = it.h / 2, ox = it.x + rx, oy = it.y + ry; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push([ox + Math.cos(a) * rx, oy + Math.sin(a) * ry]); } return pts; };
    const fillPoly = (pts, fill, stroke) => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.8; ctx.stroke(); } };
    for (const { it, ty } of items) {
      const col = rgb(it.c || ty.c);
      if (ty.dev === "light") { // свет: свечение на полу, если в комнате горит
        const on = st.rooms && (st.rooms[it.room] || (window.plCanon && st.rooms[window.plCanon(it.room)]));
        const c = P(it.x + it.w / 2, it.y + it.h / 2, 0), r = s * 22;
        if (on) { const g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], r); g.addColorStop(0, "rgba(255,190,110,.55)"); g.addColorStop(1, "rgba(255,150,60,0)"); ctx.save(); ctx.scale(1, 1); ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(c[0], c[1], r, r * sinT, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
        const b = P(it.x + it.w / 2, it.y + it.h / 2, 12);
        ctx.beginPath(); ctx.arc(b[0], b[1], Math.max(3, s * 1.4), 0, Math.PI * 2); ctx.fillStyle = on ? "#ffcf8a" : "#55555f"; ctx.fill();
        if (on) { ctx.strokeStyle = "rgba(255,200,130,.6)"; ctx.lineWidth = 2; ctx.stroke(); }
        continue;
      }
      if (ty.flat) { const z = 5; fillPoly([P(it.x, it.y, z), P(it.x + it.w, it.y, z), P(it.x + it.w, it.y + it.h, z), P(it.x, it.y + it.h, z)], "rgba(127,199,255,.55)", "rgba(170,220,255,.9)"); continue; }
      const z0 = ty.lift || 0, z1 = z0 + (ty.z || 3);
      const base = ty.round ? ring(it, 12) : [[it.x, it.y], [it.x + it.w, it.y], [it.x + it.w, it.y + it.h], [it.x, it.y + it.h]];
      // боковые грани, обращённые к зрителю
      for (let i = 0; i < base.length; i++) {
        const a = base[i], b = base[(i + 1) % base.length];
        const ex = b[0] - a[0], ey = b[1] - a[1], nx = ey, ny = -ex; // внешняя нормаль (обход по часовой)
        if (nx * sn + ny * cs <= 0.0001) continue;
        const br = 0.55 + 0.25 * Math.abs(nx * cs - ny * sn) / (Math.hypot(nx, ny) || 1);
        fillPoly([P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], z1), P(a[0], a[1], z1)], shade(col, br), shade(col, br * 0.9));
      }
      let top = shade(col, 1);
      let edge = shade(col, 1.12);
      const active = (ty.dev === "ac" && st.ac) || (ty.dev === "pc" && st.pc) || (ty.dev === "router");
      if (active) edge = ty.dev === "router" ? "#3be08c" : "#ff8a4c";
      fillPoly(base.map((q) => P(q[0], q[1], z1)), top, edge);
      if (active && ty.dev !== "router") { const c = P(it.x + it.w / 2, it.y + it.h / 2, z1 + 0.5); ctx.beginPath(); ctx.arc(c[0], c[1], Math.max(2.5, s * 1.1), 0, Math.PI * 2); ctx.fillStyle = "#ff5a1f"; ctx.fill(); }
    }
  }
  draw(t) {
    const { ctx, W, H, dpr } = this; const m = this.map; if (!m) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const w = this.w, h = this.h, cells = this.cells;
    const cx = w / 2, cy = h / 2, R = Math.hypot(w, h) / 2;
    const sinT = this.tilt, cosT = Math.sqrt(1 - sinT * sinT), cs = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    const wallH = this.opts.wallH;
    // масштаб и центр — по реальным границам карты в текущем ракурсе
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const [px, py] of [[0, 0], [w, 0], [w, h], [0, h]]) {
      const dx = px - cx, dy = py - cy, rx = dx * cs - dy * sn, ry = dx * sn + dy * cs;
      for (const z of [-5, wallH]) { const X = rx, Y = ry * sinT - z * cosT; if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; }
    }
    const s = Math.min((W * 0.92) / (x1 - x0), (H * 0.9) / (y1 - y0)) * this.zoom;
    const OX = W / 2 - ((x0 + x1) / 2) * s, OY = H / 2 - ((y0 + y1) / 2) * s;
    this._proj = { OX, OY, s, sinT, cs, sn, cx, cy };
    const hasSel = this.selected.size > 0;
    const P = (x, y, z) => { const dx = x - cx, dy = y - cy; const rx = dx * cs - dy * sn, ry = dx * sn + dy * cs; return [OX + rx * s, OY + ry * s * sinT - z * s * cosT]; };
    let cc = ctx;
    const poly = (pts, fill, stroke) => { cc.beginPath(); cc.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) cc.lineTo(pts[i][0], pts[i][1]); cc.closePath(); cc.fillStyle = fill; cc.fill(); if (stroke) { cc.strokeStyle = stroke; cc.lineWidth = 0.7; cc.stroke(); } };

    const paintBase = (c) => {
      cc = c;
    // мягкая тень под картой
    const g = c.createRadialGradient(OX, OY + 8, 10, OX, OY + 8, R * s);
    g.addColorStop(0, "rgba(0,0,0,.45)"); g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g; c.fillRect(0, 0, W, H);

    // пол: сначала плита (толщина), затем верх
    const slab = 5;
    for (const pass of [0, 1]) {
      const z = pass === 0 ? -slab : 0;
      for (let y = 0; y < h; y++) {
        let x = 0;
        while (x < w) {
          const c = cells[y * w + x];
          if (c === 0 || c === 255 && pass === 1) { x++; continue; }
          let x2 = x + 1; while (x2 < w && cells[y * w + x2] === c) x2++;
          const id = c === 255 ? 99 : c;
          const sel = this.selected.has(id), kk = sel ? 2 : hasSel && id !== 99 ? 3 : 0;
          poly([P(x, y, z), P(x2, y, z), P(x2, y + 1, z), P(x, y + 1, z)], this.color(id, pass === 0 ? 1 : kk), pass === 0 ? null : (sel ? "#ffb27a" : this.color(id, kk)));
          x = x2;
        }
      }
    }
      cc = ctx;
    };
    // «глянец»: лёгкая подсветка пола
    // слои пола и стен кэшируются, пока ракурс не меняется (в обоях карта статична — кадр дешёвый)
    let fl = null, wl = null;
    if (this.opts.cache) {
      const key = [W, H, dpr, this.yaw.toFixed(4), this.tilt.toFixed(3), this.zoom.toFixed(3), [...this.selected].join(","), this._mapId].join("|");
      if (this._ck !== key) {
        const mk = () => { const c = document.createElement("canvas"); c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); const x = c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); return [c, x]; };
        const [fc, fx] = mk(), [wc, wx] = mk();
        paintBase(fx); paintWalls.call(this, wx);
        this._fc = fc; this._wc = wc; this._ck = key;
      }
      fl = this._fc; wl = this._wc;
      ctx.drawImage(fl, 0, 0, W, H);
    } else paintBase(ctx);
    // маршрут
    if (m.paths.length) {
      const total = this.totalPts, upTo = Math.floor(total * this.progress); let used = 0;
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      for (const pass of [0, 1]) {
        used = 0;
        for (const p of m.paths) {
          const n = p.p.length / 2; if (used >= upTo) break;
          const take = Math.min(n, upTo - used); used += n;
          ctx.beginPath();
          for (let i = 0; i < take; i++) { const q = P(p.p[2 * i], p.p[2 * i + 1], 0.4); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }
          const mop = p.t === "W";
          ctx.strokeStyle = pass === 0 ? (mop ? "rgba(95,180,255,.28)" : "rgba(255,138,76,.30)") : (mop ? "rgba(150,210,255,.95)" : "rgba(255,200,150,.95)");
          ctx.lineWidth = pass === 0 ? Math.max(4, s * 1.6) : Math.max(1.2, s * 0.35);
          ctx.stroke();
        }
      }
    }
    function paintWalls(c) {
      cc = c;
    // стены: далёкие первыми
    const WH = wallH, isW = (x, y) => x >= 0 && y >= 0 && x < w && y < h && cells[y * w + x] === 255;
    const items = [];
    for (let i = 0; i < this.walls.length; i += 2) { const x = this.walls[i], y = this.walls[i + 1]; const d = (x + 0.5 - cx) * sn + (y + 0.5 - cy) * cs; items.push([d, x, y]); }
    items.sort((a, b) => a[0] - b[0]);
    const faces = [[1, 0, 0.78], [-1, 0, 0.62], [0, 1, 0.9], [0, -1, 0.55]]; // нормаль и яркость
    for (const [, x, y] of items) {
      for (const [nx, ny, br] of faces) {
        const rnY = nx * sn + ny * cs; if (rnY <= 0.0001) continue; // грань смотрит от зрителя
        if (isW(x + nx, y + ny)) continue;
        let a, b;
        if (nx === 1) { a = [x + 1, y]; b = [x + 1, y + 1]; } else if (nx === -1) { a = [x, y]; b = [x, y + 1]; }
        else if (ny === 1) { a = [x, y + 1]; b = [x + 1, y + 1]; } else { a = [x, y]; b = [x + 1, y]; }
        const l = Math.round(70 * br + 18);
        poly([P(a[0], a[1], 0), P(b[0], b[1], 0), P(b[0], b[1], WH), P(a[0], a[1], WH)], `rgb(${l + 22},${l + 14},${l + 6})`, `rgb(${l + 22},${l + 14},${l + 6})`);
      }
      poly([P(x, y, WH), P(x + 1, y, WH), P(x + 1, y + 1, WH), P(x, y + 1, WH)], "#efe7dc", "#efe7dc");
    }
    if (m.charger) {
      const [x, y] = m.charger; const bw = 3.2;
      poly([P(x - bw, y - bw, 0), P(x + bw, y - bw, 0), P(x + bw, y + bw, 0), P(x - bw, y + bw, 0)], "rgba(59,224,140,.35)", "rgba(59,224,140,.9)");
      const q = P(x, y, 7); c.fillStyle = "#3be08c"; c.font = `700 ${Math.max(11, s * 3)}px sans-serif`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("⚡", q[0], q[1]);
    }
      cc = ctx;
    }
    if (wl) ctx.drawImage(wl, 0, 0, W, H); else paintWalls.call(this, ctx);
    if (this.opts.furniture !== false) this._drawPlan(ctx, P, s, sinT, sn, cs, cx, cy);
    // пылесос в конце маршрута
    const last = m.paths.length ? m.paths[m.paths.length - 1] : null;
    let rb = m.robot;
    if (last && last.p.length >= 2 && this.progress < 1) {
      const total = this.totalPts, upTo = Math.max(1, Math.floor(total * this.progress)); let used = 0;
      for (const p of m.paths) { const n = p.p.length / 2; if (used + n >= upTo) { const k = Math.max(0, upTo - used - 1); rb = [p.p[2 * k], p.p[2 * k + 1]]; break; } used += n; }
    }
    if (rb) {
      const base = P(rb[0], rb[1], 0), top = P(rb[0], rb[1], 3.5), rr = Math.max(5, s * 2.6);
      ctx.beginPath(); ctx.ellipse(base[0], base[1], rr * 1.5 * (1 + (this._pulse || 0) * 0.8), rr * 1.5 * sinT * (1 + (this._pulse || 0) * 0.8), 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,90,31,${0.55 * (1 - (this._pulse || 0))})`; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(top[0], top[1], rr, rr * sinT, 0, 0, Math.PI * 2); ctx.fillStyle = "#ff5a1f"; ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4; ctx.stroke();
    }
    // подписи комнат
    if (this.opts.labels) {
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (const r of m.rooms) {
        const pr = (this.plan || window.zhPlan || {}).rooms || {};
        const name = pr[r.id] || this.names[r.id] || `Комната ${r.id}`, q = P(r.cx, r.cy, 1.5);
        const fs = Math.max(11, Math.min(15, s * 4.2)); ctx.font = `600 ${fs}px Inter, sans-serif`;
        const label = `${name} · ${r.area} м²`, tw = ctx.measureText(label).width;
        const isSel = this.selected.has(r.id);
        ctx.fillStyle = isSel ? "rgba(255,90,31,.92)" : "rgba(8,8,10,.62)"; ctx.beginPath(); ctx.roundRect(q[0] - tw / 2 - 8, q[1] - fs * 0.85, tw + 16, fs * 1.7, fs * 0.85); ctx.fill();
        ctx.fillStyle = "#f2f0ed"; ctx.fillText(label, q[0], q[1]);
      }
    }
  }
}

// ---- загрузка карты последней уборки ----
const dmCache = { map: null, names: null, at: 0 };
async function dmLoad(force) {
  if (!force && dmCache.map && Date.now() - dmCache.at < 60000) return dmCache;
  const [map, names] = await Promise.all([api("/api/home/dreame/map?i=0"), api("/api/home/dreame/rooms").catch(() => ({}))]);
  dmCache.map = map; dmCache.names = names || {}; dmCache.at = Date.now();
  return dmCache;
}
