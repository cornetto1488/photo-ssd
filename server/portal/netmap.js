"use strict";
// ZALET HOME — интерактивная карта домашней сети: роутер в центре, устройства на орбитах.
// Устройства можно перетаскивать (раскладка запоминается), нажать — карточка с действиями, легенда — фильтр.

const netViz = (() => {
  const box = $("#netviz"), cv = $("#netCanvas"), ctx = cv.getContext("2d");
  const pop = document.createElement("div"); pop.className = "nv-pop hidden"; box.appendChild(pop);
  const tip = document.createElement("div"); tip.className = "nv-tip hidden"; box.appendChild(tip);
  let nodes = [], packets = [], W = 0, H = 0, dpr = 1, raf = 0, t0 = performance.now();
  let hover = null, drag = null, selected = null, hidden = {};
  const COL = { pc: [255, 122, 47], dev: [255, 196, 92], cl: [134, 160, 255], phone: [92, 214, 255], tv: [190, 120, 255] };
  const saved = (() => { try { return JSON.parse(localStorage.getItem("zh-netpos") || "{}"); } catch (e) { return {}; } })();
  const savePos = () => { try { localStorage.setItem("zh-netpos", JSON.stringify(saved)); } catch (e) {} };
  try { hidden = JSON.parse(localStorage.getItem("zh-nethide") || "{}"); } catch (e) {}

  // ---------- данные ----------
  function iconFor(c) {
    const n = ((c.name || "") + " " + (c.vendor || "")).toLowerCase();
    if (/iphone|android|galaxy|redmi|pixel|phone|телефон|honor|xiaomi 1|poco/.test(n)) return ["📱", "phone"];
    if (/ipad|tab|планшет/.test(n)) return ["📱", "phone"];
    if (/tv|телевиз|bravia|webos|tizen|chromecast|яндекс.станц|станция|alice|smart-tv|android-tv/.test(n)) return ["📺", "tv"];
    if (/macbook|laptop|ноут|notebook|thinkpad|desktop|pc|компьют|win/.test(n)) return ["💻", "cl"];
    if (/watch|часы/.test(n)) return ["⌚", "phone"];
    if (/playstation|ps5|xbox|switch|nintendo/.test(n)) return ["🎮", "tv"];
    if (/printer|принтер|hp |epson|canon/.test(n)) return ["🖨", "cl"];
    if (/speaker|колонк|sonos|homepod/.test(n)) return ["🔊", "tv"];
    if (/tuya|esp|smart|умн/.test(n)) return ["◆", "dev"];
    return ["•", "cl"];
  }
  function update() {
    const list = [];
    if (status) list.push({ id: "pc", label: "Компьютер", sub: status.pc.ip, type: "pc", ico: "💻", on: status.pc.online, ring: 0.36, kind: "pc" });
    devices.filter((d) => d.kind !== "pc" && d.kind !== "gateway").forEach((d) => {
      const on = d.online && !!(d.kind === "light" ? val(d, "switch_led") : val(d, "switch_1"));
      list.push({ id: d.id, label: d.name.replace("Лампочка", "Лампа").replace("Выключатель ", ""), sub: d.room || "", type: "dev", ico: d.kind === "light" ? "💡" : "⏻", on, online: d.online, ring: 0.56, kind: "dev", dev: d });
    });
    clients.filter((c) => c.ip !== status?.pc.ip).sort((a, b) => b.online - a.online).slice(0, window.innerWidth < 600 ? 16 : 28).forEach((c) => {
      if (devices.some((d) => d.name && c.name === d.name)) return; // умный дом уже показан
      const [ico, type] = iconFor(c);
      list.push({ id: c.mac, label: (c.name || c.ip.split(".").pop()).slice(0, 16), sub: c.ip, type, ico, on: c.online, ring: 0.8, kind: "cl", cl: c });
    });
    const old = Object.fromEntries(nodes.map((n) => [n.id, n]));
    nodes = list.map((n) => ({ ...n, phase: old[n.id]?.phase ?? Math.random() * 6.28, x: old[n.id]?.x, y: old[n.id]?.y, scale: old[n.id]?.scale ?? 0 }));
    $("#nvCount").textContent = `${nodes.filter((n) => n.on).length} АКТИВНО · ${nodes.length} ВСЕГО`;
    layout(); renderLegend();
    if (selected) { const s = nodes.find((n) => n.id === selected.id); if (s) { selected = s; showPop(s); } }
  }
  function layout() {
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2;
    const rings = {};
    nodes.forEach((n) => (rings[n.ring] ||= []).push(n));
    Object.entries(rings).forEach(([ring, arr]) => {
      arr.forEach((n, i) => {
        const a = (i / arr.length) * Math.PI * 2 - Math.PI / 2 + Number(ring) * 2.1;
        n.ax = cx + Math.cos(a) * R * ring * (W > H ? 1.18 : 1); n.ay = cy + Math.sin(a) * R * ring * 0.92;
        const s = saved[n.id];
        if (s) { n.ax = s[0] * W; n.ay = s[1] * H; }
        if (n.x === undefined) { n.x = cx; n.y = cy; }
      });
    });
  }
  function resize() {
    const r = box.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); layout();
  }
  const visible = (n) => !hidden[n.kind];

  // ---------- рисование ----------
  function curve(n, cx, cy) { // точка изгиба линии — чуть в сторону, чтобы линии были плавными
    const mx = (cx + n.x) / 2, my = (cy + n.y) / 2, dx = n.x - cx, dy = n.y - cy;
    return [mx - dy * 0.12, my + dx * 0.12];
  }
  function bez(p0, p1, p2, t) { const u = 1 - t; return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]; }
  function draw(now) {
    const t = (now - t0) / 1000, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2;
    ctx.clearRect(0, 0, W, H);
    // фон: мягкое свечение и точки сетки
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.3); bg.addColorStop(0, "rgba(255,110,40,.10)"); bg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(242,240,237,.05)";
    for (let x = 12; x < W; x += 24) for (let y = 12; y < H; y += 24) ctx.fillRect(x, y, 1, 1);
    // орбиты
    [0.36, 0.56, 0.8].forEach((k, i) => {
      ctx.save(); ctx.translate(cx, cy);
      ctx.beginPath(); ctx.ellipse(0, 0, R * k * (W > H ? 1.18 : 1), R * k * 0.92, 0, 0, Math.PI * 2);
      ctx.setLineDash([2, 8]); ctx.lineDashOffset = -t * (6 + i * 3) * (i % 2 ? -1 : 1);
      ctx.strokeStyle = `rgba(242,240,237,${0.09 - i * 0.02})`; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
    });
    // радар
    const sweep = (t * 0.55) % (Math.PI * 2);
    if (ctx.createConicGradient) {
      const g = ctx.createConicGradient(sweep, cx, cy);
      g.addColorStop(0, "rgba(255,110,40,.20)"); g.addColorStop(0.07, "rgba(255,110,40,.04)"); g.addColorStop(0.12, "rgba(255,110,40,0)"); g.addColorStop(1, "rgba(255,110,40,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, Math.max(W, H), 0, Math.PI * 2); ctx.fill();
    }
    // узлы: плавно к своему месту (или под пальцем)
    nodes.forEach((n) => {
      if (!visible(n)) return;
      if (drag && drag.node === n) { n.x += (drag.x - n.x) * 0.5; n.y += (drag.y - n.y) * 0.5; }
      else { const tx = n.ax + Math.sin(t * 0.6 + n.phase) * 3, ty = n.ay + Math.cos(t * 0.5 + n.phase) * 3; n.x += (tx - n.x) * 0.08; n.y += (ty - n.y) * 0.08; }
      const target = (hover === n || selected === n) ? 1.25 : 1; n.scale += (target - n.scale) * 0.15;
    });
    // связи
    nodes.forEach((n) => {
      if (!visible(n)) return;
      const c = COL[n.type], hl = hover === n || selected === n, cp = curve(n, cx, cy);
      const g = ctx.createLinearGradient(cx, cy, n.x, n.y);
      g.addColorStop(0, `rgba(255,138,76,${n.on ? 0.35 : 0.08})`); g.addColorStop(1, `rgba(${c},${n.on ? (hl ? 0.9 : 0.45) : 0.12})`);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(cp[0], cp[1], n.x, n.y);
      ctx.strokeStyle = g; ctx.lineWidth = hl ? 2.2 : n.type === "pc" ? 1.6 : 1; ctx.setLineDash(n.on ? [] : [3, 6]); ctx.stroke(); ctx.setLineDash([]);
      if (n.on && Math.random() < (n.type === "pc" ? 0.06 : 0.022)) packets.push({ n, p: 0, out: Math.random() < 0.5, sp: 0.35 + Math.random() * 0.5 });
    });
    // пакеты с хвостиком
    packets = packets.filter((pk) => (pk.p += pk.sp * 0.016) < 1 && visible(pk.n));
    packets.forEach((pk) => {
      const n = pk.n, c = COL[n.type], cp = curve(n, cx, cy);
      for (let k = 0; k < 5; k++) {
        const f = Math.max(0, pk.p - k * 0.025), tt = pk.out ? f : 1 - f, [x, y] = bez([cx, cy], cp, [n.x, n.y], tt);
        ctx.beginPath(); ctx.arc(x, y, 2.4 - k * 0.4, 0, Math.PI * 2); ctx.fillStyle = `rgba(${c},${0.9 - k * 0.18})`; ctx.fill();
      }
    });
    // узлы
    nodes.forEach((n) => {
      if (!visible(n)) return;
      const c = COL[n.type], r = (n.type === "pc" ? 17 : n.kind === "dev" ? 14 : 12) * n.scale;
      if (n.on) {
        const halo = ctx.createRadialGradient(n.x, n.y, r * 0.6, n.x, n.y, r * 2.4 + Math.sin(t * 2 + n.phase) * 2);
        halo.addColorStop(0, `rgba(${c},.35)`); halo.addColorStop(1, `rgba(${c},0)`);
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(n.x, n.y, r * 2.6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n.on ? `rgba(${c.map((v) => Math.round(v * 0.22))},.95)` : "rgba(28,28,34,.95)"; ctx.fill();
      ctx.lineWidth = selected === n ? 2.4 : 1.4; ctx.strokeStyle = n.on ? `rgba(${c},.95)` : "rgba(110,110,120,.6)"; ctx.stroke();
      ctx.font = `${Math.round(r * 1.05)}px "Segoe UI Emoji","Apple Color Emoji",sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.globalAlpha = n.on ? 1 : 0.45; ctx.fillStyle = "#fff"; ctx.fillText(n.ico, n.x, n.y + 1); ctx.globalAlpha = 1;
      // подпись в «таблетке»
      ctx.font = "600 10.5px Inter, sans-serif"; ctx.textBaseline = "alphabetic";
      const lw = ctx.measureText(n.label).width + 12, ly = n.y + r + 15;
      ctx.fillStyle = hover === n || selected === n ? "rgba(255,138,76,.95)" : "rgba(10,10,14,.72)";
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(n.x - lw / 2, ly - 11, lw, 16, 8) : ctx.rect(n.x - lw / 2, ly - 11, lw, 16); ctx.fill();
      ctx.fillStyle = hover === n || selected === n ? "#08080a" : n.on ? "rgba(242,240,237,.92)" : "rgba(150,150,160,.75)"; ctx.fillText(n.label, n.x, ly + 1);
    });
    // роутер
    const pulse = 1 + Math.sin(t * 2.2) * 0.05;
    for (let k = 0; k < 3; k++) { const rr = ((t * 30 + k * 25) % 75) + 20; ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.strokeStyle = `rgba(255,120,50,${0.3 * (1 - (rr - 20) / 75)})`; ctx.lineWidth = 1.2; ctx.stroke(); }
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 52 * pulse); g.addColorStop(0, "rgba(255,138,76,.6)"); g.addColorStop(1, "rgba(255,90,31,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 52 * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(cx, cy);
    ctx.beginPath(); for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; ctx.lineTo(Math.cos(a) * 22, Math.sin(a) * 22); } ctx.closePath();
    const lg = ctx.createLinearGradient(-20, -20, 20, 20); lg.addColorStop(0, "#ff9a5c"); lg.addColorStop(1, "#ff5a1f"); ctx.fillStyle = lg; ctx.fill();
    ctx.strokeStyle = "#08080a"; ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(-9, 1); ctx.lineTo(0, -7); ctx.lineTo(9, 1); ctx.moveTo(-6.5, -1); ctx.lineTo(-6.5, 8); ctx.lineTo(6.5, 8); ctx.lineTo(6.5, -1); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "rgba(242,240,237,.92)"; ctx.font = "800 11px Onest, sans-serif"; ctx.textAlign = "center"; ctx.fillText("РОУТЕР", cx, cy + 38);
    if (typeof traffic !== "undefined" && traffic.pts.length) { const p = traffic.pts[traffic.pts.length - 1]; ctx.font = "500 9.5px 'JetBrains Mono', monospace"; ctx.fillStyle = "rgba(242,240,237,.55)"; ctx.fillText(`↓ ${fmtRate(p[0])}`, cx, cy + 51); }
    raf = requestAnimationFrame(draw);
  }

  // ---------- мышь и пальцы ----------
  const at = (e) => { const r = box.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const pick = (x, y) => { let best = null, bd = 26; nodes.forEach((n) => { if (!visible(n)) return; const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; best = n; } }); return best; };
  cv.addEventListener("pointerdown", (e) => {
    const [x, y] = at(e), n = pick(x, y);
    if (n) { drag = { node: n, x, y, sx: x, sy: y, moved: false }; cv.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  cv.addEventListener("pointermove", (e) => {
    const [x, y] = at(e);
    if (drag) { drag.x = x; drag.y = y; if (Math.hypot(x - drag.sx, y - drag.sy) > 6) { drag.moved = true; hidePop(); } return; }
    const n = pick(x, y);
    if (n !== hover) { hover = n; cv.style.cursor = n ? "grab" : "default"; }
    if (n && !selected) { tip.innerHTML = `<b>${esc(n.label)}</b><span>${esc(n.sub || "")}</span>`; tip.style.left = Math.min(W - 160, x + 14) + "px"; tip.style.top = (y - 10) + "px"; tip.classList.remove("hidden"); }
    else tip.classList.add("hidden");
  });
  cv.addEventListener("pointerleave", () => { hover = null; tip.classList.add("hidden"); });
  cv.addEventListener("pointerup", (e) => {
    const [x, y] = at(e);
    if (drag) {
      const n = drag.node;
      if (drag.moved) { n.ax = x; n.ay = y; saved[n.id] = [x / W, y / H]; savePos(); buzz(8); }
      else { selected = n; showPop(n); buzz(10); }
      drag = null; return;
    }
    if (!pick(x, y)) { selected = null; hidePop(); }
  });
  cv.addEventListener("dblclick", (e) => { const [x, y] = at(e); if (!pick(x, y)) { Object.keys(saved).forEach((k) => delete saved[k]); savePos(); layout(); toast("Раскладка сброшена"); } });

  function showPop(n) {
    tip.classList.add("hidden");
    let body = "", acts = "";
    if (n.kind === "pc") {
      body = `<span class="dot ${n.on ? "ok" : "bad"}"></span> ${n.on ? "включён" : "выключен"} · ${esc(status?.pc.ip || "")}`;
      acts = n.on ? `<button class="btn btn-sm btn-danger" data-act="pc-off">Выключить</button>` : `<button class="btn btn-sm btn-acc" data-act="pc-on">⏻ Включить</button>`;
      acts += `<button class="btn btn-sm" data-nv="page:pc">Подробнее →</button>`;
    } else if (n.kind === "dev") {
      const d = n.dev;
      body = `<span class="dot ${d.online ? "ok" : "bad"}"></span> ${d.online ? (n.on ? "включено" : "выключено") : "не в сети"}${d.room ? " · " + esc(d.room) : ""}${d.local ? " · по сети дома" : ""}`;
      if (d.online) acts = `<button class="btn btn-sm ${n.on ? "" : "btn-acc"}" data-nv="toggle">${n.on ? "Выключить" : "Включить"}</button>`;
      acts += `<button class="btn btn-sm" data-nv="page:devices">Устройства →</button>`;
    } else {
      const c = n.cl;
      body = `<span class="dot ${c.online ? "ok" : ""}"></span> ${c.online ? "в сети" : "не в сети"}<br><span class="mono">${esc(c.ip)} · ${esc(c.mac)}</span>${c.vendor ? `<br>${esc(c.vendor)}` : ""}`;
      acts = `<button class="btn btn-sm" data-cl="rename" data-mac="${esc(c.mac)}">✎ Имя</button>${c.online ? "" : `<button class="btn btn-sm" data-cl="wol" data-mac="${esc(c.mac)}">⏻ Разбудить</button>`}<button class="btn btn-sm" data-nv="page:router">Сеть →</button>`;
    }
    pop.innerHTML = `<button class="icon-btn nv-x" data-nv="close">✕</button><div class="nv-pop-ico">${n.ico}</div><b>${esc(n.label)}</b><p>${body}</p><div class="nv-pop-acts">${acts}</div>`;
    const px = Math.max(8, Math.min(W - 228, n.x + 24)), py = Math.max(8, Math.min(H - 190, n.y - 40));
    pop.style.left = px + "px"; pop.style.top = py + "px"; pop.classList.remove("hidden");
    $$("[data-nv]", pop).forEach((b) => b.onclick = async () => {
      const a = b.dataset.nv;
      if (a === "close") { selected = null; hidePop(); return; }
      if (a.startsWith("page:")) { go(a.slice(5)); return; }
      if (a === "toggle") {
        const d = n.dev, code = d.kind === "light" ? "switch_led" : "switch_1";
        b.disabled = true; await sendCmd(d.id, [{ code, value: !n.on }], `${d.name}: ${n.on ? "выключено" : "включено"}`);
        n.on = !n.on; showPop(n); renderDevices?.();
      }
    });
  }
  function hidePop() { pop.classList.add("hidden"); }

  function renderLegend() {
    const L = [["pc", "ПК", "pc"], ["dev", "Умный дом", "dev"], ["cl", "Устройства", "cl"]];
    $(".nv-legend").innerHTML = L.map(([k, t, c]) => `<button class="${hidden[k] ? "off" : ""}" data-lg="${k}"><i class="lg-${c}"></i>${t}</button>`).join("") + `<span class="nv-hint">тяните устройства · двойной клик — сброс</span>`;
    $$(".nv-legend [data-lg]").forEach((b) => b.onclick = () => { hidden[b.dataset.lg] = !hidden[b.dataset.lg]; try { localStorage.setItem("zh-nethide", JSON.stringify(hidden)); } catch (e) {} renderLegend(); });
  }

  function start() { resize(); cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }
  window.addEventListener("resize", () => { if (W) resize(); });
  // карта могла измериться, пока страница была скрыта, — следим за реальным размером
  if (window.ResizeObserver) new ResizeObserver(() => { const r = box.getBoundingClientRect(); if (r.width && (Math.abs(r.width - W) > 1 || Math.abs(r.height - H) > 1)) resize(); }).observe(box);
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelAnimationFrame(raf); else if (W) raf = requestAnimationFrame(draw); });
  return { start, update, get nodes() { return nodes; }, get size() { return [W, H]; } };
})();
