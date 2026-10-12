"use strict";
// ZALET HOME — менеджер паролей. Расшифровка на роутере только по мастер-паролю, мастер-пароль нигде не хранится.

// копирование работает и без https (navigator.clipboard на http недоступен)
function copyText(text, what = "Скопировано") {
  const done = () => { toast(what + " ✓"); buzz(10); };
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, () => fallback()); return; }
  fallback();
  function fallback() {
    const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    try { document.execCommand("copy"); done(); } catch (e) { toast("Не удалось скопировать", true); }
    ta.remove();
  }
}
function download(name, text, type = "text/plain") {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---------- генератор ----------
const WORDS = "ветер камин пледик чайник облако снег берёза кот лиса сова клён мёд печка ёлка луна звезда река море остров маяк поезд радуга капля гром весна осень лето зима утро вечер свеча книга кофе какао шарф варежка тропа горка санки огонь искра дрова окно крыша дом сад".split(" ");
const TRANS = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
const rnd = (n) => { const a = new Uint32Array(1); const lim = Math.floor(0x100000000 / n) * n; do { crypto.getRandomValues(a); } while (a[0] >= lim); return a[0] % n; };
const genOpts = (() => { try { return JSON.parse(localStorage.getItem("zh-gen")) || null; } catch (e) { return null; } })() ||
  { mode: "chars", len: 20, upper: true, lower: true, digits: true, symbols: true, ambiguous: true, words: 4, sep: "-" };
function generate(o = genOpts) {
  if (o.mode === "words") {
    const w = Array.from({ length: o.words }, () => { const x = WORDS[rnd(WORDS.length)].replace(/./g, (c) => TRANS[c] ?? c); return x[0].toUpperCase() + x.slice(1); });
    w[rnd(w.length)] += rnd(100);
    return w.join(o.sep);
  }
  let sets = [];
  const amb = o.ambiguous ? /[O0Il1|`'"]/g : null;
  if (o.upper) sets.push("ABCDEFGHIJKLMNOPQRSTUVWXYZ"); if (o.lower) sets.push("abcdefghijklmnopqrstuvwxyz");
  if (o.digits) sets.push("0123456789"); if (o.symbols) sets.push("!@#$%^&*()-_=+[]{};:,.?/~");
  if (!sets.length) sets = ["abcdefghijklmnopqrstuvwxyz"];
  if (amb) sets = sets.map((s) => s.replace(amb, ""));
  const all = sets.join("");
  const out = sets.map((s) => s[rnd(s.length)]); // хотя бы по одному из каждого набора
  while (out.length < o.len) out.push(all[rnd(all.length)]);
  for (let i = out.length - 1; i > 0; i--) { const j = rnd(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.slice(0, o.len).join("");
}
function strength(p) {
  if (!p) return { score: 0, label: "пусто", bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26; if (/[A-Z]/.test(p)) pool += 26; if (/\d/.test(p)) pool += 10; if (/[^a-zA-Z0-9]/.test(p)) pool += 30; if (/[а-яё]/i.test(p)) pool += 33;
  let bits = p.length * Math.log2(pool || 1);
  if (/^(.)\1+$/.test(p) || /^(123|qwe|pass|парол|admin)/i.test(p)) bits = Math.min(bits, 20);
  const score = bits < 36 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { score, bits: Math.round(bits), label: ["пусто", "слабый", "средний", "хороший", "надёжный"][score] };
}
const meter = (p) => { const s = strength(p); return `<div class="meter s${s.score}"><i></i><i></i><i></i><i></i></div><span class="meter-l">${s.label}${s.bits ? ` · ${s.bits} бит` : ""}</span>`; };

function genPanel(onUse) {
  const o = genOpts;
  const html = `<div class="gen">
    <div class="gen-out"><code id="genOut"></code><button class="icon-btn" id="genAgain" title="Ещё">↻</button><button class="icon-btn" id="genCopy" title="Копировать">⧉</button></div>
    <div class="gen-meter" id="genMeter"></div>
    <div class="seg" id="genMode"><button data-m="chars" class="${o.mode === "chars" ? "active" : ""}">Символы</button><button data-m="words" class="${o.mode === "words" ? "active" : ""}">Слова</button></div>
    <div class="gen-chars ${o.mode === "chars" ? "" : "hidden"}">
      <div class="range-row"><span>ДЛИНА <b id="genLenV">${o.len}</b></span><input type="range" id="genLen" min="8" max="64" value="${o.len}"></div>
      <div class="gen-flags">${[["upper", "A–Z"], ["lower", "a–z"], ["digits", "0–9"], ["symbols", "!@#"], ["ambiguous", "без O0Il1"]].map(([k, l]) => `<label class="flag"><input type="checkbox" data-gf="${k}" ${o[k] ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>
    </div>
    <div class="gen-words ${o.mode === "words" ? "" : "hidden"}">
      <div class="range-row"><span>СЛОВ <b id="genWordsV">${o.words}</b></span><input type="range" id="genWords" min="3" max="8" value="${o.words}"></div>
      <div class="gen-flags">${["-", ".", "_", " "].map((s) => `<label class="flag"><input type="radio" name="gsep" value="${s}" ${o.sep === s ? "checked" : ""}><span>${s === " " ? "пробел" : s}</span></label>`).join("")}</div>
    </div>
    ${onUse ? `<button class="btn btn-acc" id="genUse">Использовать этот пароль</button>` : ""}
  </div>`;
  const bind = (root) => {
    const upd = () => { const p = generate(); $("#genOut", root).textContent = p; $("#genMeter", root).innerHTML = meter(p); try { localStorage.setItem("zh-gen", JSON.stringify(genOpts)); } catch (e) {} };
    $("#genAgain", root).onclick = upd;
    $("#genCopy", root).onclick = () => copyText($("#genOut", root).textContent, "Пароль скопирован");
    $$("#genMode button", root).forEach((b) => b.onclick = () => { genOpts.mode = b.dataset.m; $$("#genMode button", root).forEach((x) => x.classList.toggle("active", x === b));
      $(".gen-chars", root).classList.toggle("hidden", genOpts.mode !== "chars"); $(".gen-words", root).classList.toggle("hidden", genOpts.mode !== "words"); upd(); });
    $("#genLen", root).oninput = (e) => { genOpts.len = +e.target.value; $("#genLenV", root).textContent = genOpts.len; upd(); };
    $("#genWords", root).oninput = (e) => { genOpts.words = +e.target.value; $("#genWordsV", root).textContent = genOpts.words; upd(); };
    $$("[data-gf]", root).forEach((c) => c.onchange = () => { genOpts[c.dataset.gf] = c.checked; upd(); });
    $$("[name=gsep]", root).forEach((c) => c.onchange = () => { genOpts.sep = c.value; upd(); });
    if (onUse) $("#genUse", root).onclick = () => onUse($("#genOut", root).textContent);
    upd();
  };
  return { html, bind };
}

// ---------- универсальная форма ----------
function openForm(label, title, html, bind) {
  $("#formLabel").innerHTML = label; $("#formTitle").textContent = title; $("#formBody").innerHTML = html;
  $("#formModal").classList.remove("hidden"); bind && bind($("#formBody"));
  const f = $("#formBody input:not([type=checkbox]):not([type=range]):not([type=radio]), #formBody textarea"); if (f && window.innerWidth > 700) setTimeout(() => f.focus(), 60);
}
function closeForm() { $("#formModal").classList.add("hidden"); $("#formBody").innerHTML = ""; }
$("#formClose").onclick = closeForm;
$("#formModal").addEventListener("mousedown", (e) => { if (e.target.id === "formModal") closeForm(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#formModal").classList.contains("hidden")) closeForm(); });

// ---------- хранилище ----------
const V = { token: "", items: [], exists: null, folder: "*", q: "", sort: "title", open: null, reveal: {}, lockAt: 0, totp: {} };
try { V.token = sessionStorage.getItem("zh-vault") || ""; V.sort = localStorage.getItem("zh-vsort") || "title"; } catch (e) {}
async function vapi(body) {
  const r = await fetch("/api/home/passwords", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Vault": V.token }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.locked) { vaultLocked(); throw Object.assign(new Error("Хранилище заблокировано"), { silent: true }); }
  if (r.status === 401 && !j.error) { showLock(); throw new Error("Нужен вход"); }
  if (!r.ok) throw Object.assign(new Error(j.error || "Ошибка " + r.status), { data: j });
  if (j.vault) { V.token = j.vault; try { sessionStorage.setItem("zh-vault", V.token); } catch (e) {} }
  if (j.items) V.items = j.items;
  V.lockAt = Date.now() + (j.lockAfter || 600) * 1000;
  return j;
}
function vaultLocked() {
  V.token = ""; V.items = []; V.reveal = {}; try { sessionStorage.removeItem("zh-vault"); } catch (e) {}
  clearInterval(timers.vtick); renderVault();
}
async function loadVault() {
  try {
    const st = await vapi({ action: "status" });
    V.exists = st.exists;
    if (st.unlocked) { await vapi({ action: "list" }); startVaultTick(); }
    else V.token = "";
  } catch (e) { if (!e.silent) { $("#vaultBody").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; } }
  renderVault();
}
function startVaultTick() {
  clearInterval(timers.vtick);
  timers.vtick = setInterval(() => {
    const left = Math.max(0, Math.round((V.lockAt - Date.now()) / 1000));
    const el = $("#vLockLeft"); if (el) el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (left <= 0) { vaultLocked(); toast("Хранилище заблокировано автоматически"); }
    Object.entries(V.totp).forEach(([id, t]) => { t.left--; const e = $(`[data-totp-left="${id}"]`); if (e) e.style.setProperty("--p", Math.max(0, t.left) / 30); if (t.left <= 0) { delete V.totp[id]; fetchTotp(id); } });
  }, 1000);
}
["click", "keydown"].forEach((ev) => document.addEventListener(ev, () => { if (V.token && page === "vault") V.lockAt = Math.max(V.lockAt, Date.now() + 9.5 * 60000); }, { passive: true }));

function renderVault() {
  const head = $("#vaultHead"), body = $("#vaultBody");
  if (V.exists === null) { body.innerHTML = `<div class="spinner"></div>`; return; }
  if (!V.exists) {
    head.innerHTML = "";
    body.innerHTML = `<div class="card vault-gate">
      <div class="gate-ico">⚿</div>
      <h3 class="display">СОЗДАТЬ ХРАНИЛИЩЕ</h3>
      <p class="muted">Придумайте мастер-пароль — им шифруется всё содержимое (AES-256). Он нигде не сохраняется: если забыть, восстановить пароли будет невозможно.</p>
      <input class="field" type="password" id="vNew" placeholder="Мастер-пароль (от 8 символов)" autocomplete="new-password">
      <div class="gen-meter" id="vNewMeter">${meter("")}</div>
      <input class="field" type="password" id="vNew2" placeholder="Повторите мастер-пароль" autocomplete="new-password">
      <button class="btn btn-acc" id="vCreate">Создать хранилище</button>
      <p class="err" id="vErr"></p></div>`;
    $("#vNew").oninput = (e) => $("#vNewMeter").innerHTML = meter(e.target.value);
    $("#vCreate").onclick = async () => {
      const a = $("#vNew").value, b = $("#vNew2").value;
      if (a.length < 8) return $("#vErr").textContent = "Минимум 8 символов";
      if (a !== b) return $("#vErr").textContent = "Пароли не совпадают";
      $("#vCreate").disabled = true;
      try { await vapi({ action: "setup", master: a }); V.exists = true; startVaultTick(); toast("Хранилище создано"); renderVault(); }
      catch (e) { $("#vErr").textContent = e.message; $("#vCreate").disabled = false; }
    };
    return;
  }
  if (!V.token) {
    head.innerHTML = "";
    body.innerHTML = `<div class="card vault-gate">
      <div class="gate-ico locked">⚿</div>
      <h3 class="display">ХРАНИЛИЩЕ ЗАКРЫТО</h3>
      <p class="muted">Введите мастер-пароль. Через 10 минут без действий хранилище закроется само.</p>
      <form id="vUnlockForm" autocomplete="off"><input class="field" type="password" id="vMaster" placeholder="Мастер-пароль" autocomplete="current-password">
      <button class="btn btn-acc" id="vUnlock">Открыть</button></form>
      <p class="err" id="vErr"></p></div>`;
    $("#vUnlockForm").onsubmit = async (e) => {
      e.preventDefault();
      const m = $("#vMaster").value; if (!m) return;
      $("#vUnlock").disabled = true; $("#vUnlock").textContent = "Расшифровываю…";
      try { await vapi({ action: "unlock", master: m }); startVaultTick(); buzz(20); renderVault(); }
      catch (er) {
        $(".vault-gate").classList.add("shake"); setTimeout(() => $(".vault-gate")?.classList.remove("shake"), 500); buzz([40, 60, 40]);
        $("#vErr").textContent = er.data?.locked ? `Слишком много попыток · подождите ${er.data.locked} с` : er.message;
        $("#vUnlock").disabled = false; $("#vUnlock").textContent = "Открыть"; $("#vMaster").select();
      }
    };
    return;
  }
  head.innerHTML = `<span class="pill" title="Автоблокировка">🔓 <span id="vLockLeft">10:00</span></span>
    <button class="btn btn-sm" id="vGen">✦ Генератор</button>
    <button class="btn btn-sm" id="vMore">⋯</button>
    <button class="btn btn-sm" id="vLock">Заблокировать</button>
    <button class="btn btn-sm btn-acc" id="vAdd">＋ Добавить</button>`;
  $("#vAdd").onclick = () => editEntry(null);
  $("#vLock").onclick = async () => { try { await vapi({ action: "lock" }); } catch (e) {} vaultLocked(); };
  $("#vGen").onclick = () => { const g = genPanel(); openForm('<span class="acc">// ГЕНЕРАТОР</span>', "Новый пароль", g.html, g.bind); };
  $("#vMore").onclick = vaultMenu;
  renderVaultList();
}
function folders() {
  const m = {}; V.items.forEach((it) => { const f = it.folder || ""; m[f] = (m[f] || 0) + 1; });
  return m;
}
function hostOf(u) { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }
function avatar(it) {
  const s = (it.title || hostOf(it.url) || "?").trim();
  let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="av" style="--h:${h}">${esc(s[0].toUpperCase())}</span>`;
}
function renderVaultList() {
  const body = $("#vaultBody");
  const fm = folders();
  const names = Object.keys(fm).filter(Boolean).sort((a, b) => a.localeCompare(b, "ru"));
  const favs = V.items.filter((i) => i.fav).length;
  const weak = V.items.filter((i) => i.password && strength(i.password).score < 2).length;
  const dupMap = {}; V.items.forEach((i) => { if (i.password) dupMap[i.password] = (dupMap[i.password] || 0) + 1; });
  const dups = V.items.filter((i) => i.password && dupMap[i.password] > 1).length;
  const groupBtn = (k, label, n, ico = "") => `<button class="grp ${V.folder === k ? "active" : ""}" data-folder="${esc(k)}">${ico ? `<i>${ico}</i>` : ""}<span>${esc(label)}</span><b>${n}</b></button>`;
  let list = V.items.filter((it) => V.folder === "*" ? true : V.folder === "★" ? it.fav : V.folder === "⚠" ? (it.password && (strength(it.password).score < 2 || dupMap[it.password] > 1)) : (it.folder || "") === V.folder);
  const q = V.q.toLowerCase();
  if (q) list = list.filter((it) => [it.title, it.username, it.url, it.note, it.folder].join(" ").toLowerCase().includes(q));
  const cmp = { title: (a, b) => (a.title || "").localeCompare(b.title || "", "ru"), updated: (a, b) => (b.updated || 0) - (a.updated || 0), created: (a, b) => (b.created || 0) - (a.created || 0), login: (a, b) => (a.username || "").localeCompare(b.username || "", "ru") }[V.sort];
  list.sort((a, b) => (b.fav - a.fav) || cmp(a, b));
  if (V.open && !V.items.find((i) => i.id === V.open)) V.open = null;
  body.innerHTML = `<div class="vault">
    <aside class="groups">
      ${groupBtn("*", "Все записи", V.items.length, "▤")}
      ${groupBtn("★", "Избранное", favs, "★")}
      ${weak + dups ? groupBtn("⚠", "Проверить", weak + dups, "⚠") : ""}
      <div class="mono-label grp-h">ГРУППЫ</div>
      ${names.map((n) => groupBtn(n, n, fm[n], "▸")).join("")}
      ${fm[""] && names.length ? groupBtn("", "Без группы", fm[""], "·") : ""}
      ${names.length ? "" : `<p class="muted small grp-empty">Группа задаётся при добавлении записи: «Почта», «Банки», «Игры»…</p>`}
    </aside>
    <div class="vlist">
      <div class="vtools"><input class="search" id="vSearch" placeholder="Поиск: название, логин, сайт, заметка" value="${esc(V.q)}">
        <select class="search sel" id="vSort">${[["title", "По названию"], ["updated", "Недавно изменённые"], ["created", "Недавно добавленные"], ["login", "По логину"]].map(([k, l]) => `<option value="${k}" ${V.sort === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="ventries">${list.map(entryRow).join("") || `<div class="vempty"><div class="gate-ico">⚿</div><p class="muted">${V.items.length ? "Ничего не найдено" : "Пока пусто. Нажмите «＋ Добавить» — или импортируйте пароли из браузера через ⋯"}</p></div>`}</div>
    </div>
  </div>`;
  $$("[data-folder]").forEach((b) => b.onclick = () => { V.folder = b.dataset.folder; renderVaultList(); });
  $("#vSearch").oninput = (e) => { V.q = e.target.value; const pos = e.target.selectionStart; renderVaultList(); const s = $("#vSearch"); s.focus(); s.setSelectionRange(pos, pos); };
  $("#vSort").onchange = (e) => { V.sort = e.target.value; try { localStorage.setItem("zh-vsort", V.sort); } catch (er) {} renderVaultList(); };
  $$("[data-entry]").forEach((row) => row.querySelector(".ve-main").onclick = () => { V.open = V.open === row.dataset.entry ? null : row.dataset.entry; renderVaultList(); if (V.open && V.items.find((i) => i.id === V.open)?.totp) fetchTotp(V.open); });
  $$("[data-vact]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); entryAction(b.dataset.vact, b.closest("[data-entry]").dataset.entry); });
}
function entryRow(it) {
  const open = V.open === it.id, rev = V.reveal[it.id];
  const host = hostOf(it.url);
  const s = strength(it.password);
  const t = V.totp[it.id];
  return `<div class="ve ${open ? "open" : ""}" data-entry="${it.id}">
    <div class="ve-main">${avatar(it)}
      <div class="ve-t"><b>${it.fav ? '<span class="star">★</span> ' : ""}${esc(it.title || host || "Без названия")}</b><span>${esc(it.username || host || "")}${it.folder ? ` · <em>${esc(it.folder)}</em>` : ""}</span></div>
      <div class="ve-q">
        ${it.username ? `<button class="icon-btn" data-vact="cu" title="Копировать логин">👤</button>` : ""}
        ${it.password ? `<button class="icon-btn" data-vact="cp" title="Копировать пароль">⧉</button>` : ""}
        ${it.url ? `<button class="icon-btn" data-vact="go" title="Открыть сайт">↗</button>` : ""}
      </div>
    </div>
    ${open ? `<div class="ve-det">
      ${it.username ? `<div class="kv"><span class="mono-label">ЛОГИН</span><code>${esc(it.username)}</code><button class="btn btn-sm" data-vact="cu">Копировать</button></div>` : ""}
      ${it.password ? `<div class="kv"><span class="mono-label">ПАРОЛЬ</span><code class="pw">${rev ? esc(it.password) : "•".repeat(Math.min(16, it.password.length))}</code>
        <button class="btn btn-sm" data-vact="rv">${rev ? "Скрыть" : "Показать"}</button><button class="btn btn-sm" data-vact="cp">Копировать</button></div>
        <div class="kv"><span class="mono-label">НАДЁЖНОСТЬ</span><div class="gen-meter">${meter(it.password)}</div></div>` : ""}
      ${it.totp ? `<div class="kv"><span class="mono-label">КОД 2FA</span><code class="totp">${t ? t.code.replace(/(\d{3})(\d{3})/, "$1 $2") : "······"}</code><i class="ring" data-totp-left="${it.id}" style="--p:${t ? t.left / 30 : 0}"></i><button class="btn btn-sm" data-vact="ct">Копировать</button></div>` : ""}
      ${it.url ? `<div class="kv"><span class="mono-label">САЙТ</span><a class="link" href="${esc(/^[a-z]+:\/\//i.test(it.url) ? it.url : "https://" + it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.url)} ↗</a></div>` : ""}
      ${it.note ? `<div class="kv note"><span class="mono-label">ЗАМЕТКА</span><p>${esc(it.note).replace(/\n/g, "<br>")}</p></div>` : ""}
      <div class="kv meta mono-label">${it.created ? `СОЗДАНО ${new Date(it.created * 1000).toLocaleDateString("ru-RU")} · ` : ""}ИЗМЕНЕНО ${ago(it.updated).toUpperCase()}${s.score && s.score < 2 ? ' · <span class="warn">СЛАБЫЙ ПАРОЛЬ</span>' : ""}</div>
      <div class="ve-acts"><button class="btn btn-sm" data-vact="fav">${it.fav ? "★ Убрать из избранного" : "☆ В избранное"}</button>
        <button class="btn btn-sm" data-vact="dup">Копия</button><button class="btn btn-sm" data-vact="edit">✎ Изменить</button><button class="btn btn-sm btn-danger" data-vact="del">Удалить</button></div>
    </div>` : ""}
  </div>`;
}
async function fetchTotp(id) {
  try { const r = await vapi({ action: "totp", entry: { id } }); V.totp[id] = { code: r.code, left: r.left }; if (V.open === id) renderVaultList(); }
  catch (e) { if (!e.silent) toast(e.message, true); }
}
async function entryAction(act, id) {
  const it = V.items.find((i) => i.id === id); if (!it) return;
  if (act === "cu") copyText(it.username, "Логин скопирован");
  if (act === "cp") copyText(it.password, "Пароль скопирован");
  if (act === "ct" && V.totp[id]) copyText(V.totp[id].code, "Код скопирован");
  if (act === "go") window.open(/^[a-z]+:\/\//i.test(it.url) ? it.url : "https://" + it.url, "_blank", "noopener,noreferrer");
  if (act === "rv") { V.reveal[id] = !V.reveal[id]; renderVaultList(); }
  if (act === "edit") editEntry(it);
  if (act === "dup") editEntry({ ...it, id: "", title: (it.title || "") + " (копия)" });
  if (act === "fav") { try { await vapi({ action: "save", entry: { ...it, fav: !it.fav } }); renderVaultList(); } catch (e) { if (!e.silent) toast(e.message, true); } }
  if (act === "del") {
    if (!(await askConfirm({ icon: "⚿", title: "Удалить запись?", text: `«${it.title || hostOf(it.url)}» удалится из хранилища. Резервная копия прошлой версии останется на роутере.`, yes: "Удалить", danger: true }))) return;
    try { await vapi({ action: "delete", entry: { id } }); V.open = null; toast("Удалено"); renderVaultList(); } catch (e) { if (!e.silent) toast(e.message, true); }
  }
}
function editEntry(it) {
  const e = it || { title: "", username: "", password: "", url: "", note: "", folder: V.folder !== "*" && V.folder !== "★" && V.folder !== "⚠" ? V.folder : "", fav: false, totp: "" };
  const fl = Object.keys(folders()).filter(Boolean);
  const g = genPanel((p) => { $("#fPass").value = p; $("#fPass").type = "text"; $("#fMeter").innerHTML = meter(p); $("#fGenBox").classList.add("hidden"); });
  openForm(`<span class="acc">// ${it?.id ? "ИЗМЕНИТЬ" : "НОВАЯ ЗАПИСЬ"}</span>`, it?.id ? (it.title || "Запись") : "Новый пароль", `
    <form id="entryForm" class="form" autocomplete="off">
      <label>Название<input class="field" id="fTitle" value="${esc(e.title)}" placeholder="Госуслуги, Почта, Steam…" maxlength="120"></label>
      <label>Сайт или ссылка<input class="field" id="fUrl" value="${esc(e.url)}" placeholder="https://… — откуда этот пароль" inputmode="url"></label>
      <label>Логин / почта / телефон<input class="field" id="fUser" value="${esc(e.username)}" autocomplete="off"></label>
      <label>Пароль<div class="pw-row"><input class="field mono" id="fPass" type="password" value="${esc(e.password)}" autocomplete="new-password">
        <button type="button" class="icon-btn" id="fEye" title="Показать">👁</button><button type="button" class="icon-btn" id="fGen" title="Сгенерировать">✦</button></div>
        <div class="gen-meter" id="fMeter">${meter(e.password)}</div></label>
      <div id="fGenBox" class="hidden">${g.html}</div>
      <label>Группа<input class="field" id="fFolder" value="${esc(e.folder)}" list="folderList" placeholder="Почта, Банки, Работа…"><datalist id="folderList">${fl.map((f) => `<option value="${esc(f)}">`).join("")}</datalist></label>
      ${fl.length ? `<div class="chips small-chips">${fl.map((f) => `<button type="button" class="chip" data-pf="${esc(f)}">${esc(f)}</button>`).join("")}</div>` : ""}
      <label>Ключ 2FA (необязательно)<input class="field mono" id="fTotp" value="${esc(e.totp || "")}" placeholder="base32-ключ или otpauth://… — будут коды как в Google Authenticator"></label>
      <label>Заметка / подпись<textarea class="field" id="fNote" rows="3" placeholder="Секретный вопрос, PIN карты, кому выдан доступ…">${esc(e.note)}</textarea></label>
      <label class="flag fav-flag"><input type="checkbox" id="fFav" ${e.fav ? "checked" : ""}><span>★ В избранное</span></label>
      <div class="form-acts"><button type="button" class="btn" id="fCancel">Отмена</button><button class="btn btn-acc" id="fSave">Сохранить</button></div>
    </form>`, (root) => {
    $("#fEye").onclick = () => { const p = $("#fPass"); p.type = p.type === "password" ? "text" : "password"; };
    $("#fGen").onclick = () => { const b = $("#fGenBox"); b.classList.toggle("hidden"); if (!b.dataset.bound) { g.bind(b); b.dataset.bound = 1; } };
    $("#fPass").oninput = (ev) => $("#fMeter").innerHTML = meter(ev.target.value);
    $("#fCancel").onclick = closeForm;
    $$("[data-pf]", root).forEach((c) => c.onclick = () => { $("#fFolder").value = c.dataset.pf; });
    $("#fUrl").onblur = () => { if (!$("#fTitle").value && $("#fUrl").value) { const h = hostOf($("#fUrl").value); $("#fTitle").value = h ? h[0].toUpperCase() + h.slice(1) : ""; } };
    $("#entryForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const entry = { ...e, title: $("#fTitle").value.trim(), url: $("#fUrl").value.trim(), username: $("#fUser").value.trim(), password: $("#fPass").value,
        folder: $("#fFolder").value.trim(), note: $("#fNote").value, totp: $("#fTotp").value.trim(), fav: $("#fFav").checked };
      if (!entry.title && !entry.url) { toast("Укажите название или сайт", true); return; }
      $("#fSave").disabled = true;
      try { await vapi({ action: "save", entry }); closeForm(); toast("Сохранено"); if (!e.id) { const n = V.items[V.items.length - 1]; if (n) V.open = n.id; } renderVaultList(); }
      catch (er) { $("#fSave").disabled = false; if (!er.silent) toast(er.message, true); }
    };
  });
}
function vaultMenu() {
  openForm('<span class="acc">// ХРАНИЛИЩЕ</span>', "Настройки", `<div class="menu-list">
    <button class="btn" id="mImport">⤒ Импорт из браузера (CSV)</button>
    <button class="btn" id="mExport">⤓ Экспорт в CSV</button>
    <button class="btn" id="mChange">⚿ Сменить мастер-пароль</button>
    <p class="muted small">Импорт понимает CSV из Chrome, Яндекс Браузера, Safari, Firefox, Bitwarden и KeePass (колонки name/title, url, username/login, password, note).
    Хранилище: зашифрованный файл на роутере, резервная копия — рядом.</p></div>
    <input type="file" id="mFile" accept=".csv,text/csv" hidden>`, () => {
    $("#mImport").onclick = () => $("#mFile").click();
    $("#mFile").onchange = async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      const rows = parseCSV(await f.text()); if (rows.length < 2) { toast("Пустой файл", true); return; }
      const h = rows[0].map((x) => x.trim().toLowerCase());
      const col = (...n) => h.findIndex((x) => n.includes(x));
      const ci = { t: col("name", "title", "название"), u: col("url", "login_uri", "website", "web site"), l: col("username", "login", "login_username", "user name", "логин"), p: col("password", "login_password", "пароль"), n: col("note", "notes", "extra", "comments"), f: col("folder", "group", "grouping", "группа"), o: col("totp", "login_totp", "otpauth") };
      if (ci.p < 0) { toast("Не нашёл колонку password", true); return; }
      const items = rows.slice(1).filter((r) => r.length > 1).map((r) => ({ title: r[ci.t] || hostOf(r[ci.u] || ""), url: r[ci.u] || "", username: r[ci.l] || "", password: r[ci.p] || "", note: r[ci.n] || "", folder: r[ci.f] || "Импорт", totp: ci.o >= 0 ? r[ci.o] || "" : "" }));
      if (!(await askConfirm({ icon: "⤒", title: `Импортировать ${items.length}?`, text: "Записи добавятся в группу из файла (или «Импорт»). После импорта удалите CSV-файл — в нём пароли открытым текстом.", yes: "Импортировать" }))) return;
      try { await vapi({ action: "import", items }); closeForm(); toast(`Импортировано: ${items.length}`); renderVaultList(); } catch (er) { if (!er.silent) toast(er.message, true); }
    };
    $("#mExport").onclick = async () => {
      if (!(await askConfirm({ icon: "⤓", title: "Выгрузить пароли открытым текстом?", text: "Файл CSV не зашифрован. Используйте для переноса в другой менеджер и сразу удалите.", yes: "Скачать", danger: true }))) return;
      const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
      download(`zalet-passwords-${new Date().toISOString().slice(0, 10)}.csv`, "﻿name,url,username,password,note,folder,totp\n" + V.items.map((i) => [i.title, i.url, i.username, i.password, i.note, i.folder, i.totp].map(q).join(",")).join("\n"), "text/csv");
    };
    $("#mChange").onclick = () => openForm('<span class="acc">// МАСТЕР-ПАРОЛЬ</span>', "Сменить", `<form class="form" id="chForm">
      <label>Текущий<input class="field" type="password" id="chOld" autocomplete="current-password"></label>
      <label>Новый<input class="field" type="password" id="chNew" autocomplete="new-password"><div class="gen-meter" id="chMeter">${meter("")}</div></label>
      <label>Повторите новый<input class="field" type="password" id="chNew2" autocomplete="new-password"></label>
      <div class="form-acts"><button class="btn btn-acc">Сменить</button></div><p class="err" id="chErr"></p></form>`, () => {
      $("#chNew").oninput = (ev) => $("#chMeter").innerHTML = meter(ev.target.value);
      $("#chForm").onsubmit = async (ev) => {
        ev.preventDefault();
        if ($("#chNew").value !== $("#chNew2").value) return $("#chErr").textContent = "Новые пароли не совпадают";
        try { await vapi({ action: "change", master: $("#chOld").value, next: $("#chNew").value }); closeForm(); toast("Мастер-пароль изменён"); }
        catch (er) { $("#chErr").textContent = er.message; }
      };
    });
  });
}
function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === "," || c === ";" && !text.slice(0, text.indexOf("\n")).includes(",")) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
