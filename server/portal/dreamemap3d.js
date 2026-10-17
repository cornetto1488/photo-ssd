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
    // для плана дома: одиночные «стены» внутри комнат — шум лидара (ножки, провода); заменяем полом соседней комнаты
    const cl = c.slice(), wc = [];
    for (let i = 0; i < walls.length; i += 2) {
      const x = walls[i], y = walls[i + 1]; let nw = 0; const cnt = {};
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { if (!ox && !oy) continue; const xx = x + ox, yy = y + oy; if (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) continue; const v = c[yy * m.w + xx]; if (v === 255) nw++; else if (v) cnt[v] = (cnt[v] || 0) + 1; }
      const best = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
      if (nw <= 1 && best) cl[y * m.w + x] = +best; else wc.push(x, y);
    }
    this.cellsClean = cl; this.wallsClean = wc;
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
    const pc = this._pal && this._pal[id];
    if (pc) { const v = parseInt(pc.floor.slice(1), 16), f = [1, 0.5, 1.4, 0.72][k] || 1, ch = (n) => Math.min(255, Math.round(((v >> n) & 255) * f)); return `rgb(${ch(16)},${ch(8)},${ch(0)})`; }
    if (id === 99) return k === 1 ? "#26262b" : "#3b3b42";
    const h = DM_HUES[(id - 1) % DM_HUES.length];
    return k === 1 ? `hsl(${h},30%,20%)` : k === 2 ? `hsl(${h},62%,60%)` : k === 3 ? `hsl(${h},18%,28%)` : `hsl(${h},36%,42%)`;
  }
  setPlan(pl) { this.plan = pl; this._dirty = true; }
  _planPal() {
    const pl = this.plan || window.zhPlan, rooms = (pl && pl.rooms) || {}, out = {};
    for (const r of (this.map && this.map.rooms) || []) out[r.id] = window.plRoomStyle ? window.plRoomStyle(rooms[r.id] || this.names[r.id] || "") : { floor: "#45474d", wall: "#8a8780" };
    return out;
  }
  _planOn() { const pl = this.plan || window.zhPlan; return this.opts.furniture !== false && !!(pl && Array.isArray(pl.items) && pl.items.length && window.plBuild); }
  // мебель и устройства из «Плана дома»: модели из деталей (plan.js → plBuild), тени, свет граней, порядок перекрытий
  _drawPlan(ctx, P, s, sinT, sn, cs, cx, cy, WH) {
    const pl = this.plan || window.zhPlan;
    const st = window.zhDevState || {}, cosT = Math.sqrt(Math.max(0, 1 - sinT * sinT)), side = cosT > 0.02;
    const prims = [], pre = [], post = [];
    for (const it of pl.items) { const r = window.plBuild(it, WH, st, this._wallCut); if (!r) continue; prims.push(...r.prims); pre.push(...r.pre); post.push(...r.post); }
    const col = (c, k, a) => `rgba(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0},${a ?? c[3]})`;
    const path = (pts) => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); };
    const thin = s < 1.6;
    // боковые грани — с мягким затемнением к полу (как фоновое затенение в рендерах интерьеров)
    const face = (pts, c, k, grad) => { path(pts); if (grad && c[3] > 0.9 && Math.abs(pts[0][1] - pts[3][1]) > 4) { const g = ctx.createLinearGradient(pts[0][0], pts[0][1], pts[3][0], pts[3][1]); g.addColorStop(0, col(c, k * 0.78)); g.addColorStop(1, col(c, k * 1.04)); ctx.fillStyle = g; } else ctx.fillStyle = col(c, k); ctx.fill(); if (!thin && c[3] > 0.9) { ctx.strokeStyle = col(c, k * 0.8); ctx.lineWidth = 0.6; ctx.stroke(); } };
    // освещённость боковой грани по её нормали в экранных координатах (свет слева сверху)
    const lit = (nx, ny) => 0.72 - 0.17 * ((nx * cs - ny * sn) / (Math.hypot(nx, ny) || 1));
    // 1) тени и свечение на полу
    for (const g of pre) {
      if (g.k === "shadow") { const q = [P(g.x0, g.y0, 0.05), P(g.x1, g.y0, 0.05), P(g.x1, g.y1, 0.05), P(g.x0, g.y1, 0.05)]; path(q); ctx.fillStyle = `rgba(0,0,0,${g.a})`; ctx.fill(); continue; }
      const c = P(g.x, g.y, 0.1), r = g.r * s; const gr = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], r);
      gr.addColorStop(0, g.c); gr.addColorStop(1, "rgba(0,0,0,0)");
      ctx.save(); ctx.translate(c[0], c[1]); ctx.scale(1, Math.max(0.05, sinT)); ctx.translate(-c[0], -c[1]);
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    // 2) порядок отрисовки: разделяющая плоскость между габаритами деталей, иначе — глубина центра
    const n = prims.length;
    for (const p of prims) {
      const xs = [p.x0, p.x1], ys = [p.y0, p.y1]; let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
      for (const x of xs) for (const y of ys) for (const z of [p.z0, p.z1]) { const q = P(x, y, z); if (q[0] < a) a = q[0]; if (q[0] > c) c = q[0]; if (q[1] < b) b = q[1]; if (q[1] > d) d = q[1]; }
      p.sb = [a, b, c, d]; p.d = ((p.x0 + p.x1) / 2 - cx) * sn + ((p.y0 + p.y1) / 2 - cy) * cs; p.in = 0; p.out = null;
    }
    const e = 0.01, behind = (a, b) => { // a дальше b?
      if (a.x1 <= b.x0 + e && sn > 0.03) return 1; if (b.x1 <= a.x0 + e && sn < -0.03) return 1;
      if (a.y1 <= b.y0 + e && cs > 0.03) return 1; if (b.y1 <= a.y0 + e && cs < -0.03) return 1;
      if (a.z1 <= b.z0 + e) return 1;
      if (a.x1 <= b.x0 + e || b.x1 <= a.x0 + e || a.y1 <= b.y0 + e || b.y1 <= a.y0 + e || b.z1 <= a.z0 + e) return -1;
      return 0;
    };
    for (let i = 0; i < n; i++) {
      const A = prims[i];
      for (let j = i + 1; j < n; j++) {
        const B = prims[j];
        if (A.sb[2] <= B.sb[0] || B.sb[2] <= A.sb[0] || A.sb[3] <= B.sb[1] || B.sb[3] <= A.sb[1]) continue;
        let ab = behind(A, B), ba = behind(B, A);
        if (ab === 1 && ba !== 1) (A.out ||= []).push(B), B.in++;
        else if (ba === 1 && ab !== 1) (B.out ||= []).push(A), A.in++;
      }
    }
    const order = [], left = prims.slice();
    while (left.length) {
      let bi = -1;
      for (let i = 0; i < left.length; i++) if (left[i].in === 0 && (bi < 0 || left[i].d < left[bi].d || (left[i].d === left[bi].d && left[i].z0 < left[bi].z0))) bi = i;
      if (bi < 0) { bi = 0; for (let i = 1; i < left.length; i++) if (left[i].in < left[bi].in || (left[i].in === left[bi].in && left[i].d < left[bi].d)) bi = i; } // цикл — разрываем
      const p = left.splice(bi, 1)[0]; order.push(p); if (p.out) for (const q of p.out) q.in--;
    }
    // 3) детали
    for (const p of order) {
      const c = p.c;
      if (p.k === "box") {
        const { x0, y0, x1, y1, z0, z1 } = p;
        if (side) for (const [nx, ny, a, b, key] of [[0, -1, [x1, y0], [x0, y0], "n"], [1, 0, [x1, y1], [x1, y0], "e"], [0, 1, [x0, y1], [x1, y1], "s"], [-1, 0, [x0, y0], [x0, y1], "w"]]) {
          if (nx * sn + ny * cs <= 0.001) continue;
          face([P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], z1), P(a[0], a[1], z1)], (p.f && p.f[key]) || c, lit(nx, ny), true);
        }
        face([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], (p.f && p.f.t) || c, p.tk || 1);
      } else if (p.k === "cyl") {
        const seg = p.seg || 18, ring = [];
        for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; ring.push([p.cx + Math.cos(a) * p.rx, p.cy + Math.sin(a) * p.ry]); }
        if (side && p.z1 - p.z0 > 0.05) for (let i = 0; i < seg; i++) {
          const a = ring[i], b = ring[(i + 1) % seg], nx = b[1] - a[1], ny = -(b[0] - a[0]);
          if (nx * sn + ny * cs <= 0) continue;
          const k = lit(nx, ny); path([P(a[0], a[1], p.z0), P(b[0], b[1], p.z0), P(b[0], b[1], p.z1), P(a[0], a[1], p.z1)]); ctx.fillStyle = col(c, k); ctx.fill(); ctx.strokeStyle = col(c, k); ctx.lineWidth = 0.6; ctx.stroke();
        }
        path(ring.map((q) => P(q[0], q[1], p.z1))); ctx.fillStyle = col((p.f && p.f.t) || c, p.tk || 1); ctx.fill();
        if (!thin && c[3] > 0.9) { ctx.strokeStyle = col(c, 0.8); ctx.lineWidth = 0.6; ctx.stroke(); }
      } else if (p.k === "poly") {
        path(p.pts.map((q) => P(q[0], q[1], q[2]))); ctx.fillStyle = col(c, p.tk || 1); ctx.fill();
        if (p.line) { ctx.strokeStyle = col(p.line, 1); ctx.lineWidth = 0.8; ctx.stroke(); }
      }
    }
    // 4) огни: лампы, светодиоды, экраны — поверх, с мягким ореолом
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (const g of post) {
      const q = P(g.x, g.y, g.z), r = Math.max(g.min || 2, g.r * s);
      const gr = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], r); gr.addColorStop(0, g.c); gr.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  draw(t) {
    const { ctx, W, H, dpr } = this; const m = this.map; if (!m) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const planOn = this._planOn();
    const w = this.w, h = this.h, cells = planOn ? this.cellsClean : this.cells, wallList = planOn ? this.wallsClean : this.walls;
    this._pal = planOn ? this._planPal() : null; const pal = this._pal;
    const cx = w / 2, cy = h / 2, R = Math.hypot(w, h) / 2;
    const sinT = this.tilt, cosT = Math.sqrt(1 - sinT * sinT), cs = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    const wallH = planOn ? Math.max(this.opts.wallH, 12) : this.opts.wallH;
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
    // стена между зрителем и комнатой (идём от клетки к зрителю по стенам — упёрлись в «снаружи»)
    const frontFn = (x, y) => {
      const vx = sn > 0.2 ? 1 : sn < -0.2 ? -1 : 0, vy = cs > 0.2 ? 1 : cs < -0.2 ? -1 : 0;
      const isWc = (a, b) => a >= 0 && b >= 0 && a < w && b < h && cells[b * w + a] === 255, isO = (a, b) => a < 0 || b < 0 || a >= w || b >= h || cells[b * w + a] === 0;
      for (const [dx, dy] of [[vx, 0], [0, vy], [vx, vy]]) {
        if (!dx && !dy) continue;
        for (let k = 1; k <= 6; k++) { const xx = x + dx * k, yy = y + dy * k; if (isO(xx, yy)) return true; if (!isWc(xx, yy)) break; }
      }
      return false;
    };
    // предмет на стене: срезана ли его стена
    this._wallCut = (x, y) => {
      for (let r = 0; r <= 3; r++) for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
        const xx = Math.floor(x) + ox, yy = Math.floor(y) + oy; if (xx < 0 || yy < 0 || xx >= w || yy >= h || cells[yy * w + xx] !== 255) continue;
        return frontFn(xx, yy);
      }
      return false;
    };
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
    if (pal) { // плитка/швы на полу
      for (const id in pal) {
        const t = pal[id].tile; if (!t) continue;
        c.beginPath();
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (cells[y * w + x] !== +id) continue;
          if (x % t === 0) { const a = P(x, y, 0.02), b = P(x, y + 1, 0.02); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
          if (y % t === 0) { const a = P(x, y, 0.02), b = P(x + 1, y, 0.02); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
        }
        c.strokeStyle = `rgba(0,0,0,${pal[id].tileA || 0.2})`; c.lineWidth = Math.max(0.6, s * 0.18); c.stroke();
      }
    }
      cc = ctx;
    };
    // «глянец»: лёгкая подсветка пола
    // слои пола и стен кэшируются, пока ракурс не меняется (в обоях карта статична — кадр дешёвый)
    let fl = null, wl = null;
    if (this.opts.cache) {
      const key = [W, H, dpr, this.yaw.toFixed(4), this.tilt.toFixed(3), this.zoom.toFixed(3), [...this.selected].join(","), this._mapId, wallH, planOn ? JSON.stringify((this.plan || window.zhPlan).rooms || {}) : ""].join("|");
      if (this._ck !== key) {
        const mk = () => { const c = document.createElement("canvas"); c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); const x = c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); return [c, x]; };
        const [fc, fx] = mk(), [wc, wx] = mk(), [xc, xx] = mk();
        paintBase(fx); paintWalls.call(this, wx); paintWalls.call(this, xx, true);
        this._fc = fc; this._wc = wc; this._xc = xc; this._ck = key;
      }
      fl = this._fc; wl = this._wc;
      ctx.drawImage(fl, 0, 0, W, H);
    } else paintBase(ctx);
    // маршрут
    if (m.paths.length && this.opts.paths !== false) {
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
    function paintWalls(c, outer) {
      cc = c;
    // стены: далёкие первыми
    const WH = wallH, isW = (x, y) => x >= 0 && y >= 0 && x < w && y < h && cells[y * w + x] === 255;
    const isOut = (x, y) => x < 0 || y < 0 || x >= w || y >= h || cells[y * w + x] === 0;
    const items = [];
    for (let i = 0; i < wallList.length; i += 2) { const x = wallList[i], y = wallList[i + 1]; const d = (x + 0.5 - cx) * sn + (y + 0.5 - cy) * cs; items.push([d, x, y]); }
    items.sort((a, b) => a[0] - b[0]);
    const faces = [[1, 0, 0.78], [-1, 0, 0.62], [0, 1, 0.9], [0, -1, 0.55]]; // нормаль и яркость
    // план дома — «кукольный домик»: стены между зрителем и комнатой срезаны низко, чтобы было видно мебель
    const front = frontFn;
    for (const [, x, y] of items) {
      const hh = pal && front(x, y) ? 2.2 : WH;
      // outer: только наружные грани, обращённые к зрителю, — рисуются поверх мебели (мебель за стеной не «просвечивает»)
      if (outer && !faces.some(([nx, ny]) => nx * sn + ny * cs > 0.0001 && isOut(x + nx, y + ny))) continue;
      for (const [nx, ny, br] of faces) {
        const rnY = nx * sn + ny * cs; if (rnY <= 0.0001) continue; // грань смотрит от зрителя
        if (isW(x + nx, y + ny)) continue;
        if (outer && !isOut(x + nx, y + ny)) continue;
        let a, b;
        if (nx === 1) { a = [x + 1, y]; b = [x + 1, y + 1]; } else if (nx === -1) { a = [x, y]; b = [x, y + 1]; }
        else if (ny === 1) { a = [x, y + 1]; b = [x + 1, y + 1]; } else { a = [x, y]; b = [x + 1, y]; }
        let fc;
        if (pal) { // стены как на фото: цвет комнаты с этой стороны, снаружи — светло-серая штукатурка
          const nv = cells[(y + ny) * w + (x + nx)], wc = (nv > 0 && nv < 255 && pal[nv]) ? pal[nv].wall : "#a29d96", v = parseInt(wc.slice(1), 16), k = 0.62 + br * 0.42;
          fc = `rgb(${Math.min(255, ((v >> 16) & 255) * k) | 0},${Math.min(255, ((v >> 8) & 255) * k) | 0},${Math.min(255, (v & 255) * k) | 0})`;
        } else { const l = Math.round(70 * br + 18); fc = `rgb(${l + 22},${l + 14},${l + 6})`; }
        poly([P(a[0], a[1], 0), P(b[0], b[1], 0), P(b[0], b[1], hh), P(a[0], a[1], hh)], fc, fc);
      }
      poly([P(x, y, hh), P(x + 1, y, hh), P(x + 1, y + 1, hh), P(x, y + 1, hh)], pal ? "#d8d4ce" : "#efe7dc", pal ? "#d8d4ce" : "#efe7dc");
    }
    if (m.charger && !outer) {
      const [x, y] = m.charger; const bw = 3.2;
      poly([P(x - bw, y - bw, 0), P(x + bw, y - bw, 0), P(x + bw, y + bw, 0), P(x - bw, y + bw, 0)], "rgba(59,224,140,.35)", "rgba(59,224,140,.9)");
      const q = P(x, y, 7); c.fillStyle = "#3be08c"; c.font = `700 ${Math.max(11, s * 3)}px sans-serif`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("⚡", q[0], q[1]);
    }
      cc = ctx;
    }
    if (wl) ctx.drawImage(wl, 0, 0, W, H); else paintWalls.call(this, ctx);
    if (planOn) {
      this._drawPlan(ctx, P, s, sinT, sn, cs, cx, cy, wallH);
      if (this._xc && wl) ctx.drawImage(this._xc, 0, 0, W, H); else paintWalls.call(this, ctx, true);
    }
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
    if (this.onDraw) this.onDraw();
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
