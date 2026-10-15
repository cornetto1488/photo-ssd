"use strict";
// Кондиционер Daichi: карточка для портала и киоска + «Подключения» (смена логина и пароля Daichi и v2rayA).
const acEsc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const AC_MODE = { cool: ["Охлаждение", "❄"], heat: ["Обогрев", "☀"], auto: ["Авто", "A"], dry: ["Осушение", "◌"], fan: ["Вентиляция", "✱"] };
const AC_TOG = { "vertical swing": "Качание шторок", eco: "Эко", turbo: "Турбо", "comfortable sleep": "Комфортный сон", "sound off": "Без звука" };
const AC_TOG_S = { "vertical swing": "Шторки", eco: "Эко", turbo: "Турбо", "comfortable sleep": "Сон", "sound off": "Тихо" };
const acx = { dev: null, mounts: [], busy: false, err: "", timer: 0 };

function acModeKey(f) {
  const s = ((f.title || "") + " " + (f.cmd || "")).toLowerCase();
  for (const k of ["cool", "heat", "dry", "fan", "auto"]) if (s.includes(k)) return k;
  return null;
}
function acModel(d) {
  const fns = d.functions || [];
  return {
    temp: fns.find((f) => f.type === "CIRCULAR_SLIDER"),
    fan: fns.find((f) => f.type === "LINEAR_SLIDER"),
    modes: fns.filter((f) => f.type === "ICON").map((f) => ({ f, k: acModeKey(f) })).filter((m) => m.k),
    togs: fns.filter((f) => f.type === "CARD"),
  };
}

function acHtml(d, compact) {
  const m = acModel(d), t = m.temp, rng = (t && t.range) || [16, 30];
  const set = t ? t.value : "—";
  const stat = d.status !== "connected" ? "нет связи с кондиционером" : d.on ? "включён" : "выключен";
  const modes = m.modes.map(({ f, k }) => '<button class="ac-chip' + (f.on && d.on ? " on" : "") + '" data-ac="mode" data-f="' + f.id + '"' + (f.controllable ? "" : " disabled") + ' title="' + AC_MODE[k][0] + '"><i>' + AC_MODE[k][1] + "</i><span>" + AC_MODE[k][0] + "</span></button>").join("");
  let fan = "";
  if (m.fan) {
    const lo = (m.fan.range && m.fan.range[0]) || 1, hi = (m.fan.range && m.fan.range[1]) || 3, auto = m.fan.link, cur = Number(m.fan.value);
    let btns = "";
    for (let n = lo; n <= hi; n++) btns += '<button class="ac-chip sm' + (!(auto && auto.on) && cur === n && d.on ? " on" : "") + '" data-ac="fan" data-n="' + n + '"' + (m.fan.controllable ? "" : " disabled") + ">" + n + "</button>";
    if (auto) btns += '<button class="ac-chip sm' + (auto.on && d.on ? " on" : "") + '" data-ac="fanauto"' + (auto.controllable ? "" : " disabled") + ">Авто</button>";
    fan = '<div class="ac-row"><span class="k-lab">ВЕНТИЛЯТОР</span><div class="ac-chips">' + btns + "</div></div>";
  }
  const togs = '<div class="ac-row ac-togs"><span class="k-lab">ДОПОЛНИТЕЛЬНО</span><div class="ac-chips">' + m.togs.map((f) => { const key = (f.title || "").toLowerCase(); return '<button class="ac-chip' + (f.on ? " on" : "") + '" data-ac="tog" data-f="' + f.id + '"' + (f.controllable ? "" : " disabled") + ">" + acEsc((compact ? AC_TOG_S[key] : AC_TOG[key]) || f.title || "Функция") + "</button>"; }).join("") + "</div></div>";
  return '<div class="ac' + (compact ? " ac-c" : "") + (d.on ? " on" : " off") + '">' +
    '<div class="ac-top"><div class="ac-ttl"><span class="k-lab">КОНДИЦИОНЕР</span><b>' + acEsc(d.title || "Кондиционер") + "</b><small>" + stat + (d.model ? " · " + acEsc(d.model) : "") + "</small></div>" +
    '<button class="ac-pwr" data-ac="power" title="' + (d.on ? "Выключить" : "Включить") + '"' + (d.powerFn ? "" : " disabled") + '><svg viewBox="0 0 24 24"><path d="M12 3v8M6.4 6.6a8 8 0 1 0 11.2 0"/></svg></button></div>' +
    '<div class="ac-temp"><button class="ac-step" data-ac="t-" ' + (t && t.controllable && set > rng[0] ? "" : "disabled") + ">−</button>" +
    '<div class="ac-set"><b>' + set + '°</b><small>в комнате ' + Math.round(d.temp) + "°</small></div>" +
    '<button class="ac-step" data-ac="t+" ' + (t && t.controllable && set < rng[1] ? "" : "disabled") + ">+</button></div>" +
    '<div class="ac-row"><span class="k-lab">РЕЖИМ</span><div class="ac-chips">' + modes + "</div></div>" + fan + togs + "</div>";
}

function acPaint() {
  acx.mounts.forEach((mt) => {
    if (!mt.el.isConnected) return;
    if (!acx.dev) {
      if (mt.compact) { mt.el.classList.add("hidden"); return; }
      mt.el.innerHTML = '<div class="card ac-empty"><div class="mono-label">КОНДИЦИОНЕР</div><p class="muted">' + acEsc(acx.err || "загружаю…") + '</p><button class="btn btn-acc" data-ac="setup">Подключить аккаунт Daichi →</button></div>';
      return;
    }
    mt.el.classList.remove("hidden");
    mt.el.innerHTML = acHtml(acx.dev, mt.compact);
  });
}
async function acRefresh(fresh) {
  try {
    const j = await api("/api/home/daichi" + (fresh ? "?fresh=1" : ""));
    acx.dev = (j.devices || [])[0] || null; acx.err = acx.dev ? "" : "кондиционеров в аккаунте нет";
  } catch (e) { acx.err = e.message || "ошибка"; if (!acx.dev) acx.dev = null; }
  acPaint();
}
async function acCtrl(body, optimistic) {
  if (acx.busy) return;
  acx.busy = true;
  try {
    if (optimistic) { optimistic(acx.dev); acPaint(); }
    await post("/api/home/daichi/ctrl", Object.assign({ device: acx.dev.id }, body));
    [1500, 4500].forEach((ms) => setTimeout(() => acRefresh(true), ms));
  } catch (e) { if (typeof toast === "function") toast(e.message || "не удалось отправить команду", true); acRefresh(true); }
  finally { acx.busy = false; }
}
function acClick(e) {
  const b = e.target.closest("[data-ac]"); if (!b || b.disabled) return;
  const d = acx.dev, a = b.dataset.ac;
  if (a === "setup") { if (typeof go === "function") go("router"); return; }
  if (!d) return;
  const m = acModel(d), t = m.temp, rng = (t && t.range) || [16, 30], fid = Number(b.dataset.f);
  if (a === "power") return acCtrl({ function: d.powerFn, on: !d.on }, (x) => { x.on = !x.on; });
  if (a === "t-" || a === "t+") {
    const nv = Math.min(rng[1], Math.max(rng[0], Number(t.value) + (a === "t+" ? 1 : -1)));
    clearTimeout(acx.tt); t.value = nv; acPaint(); // несколько нажатий подряд отправляем одной командой
    acx.tt = setTimeout(() => acCtrl({ function: t.id, value: nv }), 700); return;
  }
  if (a === "mode") return acCtrl({ function: fid, on: true }, () => { m.modes.forEach(({ f }) => { f.on = f.id === fid; }); });
  if (a === "fan") return acCtrl({ function: m.fan.id, value: Number(b.dataset.n) }, () => { m.fan.value = Number(b.dataset.n); if (m.fan.link) m.fan.link.on = false; });
  if (a === "fanauto") return acCtrl({ function: m.fan.link.id, on: !m.fan.link.on }, () => { m.fan.link.on = !m.fan.link.on; });
  if (a === "tog") { const f = m.togs.find((x) => x.id === fid); return acCtrl({ function: fid, on: !f.on }, () => { f.on = !f.on; }); }
}
// el — контейнер; compact — компактная карточка для киоска
function acMount(el, compact) {
  if (!acx.mounts.some((m) => m.el === el)) { acx.mounts.push({ el, compact: !!compact }); el.addEventListener("click", acClick); }
  acPaint();
}

// ---- Подключения: смена логина и пароля Daichi и v2rayA ----
async function accountsRender() {
  const el = $("#accCard"); if (!el) return;
  const [dc, vr] = await Promise.all([api("/api/home/daichi/account").catch(() => ({})), api("/api/home/v2raya/account").catch(() => ({}))]);
  const block = (id, title, who, f1, f2, ok) => '<form class="form acc-form" data-acc="' + id + '"><div class="acc-h"><b>' + title + '</b><span class="' + (ok ? "acc-ok" : "acc-no") + '">' + (ok ? "подключено · " + acEsc(who) : "не подключено") + "</span></div>" +
    '<label>' + f1 + '<input class="field" name="u" autocomplete="off" value="' + acEsc(who || "") + '"></label><label>' + f2 + '<input class="field" name="p" type="password" autocomplete="new-password" placeholder="новый пароль"></label>' +
    '<div class="acc-act"><button class="btn btn-acc">Сохранить</button><em class="muted small"></em></div></form>';
  el.innerHTML = '<div class="acc-grid">' + block("daichi", "Кондиционер Daichi", dc.email, "Email аккаунта Daichi", "Пароль", dc.connected) + block("v2raya", "v2rayA (VPN)", vr.username, "Логин v2rayA", "Пароль", vr.connected) + "</div>" +
    '<p class="muted small">Пароли хранятся только на роутере в защищённом файле и в портал не возвращаются. Перед сохранением вход проверяется.</p>';
  $$(".acc-form", el).forEach((f) => f.onsubmit = async (ev) => {
    ev.preventDefault();
    const note = $("em", f), u = f.u.value.trim(), p = f.p.value;
    if (!u || !p) { note.textContent = "введите логин и пароль"; return; }
    note.textContent = "проверяю…";
    try {
      await post(f.dataset.acc === "daichi" ? "/api/home/daichi/login" : "/api/home/v2raya/login", f.dataset.acc === "daichi" ? { email: u, password: p } : { username: u, password: p });
      f.p.value = ""; if (typeof toast === "function") toast("Сохранено"); accountsRender(); if (f.dataset.acc === "daichi") acRefresh(true);
    } catch (er) { note.textContent = er.message || "ошибка"; }
  });
}

async function vacMiniRender() {
  const el = $("#devVac"); if (!el) return;
  let j; try { j = await api("/api/home/dreame"); } catch (e) { el.classList.add("hidden"); return; }
  const s = j && j.status; if (!s) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const cl = typeof DR_CLEANING !== "undefined" && DR_CLEANING.has(s.state);
  if (!el.dataset.built) {
    el.dataset.built = "1";
    el.innerHTML = '<div class="ac vac"><div class="ac-top"><div class="ac-ttl"><span class="k-lab">ПЫЛЕСОС</span><b>Dreame L40 Ultra</b><small class="vac-st"></small></div></div>' +
      '<div class="ac-temp vac-stat"><div class="ac-set"><b class="vac-bat">—</b><small class="vac-area"></small></div></div>' +
      '<div class="ac-row"><span class="k-lab">УПРАВЛЕНИЕ</span><div class="ac-chips"><button class="ac-chip" data-vac="start">▶ Убрать</button><button class="ac-chip" data-vac="pause">⏸ Пауза</button><button class="ac-chip" data-vac="dock">⌂ На базу</button><button class="ac-chip" data-vac="locate">⌖ Найти</button></div></div>' +
      '<div class="vac-map"><canvas id="devVacMap"></canvas></div></div>';
    $$("[data-vac]", el).forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try { await post("/api/home/dreame/cmd", { action: b.dataset.vac }); if (typeof toast === "function") toast({ start: "Поехал убирать", pause: "Пауза", dock: "Возвращается на базу", locate: "Пылесос подаёт сигнал" }[b.dataset.vac]); setTimeout(vacMiniRender, 2500); }
      catch (e) { if (typeof toast === "function") toast(e.message, true); }
      b.disabled = false;
    });
    if (typeof dmLoad === "function" && typeof DreameMap3D === "function") dmLoad().then((c) => {
      const cv = $("#devVacMap"); if (!cv) return;
      acx.vmap = new DreameMap3D(cv, { autoRotate: false, interactive: false, labels: false, cache: true, replayMs: 8000 });
      acx.vmap.yaw = -0.6; acx.vmap.setNames(c.names); acx.vmap.setData(c.map);
    }).catch(() => { const m = $(".vac-map", el); if (m) m.classList.add("hidden"); });
  }
  $(".ac", el).classList.toggle("on", cl); $(".ac", el).classList.toggle("off", !cl);
  $(".vac-st", el).textContent = (s.stateText || "") + (cl ? " · убрано " + s.cleanArea + " м²" : "");
  $(".vac-bat", el).textContent = s.battery + "%";
  $(".vac-area", el).textContent = cl ? "идёт уборка" : "заряд батареи";
  $('[data-vac="start"]', el).classList.toggle("on", cl);
}

const _goAc = go;
go = function (p) {
  _goAc(p);
  clearInterval(acx.timer);
  if (p === "ac") { const el = $("#acPage"); if (el) acMount(el, false); acRefresh(true); acx.timer = setInterval(() => { if (!acx.busy) acRefresh(); }, 12000); }
  if (p === "home") { const el = $("#homeAc"); if (el) { acMount(el, true); acRefresh(); acx.timer = setInterval(() => { if (!acx.busy) acRefresh(); }, 15000); } }
  if (p === "devices") { const el = $("#devAc"); if (el) { acMount(el, false); acRefresh(); } vacMiniRender(); acx.timer = setInterval(() => { if (!acx.busy) acRefresh(); vacMiniRender(); }, 15000); }
  if (p === "router") accountsRender();
};
