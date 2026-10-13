"use strict";
// ZALET HOME — доступ: токен ZALET, SSH-ключи роутера, мои хосты, Wi-Fi для гостей, действия с роутером.

let tokenShown = false, tokenData = null;
async function loadAccess() { loadToken(); loadSSH(); loadHosts(); loadWifi(); renderRouterCard(); }

// ---------- токен ZALET ----------
async function loadToken() {
  try { tokenData = await api("/api/home/token?qr=1"); } catch (e) { $("#tokenCard").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  renderToken();
}
function renderToken() {
  const t = tokenData; if (!t) return;
  $("#tokenCard").innerHTML = `
    <div class="mono-label"><span class="acc">// ZALET</span> ТОКЕН ПРИЛОЖЕНИЯ</div>
    <p class="muted small">Им приложение ZALET на iPhone входит на сервер фото. Вставьте в настройках приложения или наведите камеру на QR.</p>
    <div class="token-row">
      <div class="token-qr ${tokenShown ? "" : "blur"}">${t.qr || '<span class="muted small">QR недоступен</span>'}</div>
      <div class="token-info">
        <div class="kv"><span class="mono-label">СЕРВЕР</span><code>${esc(t.server)}</code><button class="btn btn-sm" data-tk="cs">Копировать</button></div>
        <div class="kv"><span class="mono-label">ТОКЕН</span><code class="pw">${tokenShown ? esc(t.token) : "•".repeat(24)}</code></div>
        <div class="kv-btns"><button class="btn btn-sm" data-tk="show">${tokenShown ? "Скрыть" : "Показать"}</button><button class="btn btn-sm" data-tk="copy">Копировать токен</button><button class="btn btn-sm btn-danger" data-tk="new">↻ Новый токен</button></div>
      </div>
    </div>`;
  $$("[data-tk]").forEach((b) => b.onclick = async () => {
    const a = b.dataset.tk;
    if (a === "show") { tokenShown = !tokenShown; renderToken(); }
    if (a === "copy") copyText(t.token, "Токен скопирован");
    if (a === "cs") copyText(t.server, "Адрес скопирован");
    if (a === "new") {
      if (!(await askConfirm({ icon: "↻", title: "Выпустить новый токен?", text: "Старый перестанет работать сразу: в приложении ZALET нужно будет вставить новый, иначе выгрузка остановится.", yes: "Да, новый", danger: true }))) return;
      try { await post("/api/home/token"); tokenShown = true; toast("Новый токен готов — обновите его в приложении"); loadToken(); } catch (e) { toast(e.message, true); }
    }
  });
}

// ---------- роутер ----------
function renderRouterCard() {
  $("#routerCard").innerHTML = `
    <div class="mono-label"><span class="acc">// РОУТЕР</span> ДЕЙСТВИЯ</div>
    <p class="muted small">Подключение по SSH с этого ПК:</p>
    <div class="kv"><code>ssh root@192.168.1.1</code><button class="btn btn-sm" data-ra="copyssh">Копировать</button></div>
    <div class="router-acts">
      <button class="btn" data-ra="wifi">⟳ Перезапустить Wi-Fi</button>
      <button class="btn btn-danger" data-ra="reboot">⏻ Перезагрузить роутер</button>
      <button class="btn" data-ra="luci">⌁ Открыть LuCI</button>
      <button class="btn" data-backup>⤓ Резервная копия настроек</button>
    </div>`;
  $$("[data-ra]").forEach((b) => b.onclick = async () => {
    const a = b.dataset.ra;
    if (a === "copyssh") return copyText("ssh root@192.168.1.1", "Команда скопирована");
    if (a === "luci") return openViewer("Роутер · LuCI", "/cgi-bin/luci/");
    if (a === "wifi" && !(await askConfirm({ icon: "⟳", title: "Перезапустить Wi-Fi?", text: "Все беспроводные устройства отключатся на 10–20 секунд и подключатся обратно.", yes: "Перезапустить" }))) return;
    if (a === "reboot" && !(await askConfirm({ icon: "⏻", title: "Перезагрузить роутер?", text: "Интернет, Wi-Fi, VPN и эта панель пропадут примерно на 1–2 минуты.", yes: "Перезагрузить", danger: true }))) return;
    try { await post("/api/home/system", { action: a }); toast(a === "reboot" ? "Роутер перезагружается… страница обновится сама" : "Wi-Fi перезапускается"); if (a === "reboot") waitRouter(); }
    catch (e) { toast(e.message, true); }
  });
}
function waitRouter() {
  let n = 0;
  const t = setInterval(async () => {
    n++;
    try { const r = await fetch("/api/home/pin-info", { cache: "no-store" }); if (r.ok && n > 6) { clearInterval(t); location.reload(); } } catch (e) {}
    if (n > 90) clearInterval(t);
  }, 3000);
}

// ---------- SSH-ключи ----------
let sshKeys = [];
async function loadSSH() {
  try { sshKeys = (await api("/api/home/ssh")).keys || []; } catch (e) { $("#sshKeys").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  $("#sshKeys").innerHTML = sshKeys.map((k) => `<div class="keyc" data-ki="${k.index}">
      <div class="key-ico">⚷</div>
      <div class="key-main"><b>${esc(k.name || "без имени")}</b><span class="mono">${esc(k.type)} · ${esc(k.fingerprint)}</span><code>${esc(k.short)}</code></div>
      <div class="key-acts"><button class="btn btn-sm" data-ka="copy">Копировать</button><button class="btn btn-sm" data-ka="rename">✎</button><button class="btn btn-sm btn-danger" data-ka="del" ${sshKeys.length <= 1 ? "disabled title='Последний ключ удалить нельзя'" : ""}>Удалить</button></div>
    </div>`).join("") || `<p class="muted">Ключей нет — вход только по паролю.</p>`;
  $$("[data-ka]").forEach((b) => b.onclick = async () => {
    const k = sshKeys.find((x) => String(x.index) === b.closest("[data-ki]").dataset.ki);
    const a = b.dataset.ka;
    if (a === "copy") copyText(k.line + (k.name ? " " + k.name : ""), "Публичный ключ скопирован");
    if (a === "rename") openForm('<span class="acc">// SSH</span>', "Переименовать", `<form class="form" id="rnForm"><label>Название<input class="field" id="rnName" value="${esc(k.name)}" placeholder="например: ноутбук, iPhone Termius"></label>
      <div class="form-acts"><button class="btn btn-acc">Сохранить</button></div></form>`, () => {
      $("#rnForm").onsubmit = async (e) => { e.preventDefault(); try { await post("/api/home/ssh", { action: "rename", index: k.index, name: $("#rnName").value }); closeForm(); loadSSH(); } catch (er) { toast(er.message, true); } };
    });
    if (a === "del") {
      if (!(await askConfirm({ icon: "⚷", title: "Удалить ключ?", text: `С ключом «${k.name || k.fingerprint}» больше нельзя будет войти на роутер.`, yes: "Удалить", danger: true }))) return;
      try { await post("/api/home/ssh", { action: "delete", index: k.index }); toast("Ключ удалён"); loadSSH(); } catch (e) { toast(e.message, true); }
    }
  });
}
$("#sshAddBtn").onclick = () => openForm('<span class="acc">// SSH</span>', "Добавить ключ", `<form class="form" id="kaForm">
  <label>Название<input class="field" id="kaName" placeholder="например: ноутбук, рабочий ПК"></label>
  <label>Публичный ключ<textarea class="field mono" id="kaKey" rows="4" placeholder="ssh-ed25519 AAAA… — содержимое файла .pub"></textarea></label>
  <p class="muted small">Только публичный ключ (файл .pub). Приватный ключ никуда вставлять не нужно.</p>
  <div class="form-acts"><button class="btn btn-acc">Добавить</button></div></form>`, () => {
  $("#kaForm").onsubmit = async (e) => { e.preventDefault(); try { await post("/api/home/ssh", { action: "add", name: $("#kaName").value, key: $("#kaKey").value }); closeForm(); toast("Ключ добавлен — можно входить"); loadSSH(); } catch (er) { toast(er.message, true); } };
});
$("#sshGenBtn").onclick = () => openForm('<span class="acc">// SSH</span>', "Новый ключ", `<form class="form" id="kgForm">
  <label>Для чего<input class="field" id="kgName" placeholder="например: iPhone Termius" value="zalet-${new Date().toISOString().slice(0, 10)}"></label>
  <label class="flag"><input type="checkbox" id="kgAuth" checked><span>Сразу разрешить вход на роутер с этим ключом</span></label>
  <p class="muted small">Ключ ed25519 создастся на роутере. Приватную часть покажу один раз — скачайте её, на роутере она не сохраняется.</p>
  <div class="form-acts"><button class="btn btn-acc" id="kgGo">Создать</button></div></form>`, () => {
  $("#kgForm").onsubmit = async (e) => {
    e.preventDefault(); $("#kgGo").disabled = true;
    try {
      const r = await post("/api/home/ssh/generate", { name: $("#kgName").value, authorize: $("#kgAuth").checked });
      const file = (r.name || "zalet").replace(/[^\w.-]+/g, "_");
      openForm('<span class="acc">// SSH</span>', "Ключ готов", `<div class="form">
        <p class="warn-box">Приватный ключ показывается один раз. Скачайте его и не отправляйте никому.</p>
        <label>Приватный ключ<textarea class="field mono" rows="6" readonly>${esc(r.private)}</textarea></label>
        <div class="form-acts"><button class="btn" id="kgCopyPriv">Копировать</button><button class="btn btn-acc" id="kgDl">⤓ Скачать ${esc(file)}</button></div>
        <label>Публичный ключ<textarea class="field mono" rows="2" readonly>${esc(r.public)}</textarea></label>
        <div class="howto"><div class="mono-label">КАК ПОДКЛЮЧИТЬСЯ</div>
          <p><b>Windows / macOS:</b> положите файл в папку <code>~/.ssh/</code> и выполните <code>ssh -i ~/.ssh/${esc(file)} root@192.168.1.1</code></p>
          <p><b>iPhone (Termius):</b> Keychain → Import key → вставьте приватный ключ, хост 192.168.1.1, пользователь root.</p></div>
      </div>`, () => {
        $("#kgDl").onclick = () => download(file, r.private.endsWith("\n") ? r.private : r.private + "\n");
        $("#kgCopyPriv").onclick = () => copyText(r.private, "Приватный ключ скопирован");
      });
      loadSSH();
    } catch (er) { toast(er.message, true); $("#kgGo").disabled = false; }
  };
});

// ---------- мои хосты и публичные ключи ----------
let hosts = [];
async function loadHosts() {
  try { hosts = (await api("/api/home/vault")).items || []; } catch (e) { $("#hosts").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  $("#hosts").innerHTML = hosts.map((h) => `<div class="keyc" data-hid="${esc(h.id)}">
      <div class="key-ico host">⌂</div>
      <div class="key-main"><b>${esc(h.name)}</b><span class="mono">${esc([h.user, h.host].filter(Boolean).join("@"))}</span>${h.public ? `<code>${esc(h.public.slice(0, 26))}…${esc(h.public.slice(-14))}</code>` : ""}${h.note ? `<span class="muted small">${esc(h.note)}</span>` : ""}</div>
      <div class="key-acts">${h.host ? `<button class="btn btn-sm" data-ha="ssh">ssh ⧉</button>` : ""}${h.public ? `<button class="btn btn-sm" data-ha="pub">Ключ ⧉</button>` : ""}<button class="btn btn-sm" data-ha="edit">✎</button><button class="btn btn-sm btn-danger" data-ha="del">✕</button></div>
    </div>`).join("") || `<p class="muted small">Здесь можно хранить адреса своих серверов (vpnushka, хостинг сайта…) и публичные ключи. Пароли — в разделе «Пароли».</p>`;
  $$("[data-ha]").forEach((b) => b.onclick = async () => {
    const h = hosts.find((x) => x.id === b.closest("[data-hid]").dataset.hid);
    const a = b.dataset.ha;
    if (a === "ssh") copyText(`ssh ${h.user ? h.user + "@" : ""}${h.host}`, "Команда скопирована");
    if (a === "pub") copyText(h.public, "Публичный ключ скопирован");
    if (a === "edit") editHost(h);
    if (a === "del") {
      if (!(await askConfirm({ icon: "⌂", title: "Удалить запись?", text: `«${h.name}» удалится из списка.`, yes: "Удалить", danger: true }))) return;
      try { await post("/api/home/vault", { action: "delete", item: { id: h.id } }); loadHosts(); } catch (e) { toast(e.message, true); }
    }
  });
}
function editHost(h) {
  h = h || { name: "", host: "", user: "root", public: "", note: "" };
  openForm('<span class="acc">// ХОСТ</span>', h.id ? h.name : "Новый сервер", `<form class="form" id="hForm">
    <label>Название<input class="field" id="hName" value="${esc(h.name)}" placeholder="VPS ВПНушка"></label>
    <div class="form-2"><label>Пользователь<input class="field" id="hUser" value="${esc(h.user)}"></label><label>Адрес<input class="field mono" id="hHost" value="${esc(h.host)}" placeholder="1.2.3.4 или домен"></label></div>
    <label>Публичный ключ (необязательно)<textarea class="field mono" id="hPub" rows="3" placeholder="ssh-ed25519 AAAA…">${esc(h.public)}</textarea></label>
    <label>Заметка<input class="field" id="hNote" value="${esc(h.note)}" placeholder="порт, провайдер, срок оплаты…"></label>
    <div class="form-acts"><button class="btn btn-acc">Сохранить</button></div></form>`, () => {
    $("#hForm").onsubmit = async (e) => {
      e.preventDefault();
      const item = { ...h, name: $("#hName").value.trim(), user: $("#hUser").value.trim(), host: $("#hHost").value.trim(), public: $("#hPub").value.trim(), note: $("#hNote").value.trim() };
      if (!item.name) { toast("Укажите название", true); return; }
      try { await post("/api/home/vault", { action: "save", item }); closeForm(); loadHosts(); } catch (er) { toast(er.message, true); }
    };
  });
}
$("#hostAddBtn").onclick = () => editHost(null);

// ---------- Wi-Fi для гостей ----------
let wifiShown = {}, sysInfo = null;

// ---------- сводка о роутере ----------
function renderRouterStats() {
  if (!$("#routerStats")) return;
  const s = status;
  if (s) {
    const r = s.router, mem = r.memTotal ? (1 - r.memAvail / r.memTotal) * 100 : 0, ssd = s.ssd.total ? (1 - s.ssd.free / s.ssd.total) * 100 : 0;
    const st = (label, v, sub, bar) => `<div class="tile"><div class="mono-label">${label}</div><div class="val">${v}</div><div class="sub">${sub}</div>${bar === undefined ? "" : `<div class="bar"><i style="width:${Math.max(2, Math.min(100, bar))}%"></i></div>`}</div>`;
    const on = clients.filter((c) => c.online).length;
    $("#routerStats").innerHTML = [
      st("Работает", fmtUptime(r.uptime).toUpperCase(), `нагрузка ${r.load}`),
      st("Температура", r.temp ? r.temp.toFixed(0) + "°C" : "—", r.temp > 80 ? "горячо" : "норма", r.temp ? r.temp : undefined),
      st("Память", mem.toFixed(0) + "%", `свободно ${fmtBytes(r.memAvail)}`, mem),
      st("SSD", fmtBytes(s.ssd.free), `свободно из ${fmtBytes(s.ssd.total)}`, ssd),
      st("Устройства", String(on), `в сети из ${clients.length}`),
      st("Интернет", s.internet ? "В СЕТИ" : "НЕТ", vpn ? (vpn.ok ? "VPN работает" : "VPN не отвечает") : ""),
    ].join("");
  }
  const i = sysInfo; if (!i) return;
  const row = (k, v, copy) => v ? `<div><span>${k}</span><b class="mono">${esc(v)}</b>${copy ? `<button class="icon-btn" data-copy="${esc(v)}" title="Копировать">⧉</button>` : ""}</div>` : "";
  $("#routerInfo").innerHTML = `<div class="kv-list ri">
    ${row("Модель", i.model)}${row("Прошивка", i.firmware)}${row("Ядро", i.kernel)}${row("Имя", i.hostname)}
    ${row("Локальная сеть", i.lan)}${row("Внешний интерфейс", `${i.wanIface} · ${i.wanIP}`)}${row("Шлюз провайдера", i.gateway)}
    ${row("Tailscale", i.tailscale, true)}${row("ZeroTier", i.zerotier, true)}${row("Аренд DHCP", String(i.leases))}
  </div>`;
  $$("#routerInfo [data-copy]").forEach((b) => b.onclick = () => copyText(b.dataset.copy, "Скопировано"));
}
async function loadWifi() {
  let r; try { r = await api("/api/home/system?qr=1"); } catch (e) { $("#wifiList").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  sysInfo = r.router || null; renderRouterStats();
  const list = (r.wifi || []).filter((w) => !w.disabled);
  $("#wifiList").innerHTML = list.map((w, i) => `<div class="card wifi">
      <div class="wifi-qr ${wifiShown[i] ? "" : "blur"}" data-wq="${i}">${w.qr || ""}<span class="tap">${wifiShown[i] ? "" : "нажмите, чтобы показать"}</span></div>
      <div class="wifi-info"><div class="mono-label">${esc(w.band || "Wi-Fi")}</div><h4>${esc(w.ssid)}</h4>
        <code class="pw">${wifiShown[i] ? esc(w.key || "без пароля") : "••••••••••"}</code>
        <div class="kv-btns"><button class="btn btn-sm" data-wa="show" data-i="${i}">${wifiShown[i] ? "Скрыть" : "Показать"}</button>${w.key ? `<button class="btn btn-sm" data-wa="copy" data-i="${i}">Копировать</button>` : ""}</div>
        <p class="muted small">Гость наводит камеру iPhone на QR — и сразу подключается.</p></div>
    </div>`).join("") || `<p class="muted">Нет включённых сетей.</p>`;
  $$("[data-wa]").forEach((b) => b.onclick = () => { const i = b.dataset.i; if (b.dataset.wa === "copy") copyText(list[i].key, "Пароль Wi-Fi скопирован"); else { wifiShown[i] = !wifiShown[i]; loadWifi(); } });
  $$("[data-wq]").forEach((q) => q.onclick = () => { const i = q.dataset.wq; if (!wifiShown[i]) { wifiShown[i] = true; loadWifi(); } });
}

// ---------- сеть: имена и Wake-on-LAN ----------
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-cl]"); if (!b) return;
  const c = clients.find((x) => x.mac === b.dataset.mac); if (!c) return;
  if (b.dataset.cl === "rename") {
    openForm('<span class="acc">// СЕТЬ</span>', "Имя устройства", `<form class="form" id="cnForm">
      <p class="muted small mono">${esc(c.ip)} · ${esc(c.mac)}${c.vendor ? " · " + esc(c.vendor) : ""}</p>
      <label>Как назвать<input class="field" id="cnName" value="${esc(c.source === "custom" ? c.name : "")}" placeholder="${esc(c.name || "Телевизор в зале")}"></label>
      <p class="muted small">Пустое поле — вернуть имя, которое прислало само устройство.</p>
      <div class="form-acts"><button class="btn btn-acc">Сохранить</button></div></form>`, () => {
      $("#cnForm").onsubmit = async (ev) => { ev.preventDefault(); try { await post("/api/home/client-name", { mac: c.mac, name: $("#cnName").value }); closeForm(); toast("Сохранено"); loadClients(); netViz.update(); } catch (er) { toast(er.message, true); } };
    });
  }
  if (b.dataset.cl === "wol") {
    if (!(await askConfirm({ icon: "⏻", title: `Разбудить «${c.name || c.ip}»?`, text: "Отправлю пакет Wake-on-LAN. Сработает, если устройство это поддерживает и подключено кабелем.", yes: "Разбудить" }))) return;
    try { await post("/api/home/system", { action: "wol", mac: c.mac }); toast("Пакет отправлен"); } catch (er) { toast(er.message, true); }
  }
});
