"use strict";
// ZALET HOME — «Дом коротко»: живые плитки внизу главной (свет, пылесос, камеры, ПК, фото, скорость, событие, неделя).

const ht = { timer: null, busy: false };
const htEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const htHM = (sec) => { sec = Math.round(sec || 0); if (sec < 60) return sec ? "<1 мин" : "0 мин"; const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h ? (m ? `${h} ч ${m} мин` : `${h} ч`) : `${m} мин`; };
const htAgo = (t) => { const s = Math.floor(Date.now() / 1000 - t); if (s < 90) return "только что"; if (s < 3600) return Math.floor(s / 60) + " мин назад"; if (s < 86400) return Math.floor(s / 3600) + " ч назад"; return Math.floor(s / 86400) + " дн назад"; };

function htTile({ cls = "", icon, label, big, sub, page, btn, bg }) {
  return `<div class="ht ${cls}" ${page ? `data-ht-page="${page}"` : ""} ${bg ? `style="--bg:url('${bg}')"` : ""}>
    <div class="ht-top"><span class="ht-ico">${icon}</span><span class="mono-label">${label}</span></div>
    <div class="ht-big">${big}</div>
    <div class="ht-sub">${sub || ""}</div>
    ${btn || ""}
  </div>`;
}

async function loadHomeTiles() {
  const box = $("#launch"); if (!box) return;
  const safe = (p) => p.catch(() => null);
  const [lights, vac, camCfg, net, ev] = await Promise.all([
    safe(api("/api/home/stats/lights?days=7")), safe(api("/api/home/dreame")), safe(api("/api/cameras/config")),
    safe(api("/api/home/stats/net?hours=24")), safe(api("/api/home/events")),
  ]);
  const tiles = [];

  // Свет
  if (lights) {
    const devs = lights.devices || [], on = devs.filter((d) => d.on), today = (lights.dayTotals || []).slice(-1)[0] || 0;
    tiles.push(htTile({ cls: on.length ? "lit" : "", icon: "💡", label: "СВЕТ", big: on.length ? `Горит: ${on.length}` : "Всё выключено",
      sub: on.length ? htEsc(on.slice(0, 3).map((d) => d.name).join(", ")) : `сегодня горел ${htHM(today)}`, page: "devices",
      btn: on.length ? `<button class="btn btn-sm" data-act="alloff">Выключить всё</button>` : "" }));
  }
  // Пылесос
  const vs = vac?.status;
  if (vs) {
    const cleaning = DR_CLEANING.has(vs.state);
    tiles.push(htTile({ cls: cleaning ? "lit" : "", icon: "🧹", label: "ПЫЛЕСОС", big: htEsc(vs.stateText), sub: `батарея ${vs.battery}%${cleaning ? ` · убрано ${vs.cleanArea} м²` : ""}`, page: "vacuum",
      btn: `<button class="btn btn-sm" data-ht-vac="${cleaning ? "dock" : "start"}">${cleaning ? "⌂ На базу" : "▶ Убрать"}</button>` }));
  } else if (vac && !vac.configured) {
    tiles.push(htTile({ icon: "🧹", label: "ПЫЛЕСОС", big: "Подключить", sub: "карта дома и управление", page: "vacuum" }));
  }
  // Камеры
  const camN = (camCfg?.cams || []).filter((c) => !c.hidden).length;
  tiles.push(htTile({ icon: "📹", label: "КАМЕРЫ", big: camN ? `${camN} камер` : "Камеры", sub: "прямой эфир и архив с ускорением", page: "cameras" }));
  // Компьютер
  const pcOn = status?.pc?.online;
  tiles.push(htTile({ cls: pcOn ? "lit" : "", icon: "🖥", label: "КОМПЬЮТЕР", big: pcOn ? "Включён" : "Выключен", sub: pcOn ? "управление и скриншот" : "можно включить отсюда", page: "pc" }));
  // Фото
  const pf = status?.photos;
  const thumb = typeof mosaicShown !== "undefined" && mosaicShown[0] ? `/api/v1/thumb?id=${encodeURIComponent(mosaicShown[0].id)}` : "";
  tiles.push(htTile({ cls: thumb ? "photo" : "", icon: "▣", label: "ФОТО", big: `${(pf?.files || 0).toLocaleString("ru-RU")}`, sub: pf?.last ? `последнее ${htAgo(pf.last)}` : "на SSD", page: "photos", bg: thumb }));
  // Скорость интернета
  const sp = (net?.speed || []).slice(-1)[0];
  tiles.push(htTile({ icon: "⚡", label: "СКОРОСТЬ", big: sp ? `${sp.mbps.toFixed(0)} <small>Мбит/с</small>` : "—", sub: sp ? `замер ${htAgo(sp.t)} · пинг ${sp.ping} мс` : "замеров пока нет", page: "stats" }));
  // Последнее событие
  const e0 = (ev?.events || [])[0];
  if (e0) tiles.push(htTile({ icon: "🔔", label: "ПОСЛЕДНЕЕ СОБЫТИЕ", big: `<span class="ht-ev">${htEsc(e0.text)}</span>`, sub: htAgo(e0.t), page: "logs" }));
  // Неделя света
  if (lights && (lights.devices || []).length) {
    const tot = (lights.devices || []).reduce((a, d) => a + d.total, 0), top = lights.devices[0];
    tiles.push(htTile({ icon: "📊", label: "СВЕТ ЗА НЕДЕЛЮ", big: htHM(tot), sub: top && top.total ? `больше всего: ${htEsc(top.name)}` : "статистика копится", page: "stats" }));
  }
  box.innerHTML = tiles.join("");
  $$("[data-ht-page]", box).forEach((el) => el.onclick = (e) => { if (e.target.closest("button")) return; go(el.dataset.htPage); });
  $$("[data-ht-vac]", box).forEach((b) => b.onclick = async () => {
    if (ht.busy) return;
    const act = b.dataset.htVac;
    if (act === "start" && !(await askConfirm({ icon: "🧹", title: "Запустить уборку?", text: "Пылесос поедет убирать весь дом.", yes: "Убрать" }))) return;
    ht.busy = true; b.disabled = true;
    try { await post("/api/home/dreame/cmd", { action: act }); toast(act === "start" ? "Поехал убирать" : "Возвращается на базу"); setTimeout(loadHomeTiles, 2500); }
    catch (er) { toast(er.message, true); b.disabled = false; }
    finally { ht.busy = false; }
  });
}

const _goHt = go;
go = function (p) {
  _goHt(p);
  clearInterval(ht.timer);
  if (p === "home") { loadHomeTiles(); setTimeout(loadHomeTiles, 3500); ht.timer = setInterval(() => { if (!document.hidden) loadHomeTiles(); }, 30000); }
};
