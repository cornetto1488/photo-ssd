"use strict";
// ZALET HOME — «Дом сейчас»: VPN, трафик, скорость, заметки, предупреждения.

const fmtRate = (bps) => bps >= 1e6 ? (bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1).replace(".", ",") + " Мбит/с" : bps >= 1e3 ? Math.round(bps / 1e3) + " кбит/с" : Math.round(bps) + " бит/с";

// ---------- VPN ----------
let vpn = null;
async function loadVPN(fresh) {
  try { vpn = await api("/api/home/vpn" + (fresh ? "?fresh=1" : "")); } catch (e) { vpn = { ok: false, error: e.message }; }
  renderVPN(); renderAlerts();
}
function renderVPN() {
  const v = vpn; if (!v) return;
  const sub = v.sub || {};
  const exp = sub.expire || 0, now = Date.now() / 1000;
  const days = exp ? Math.max(0, Math.ceil((exp - now) / 86400)) : null;
  const used = (sub.download || 0) + (sub.upload || 0);
  let expTxt = "бессрочно", expCls = "";
  if (exp) {
    if (exp < now) { expTxt = "истекла"; expCls = "bad"; }
    else { expTxt = `до ${new Date(exp * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })} · ${days} ${plural(days, "день", "дня", "дней")}`; if (days < 3) expCls = "warn"; }
  }
  $("#vpnCard").innerHTML = `
    <div class="head-row"><div class="mono-label"><span class="dot ${v.ok ? "ok" : "bad"}"></span> VPN · ${esc(v.provider || "нода")}</div><button class="icon-btn" id="vpnRe" title="Проверить">↻</button></div>
    <div class="vpn-state ${v.ok ? "grad" : "bad"}">${v.ok ? "РАБОТАЕТ" : "НЕ ОТВЕЧАЕТ"}</div>
    <div class="kv-list">
      ${v.ok ? `<div><span>Выход</span><b class="mono">${esc(v.exitIP)}</b></div><div><span>Отклик</span><b class="mono">${v.ms} мс</b></div>` : `<div><span>Причина</span><b>${esc(v.error || "")}</b></div>`}
      ${v.sub ? `<div><span>Подписка</span><b class="${expCls}">${expTxt}</b></div><div><span>Трафик</span><b class="mono">${fmtBytes(used)}${sub.total ? " из " + fmtBytes(sub.total) : ""}</b></div>` : ""}
    </div>
    ${!v.ok ? `<p class="muted small">Проверьте подписку и обновите её в v2raya — заблокированные сайты, Telegram и Tailscale без ноды не работают.</p>` : ""}
    <div class="kv-btns"><button class="btn btn-sm" data-view-vpn>v2raya</button><a class="btn btn-sm" href="https://vpnushka.lol" target="_blank" rel="noopener">Продлить ↗</a></div>`;
  $("#vpnRe").onclick = () => { $("#vpnRe").classList.add("spin"); loadVPN(true); };
  $("[data-view-vpn]").onclick = () => openViewer("Обход блокировок · v2raya", `http://${location.hostname}:2017`);
}

// ---------- предупреждения ----------
function renderAlerts() {
  const a = [];
  if (vpn && !vpn.ok) a.push(["bad", "⛨", "VPN-нода не отвечает", "Заблокированные сайты, Telegram и Tailscale сейчас не работают."]);
  const exp = vpn?.sub?.expire;
  if (exp && exp > Date.now() / 1000 && exp - Date.now() / 1000 < 3 * 86400) a.push(["warn", "⏳", "Подписка VPN скоро закончится", `Осталось ${Math.ceil((exp - Date.now() / 1000) / 86400)} дн. — продлите на vpnushka.lol.`]);
  if (exp && exp < Date.now() / 1000) a.push(["bad", "⏳", "Подписка VPN истекла", "Продлите её и обновите подписку в v2raya."]);
  if (status) {
    if (!status.internet) a.push(["bad", "⌁", "Нет интернета", "Роутер не видит внешнюю сеть — проверьте терминал Ростелекома."]);
    if (status.ssd.total && status.ssd.free / status.ssd.total < 0.08) a.push(["warn", "▣", "SSD почти заполнен", `Свободно ${fmtBytes(status.ssd.free)}.`]);
    if (status.router.temp > 85) a.push(["warn", "♨", "Роутер горячий", `${status.router.temp.toFixed(0)}°C`]);
    if (!status.services.smbd) a.push(["warn", "⇄", "Сетевая папка не работает", "Samba остановлена — перезапустите в «Сервисах»."]);
  }
  $("#alerts").innerHTML = a.map(([c, i, t, s]) => `<div class="alert ${c}"><i>${i}</i><div><b>${esc(t)}</b><span>${esc(s)}</span></div></div>`).join("");
}

// ---------- трафик ----------
const traffic = { pts: [], last: null };
async function pollTraffic() {
  if (page !== "home" || document.hidden) return;
  try {
    const r = await api("/api/home/traffic");
    if (traffic.last && r.t > traffic.last.t) {
      const dt = (r.t - traffic.last.t) / 1000;
      const rx = Math.max(0, (r.rx - traffic.last.rx) * 8 / dt), tx = Math.max(0, (r.tx - traffic.last.tx) * 8 / dt);
      traffic.pts.push([rx, tx]); if (traffic.pts.length > 90) traffic.pts.shift();
      $("#rateRx").textContent = fmtRate(rx); $("#rateTx").textContent = fmtRate(tx);
      drawTraffic();
    }
    traffic.last = r;
  } catch (e) {}
}
function drawTraffic() {
  const cv = $("#trafficCanvas"), ctx = cv.getContext("2d");
  const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  if (!r.width) return;
  cv.width = r.width * dpr; cv.height = r.height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height, pts = traffic.pts;
  const max = Math.max(1e6, ...pts.map((p) => Math.max(p[0], p[1]))) * 1.15;
  const line = (k, col, fill) => {
    ctx.beginPath();
    pts.forEach((p, i) => { const x = W - (pts.length - 1 - i) * (W / 89), y = H - p[k] / max * (H - 6); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (fill) { ctx.lineTo(W, H); ctx.lineTo(W - (pts.length - 1) * (W / 89), H); ctx.closePath(); const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, fill); g.addColorStop(1, "rgba(255,90,31,0)"); ctx.fillStyle = g; ctx.fill(); }
    else { ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke(); }
  };
  if (pts.length > 1) { line(0, null, "rgba(255,120,50,.35)"); line(0, "#ff8a4c"); line(1, "rgba(154,163,214,.9)"); }
}
$("#speedBtn").onclick = async () => {
  const b = $("#speedBtn"); b.disabled = true; b.textContent = "Замеряю… ~10 с";
  $("#speedRes").innerHTML = `<div class="spinner"></div>`;
  try {
    const r = await api("/api/home/speed");
    $("#speedRes").innerHTML = `<span class="mono-label">СКОРОСТЬ</span><b class="grad">${Math.round(r.mbps)} Мбит/с</b><span class="mono-label">отклик ${r.ping} мс · ${esc(r.server)}</span>`;
    try { localStorage.setItem("zh-speed", JSON.stringify({ ...r, at: Date.now() })); } catch (e) {}
  } catch (e) { $("#speedRes").innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  b.disabled = false; b.textContent = "⚡ Замерить скорость";
};
try { const s = JSON.parse(localStorage.getItem("zh-speed") || "null"); if (s) $("#speedRes").innerHTML = `<span class="mono-label">ПРОШЛЫЙ ЗАМЕР · ${ago(s.at / 1000)}</span><b class="grad">${Math.round(s.mbps)} Мбит/с</b>`; } catch (e) {}

// ---------- заметки и покупки ----------
let notes = [], notesList = "notes";
async function loadNotes(body) {
  try { notes = (await (body ? post("/api/home/notes", body) : api("/api/home/notes"))).notes || []; } catch (e) { toast(e.message, true); }
  renderNotes();
}
function renderNotes() {
  const list = notes.filter((n) => n.list === notesList).sort((a, b) => a.done - b.done || b.at - a.at);
  $("#notesList").innerHTML = list.map((n) => `<div class="note ${n.done ? "done" : ""}" data-nid="${n.id}"><button class="chk" data-na="toggle">${n.done ? "✓" : ""}</button><span>${esc(n.text)}</span><button class="icon-btn x" data-na="delete" title="Удалить">✕</button></div>`).join("") ||
    `<p class="muted small">${notesList === "shop" ? "Список покупок пуст — добавьте, что купить." : "Пока пусто. Заметки видны всем дома."}</p>`;
  $$("#notesTabs button").forEach((b) => { const n = notes.filter((x) => x.list === b.dataset.l && !x.done).length; b.textContent = (b.dataset.l === "shop" ? "Покупки" : "Заметки") + (n ? ` · ${n}` : ""); });
  $$("[data-na]").forEach((b) => b.onclick = () => loadNotes({ action: b.dataset.na, note: { id: b.closest("[data-nid]").dataset.nid } }));
}
$$("#notesTabs button").forEach((b) => b.onclick = () => { notesList = b.dataset.l; $$("#notesTabs button").forEach((x) => x.classList.toggle("active", x === b)); renderNotes(); });
$("#noteForm").onsubmit = (e) => { e.preventDefault(); const t = $("#noteText").value.trim(); if (!t) return; $("#noteText").value = ""; loadNotes({ action: "add", note: { text: t, list: notesList } }); };
$("#notesClear").onclick = () => loadNotes({ action: "clear", note: { list: notesList } });

// ---------- таймер выключателей ----------
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-timer]"); if (!b) return;
  const d = devices.find((x) => x.id === b.dataset.timer); if (!d) return;
  const opts = [[15, "15 мин"], [30, "30 мин"], [60, "1 час"], [120, "2 часа"], [0, "Отменить таймер"]];
  openForm('<span class="acc">// ТАЙМЕР</span>', d.name, `<p class="muted small">Выключатель сам выключится через выбранное время — даже если роутер или интернет пропадут.</p>
    <div class="timer-opts">${opts.map(([m, l]) => `<button class="btn ${m ? "" : "btn-danger"}" data-tm="${m}">${l}</button>`).join("")}</div>`, () => {
    $$("[data-tm]").forEach((x) => x.onclick = async () => {
      const m = Number(x.dataset.tm); closeForm();
      const cmds = m ? [{ code: "switch_1", value: true }, { code: "countdown_1", value: m * 60 }] : [{ code: "countdown_1", value: 0 }];
      await sendCmd(d.id, cmds, m ? `${d.name}: выключится через ${x.textContent}` : "Таймер отменён");
      renderDevices();
    });
  });
});

// ---------- резервная копия ----------
document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-backup]")) return;
  toast("Готовлю резервную копию…");
  location.href = "/api/home/backup";
});

function nowStart() {
  loadVPN(); loadNotes(); pollTraffic();
  timers.vpn = setInterval(() => loadVPN(), 120000);
  timers.traffic = setInterval(pollTraffic, 2000);
  timers.notes = setInterval(() => { if (page === "home" && document.activeElement?.id !== "noteText") loadNotes(); }, 30000);
}
