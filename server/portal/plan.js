"use strict";
// План дома: мебель и устройства на карте квартиры (карта — с пылесоса Dreame, 1 клетка = 5 см).
// Хранится на роутере (/api/home/plan), рисуется на всех 3D-картах; страница «План дома» — редактор.
// Предмет: { id, t: тип, x, y, w, h — габарит на карте в клетках, r: 0..3 — куда смотрит спинка (север, восток, юг, запад), room — для света }.

// каталог: lw × lh — ширина и глубина модели в клетках (по 5 см), dev — устройство с живым состоянием
window.PL_TYPES = {
  bed: { n: "Кровать", lw: 28, lh: 38, i: "🛏" },
  sofa: { n: "Диванчик", lw: 34, lh: 14, i: "🛋" },
  desk: { n: "Компьютерный стол", lw: 28, lh: 13, i: "🖥" },
  chair: { n: "Офисное кресло", lw: 12, lh: 12, i: "🪑" },
  gchair: { n: "Игровое кресло", lw: 12, lh: 12, i: "🎮" },
  table: { n: "Круглый столик", lw: 16, lh: 16, i: "◯" },
  beanbag: { n: "Кресло-мешок", lw: 15, lh: 15, i: "●" },
  wardrobe: { n: "Шкаф", lw: 28, lh: 12, i: "🚪" },
  mirrorwr: { n: "Зеркало с крючками", lw: 14, lh: 4, i: "🪞" },
  rack: { n: "Вешалка с одеждой", lw: 30, lh: 9, i: "👕" },
  dresser: { n: "Комод", lw: 16, lh: 9, i: "▤" },
  shoes: { n: "Обувница", lw: 12, lh: 5, i: "👟" },
  fridge: { n: "Холодильник", lw: 12, lh: 12, i: "🧊" },
  counter: { n: "Кухня с мойкой", lw: 30, lh: 12, i: "🚰" },
  stove: { n: "Плита", lw: 10, lh: 12, i: "🍳" },
  lowcab: { n: "Тумба", lw: 12, lh: 10, i: "▭" },
  wallcab: { n: "Навесной шкафчик", lw: 12, lh: 6, i: "▭" },
  dryer: { n: "Сушилка с бельём", lw: 28, lh: 11, i: "🧺" },
  bath: { n: "Ванна с душем", lw: 30, lh: 15, i: "🛁" },
  sink: { n: "Раковина", lw: 11, lh: 9, i: "🚿" },
  toilet: { n: "Унитаз", lw: 8, lh: 13, i: "🚽" },
  washer: { n: "Стиральная машина", lw: 12, lh: 11, i: "🌀" },
  radiator: { n: "Батарея", lw: 16, lh: 2, i: "♨" },
  window: { n: "Окно со шторами", lw: 28, lh: 3, i: "🪟", mount: true },
  door: { n: "Входная дверь", lw: 18, lh: 3, i: "🚪", mount: true },
  idoor: { n: "Межкомнатная дверь", lw: 15, lh: 3, i: "🚪", mount: true },
  rug: { n: "Коврик", lw: 14, lh: 10, i: "▬", flat: true },
  dock: { n: "База пылесоса", lw: 7, lh: 9, i: "🤖" },
  humid: { n: "Увлажнитель", lw: 9, lh: 7, i: "💧" },
  power: { n: "Тумба", lw: 8, lh: 6, i: "▣" },
  hookah: { n: "Кальян", lw: 6, lh: 6, i: "💨" },
  fan: { n: "Вентилятор", lw: 7, lh: 7, i: "🌀" },
  scale: { n: "Весы", lw: 6, lh: 6, i: "⚖", flat: true },
  mic: { n: "Микрофон на стойке", lw: 3, lh: 3, i: "🎙" },
  weights: { n: "Блины и гантели", lw: 6, lh: 6, i: "🏋" },
  // устройства
  lamp: { n: "Люстра", lw: 8, lh: 8, dev: "light", i: "💡", air: true },
  bulb: { n: "Лампочка", lw: 4, lh: 4, dev: "light", i: "💡", air: true },
  switch: { n: "Выключатель", lw: 3, lh: 1, dev: "light", i: "🔘", wall: true, mount: true },
  ac: { n: "Кондиционер", lw: 16, lh: 4, dev: "ac", i: "❄", wall: true, mount: true },
  pc: { n: "Компьютер", lw: 5, lh: 10, dev: "pc", i: "💻" },
  router: { n: "Роутер", lw: 6, lh: 4, dev: "router", i: "📶" },
  intercom: { n: "Домофон", lw: 3, lh: 1.5, i: "📞", wall: true, mount: true },
};

// ---------- модели: детали в локальных координатах предмета (u — ширина, v — глубина, v = 0 у стены) ----------
// высота: см → единицы карты; выше 120 см сжимается, чтобы высокая мебель не закрывала комнату
const plZ = (cm) => (cm <= 120 ? cm / 10 : 12 + (cm - 120) / 30);
const plRgbCache = {};
function plRgb(c) {
  if (plRgbCache[c]) return plRgbCache[c];
  let r;
  if (c[0] === "#") { const v = parseInt(c.slice(1), 16); r = [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1]; }
  else { const m = c.match(/[\d.]+/g).map(Number); r = [m[0], m[1], m[2], m[3] ?? 1]; }
  return (plRgbCache[c] = r);
}
function plHash(s) { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return () => ((h = Math.imul(h ^ (h >>> 13), 1274126177)) >>> 0) / 4294967296; }

const PL_MODELS = {
  bed(L) {
    const { lw, lh, Z, box, rbox } = L;
    rbox(0.8, 0.8, lw - 0.8, lh - 0.8, 0, Z(6), "#18181b", 0.6);
    rbox(0, 1.4, lw, lh, Z(6), Z(32), "#3e3e46", 1.1);
    box(lw - 0.05, lh * 0.62, lw + 0.2, lh * 0.62 + 1.8, Z(13), Z(23), "#26262c");
    rbox(0, 0, lw, 2.2, 0, Z(98), "#55555e", 0.9, true);
    rbox(1, 1.9, lw - 1, 2.5, Z(38), Z(92), "#60606a", 0.6, true);
    rbox(0.6, 2.6, lw - 0.6, lh - 0.6, Z(32), Z(51), "#6b5c56", 1.5, true);
    rbox(1.6, 3.3, lw / 2 - 0.5, 9, Z(51), Z(61), "#d9d4ce", 1.8, true);
    rbox(lw / 2 + 0.5, 3.6, lw - 1.6, 9.2, Z(51), Z(60), "#cfc9c2", 1.8, true);
    rbox(3, 12, 16, 27, Z(51), Z(58), "#e6e1db", 4, true);
    rbox(5, 15, 14, 23, Z(58), Z(63), "#f0ece7", 3.2, true);
    rbox(12, 22, 22, 31, Z(51), Z(57), "#ddd7d0", 3.5, true);
    rbox(15, 26, 21, 30, Z(57), Z(60), "#ebe6e0", 2.4, true);
  },
  sofa(L) {
    const { lw, lh, Z, rbox, c } = L;
    rbox(0.5, 0.5, lw - 0.5, lh - 0.5, 0, Z(8), "#16161a", 0.5);
    rbox(0, 0, lw, lh, Z(8), Z(40), "#2e2e34", 0.9);
    rbox(0, 0, lw, 3.8, Z(40), Z(85), "#38383f", 1.2, true);
    rbox(0, 3, 2.8, lh, Z(40), Z(62), "#38383f", 1.1, true); rbox(lw - 2.8, 3, lw, lh, Z(40), Z(62), "#38383f", 1.1, true);
    rbox(2.6, 3.6, lw - 2.6, lh - 0.1, Z(40), Z(50), c("#7a4828"), 1.6, true);
    rbox(3, lh - 0.8, lw - 4, lh + 0.3, Z(20), Z(50), c("#6b3e22"), 0.4);
    rbox(4, 6, 13, 11, Z(50), Z(54), c("#8a5532"), 2, true);
    rbox(3.2, 3.8, 9.5, 8.6, Z(50), Z(62), "#8b5a35", 1.8, true);
    rbox(lw - 13, 6, lw - 6, 11.5, Z(50), Z(58), "rgba(232,232,238,.92)", 1.6, true);
  },
  desk(L) {
    const { lw, lh, Z, box, cyl, halo, st } = L, t1 = Z(72), t2 = Z(76), on = !!st.pc;
    box(0, 0, 1.2, lh, 0, t1, "#1c1516"); box(lw - 1.2, 0, lw, lh, 0, t1, "#1c1516"); box(1.2, 0.2, lw - 1.2, 1.1, Z(22), t1, "#171112");
    box(0, 0, lw, lh, t1, t2, "#2a1c1e", { f: "#8a1f24", l: "#8a1f24", r: "#8a1f24" });
    const m = lw / 2 + 2;
    box(m - 2, 1.6, m + 2, 4, t2, t2 + 0.25, "#202024");
    box(m - 0.35, 2.2, m + 0.35, 2.9, t2, Z(96), "#202024");
    box(m - 6.6, 2.8, m + 6.6, 3.6, Z(86), Z(118), "#131316", { f: on ? "#3f63d6" : "#1d1f26" });
    if (on) halo(m, 4, Z(102), 9, "rgba(90,130,255,.30)");
    box(m - 6, 5.8, m + 8, 9.4, t2, t2 + 0.06, "#26262b");
    box(m - 5, 6.4, m + 4, 8.6, t2 + 0.06, t2 + 0.3, "#18181b");
    box(m + 5.5, 6.6, m + 7, 8.6, t2 + 0.06, t2 + 0.4, "#18181b");
    cyl(lw - 3.2, 9, 0.8, 0.8, t2, t2 + 2.2, "#d7dde0"); cyl(lw - 5, 10.5, 0.6, 0.6, t2, t2 + 1.2, "#3d8ad8");
    cyl(lw - 2.4, 4, 1.4, 1.4, t2, t2 + 0.5, "#2b2b30");
  },
  pc(L) {
    const { lw, lh, Z, box, poly, halo, on } = L, z0 = Z(76), z1 = z0 + 4.8;
    box(0, 0, lw, lh, z0, z1, "#141417", { r: on ? "#3a0b0d" : "#1f1f25", f: "#18181c" });
    box(0.4, 0.6, lw - 0.4, lh - 0.6, z1, z1 + 0.06, "#0d0d10");
    if (on) {
      for (const v of [2.2, 5, 7.8]) {
        const pts = []; for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; pts.push([lw + 0.05, v + Math.cos(a) * 1.15, z0 + 2.4 + Math.sin(a) * 1.15]); }
        poly(pts, "rgba(255,45,45,.95)");
        halo(lw, v, z0 + 2.4, 3.2, "rgba(255,40,40,.55)", 3);
      }
      halo(lw / 2, lh / 2, z0 + 2, 10, "rgba(255,30,30,.22)");
    }
  },
  router(L) {
    const { lw, lh, Z, box, cyl, halo } = L, z0 = Z(76);
    box(0, 0, lw, lh, z0, z0 + 0.9, "#f2f2f2");
    for (const u of [0.8, 2.3, 3.7, 5.2]) cyl(u, 0.5, 0.25, 0.25, z0 + 0.5, z0 + 3.6, "#f6f6f6", { seg: 6 });
    halo(lw / 2, lh, z0 + 0.6, 1.8, "rgba(60,230,140,.95)", 2.5);
  },
  chair(L) {
    const { lw, lh, Z, box, cyl, rbox } = L, c = lw / 2;
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2 - Math.PI / 2, u = c + Math.cos(a) * 5, v = 6.5 + Math.sin(a) * 5; box(Math.min(c, u) - 0.35, Math.min(6.5, v) - 0.35, Math.max(c, u) + 0.35, Math.max(6.5, v) + 0.35, Z(4), Z(7), "#e6e6e6"); cyl(u, v, 0.6, 0.6, 0, Z(4), "#2a2a2e", { seg: 8 }); }
    cyl(c, 6.5, 0.55, 0.55, Z(7), Z(44), "#d6d6d6", { seg: 8 });
    rbox(1.8, 2.6, lw - 1.8, lh - 0.8, Z(44), Z(52), "#8d7c6b", 1.6, true);
    rbox(2.2, 0.9, lw - 2.2, 2.4, Z(56), Z(112), "#7b6d60", 1.4, true);
    rbox(3.6, 0.7, lw - 3.6, 2.2, Z(116), Z(128), "#5d544b", 1, true);
    box(1, 5, 1.8, 9.5, Z(60), Z(63), "#ececec"); box(lw - 1.8, 5, lw - 1, 9.5, Z(60), Z(63), "#ececec");
    box(1.1, 6.8, 1.7, 7.6, Z(52), Z(60), "#ececec"); box(lw - 1.7, 6.8, lw - 1.1, 7.6, Z(52), Z(60), "#ececec");
  },
  gchair(L) {
    const { lw, lh, Z, box, cyl, rbox } = L, c = lw / 2;
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2 - Math.PI / 2, u = c + Math.cos(a) * 5, v = 6.5 + Math.sin(a) * 5; box(Math.min(c, u) - 0.35, Math.min(6.5, v) - 0.35, Math.max(c, u) + 0.35, Math.max(6.5, v) + 0.35, Z(4), Z(7), "#1a1a1d"); }
    cyl(c, 6.5, 0.6, 0.6, Z(7), Z(44), "#2a2a2e", { seg: 8 });
    rbox(1.4, 2.6, lw - 1.4, lh - 0.6, Z(44), Z(54), "#1b1b1f", 1.6, true);
    rbox(1.2, 3, 2.6, lh - 1, Z(50), Z(58), "#9c1c1c", 0.6, true); rbox(lw - 2.6, 3, lw - 1.2, lh - 1, Z(50), Z(58), "#9c1c1c", 0.6, true);
    rbox(1.6, 0.6, lw - 1.6, 3, Z(56), Z(135), "#1b1b1f", 1.4, true);
    box(3, 3, 4.1, 3.14, Z(62), Z(132), "#b81e1e"); box(lw - 4.1, 3, lw - 3, 3.14, Z(62), Z(132), "#b81e1e");
    rbox(4, 2.6, lw - 4, 3.4, Z(118), Z(128), "#2a2a30", 0.5, true);
    box(1, 5, 1.9, 10, Z(62), Z(65), "#202024"); box(lw - 1.9, 5, lw - 1, 10, Z(62), Z(65), "#202024");
  },
  table(L) {
    const { lw, lh, Z, box, cyl } = L, c = lw / 2, d = lh / 2;
    for (const [a, b] of [[-3.6, -3.6], [3.6, -3.6], [3.6, 3.6], [-3.6, 3.6]]) cyl(c + a, d + b, 0.35, 0.35, 0, Z(70), "#c89b62", { seg: 6 });
    cyl(c, d, 0.3, 0.3, Z(40), Z(70), "#3a3a3a", { seg: 6 });
    cyl(c, d, lw / 2, lh / 2, Z(70), Z(73), "#f6f6f4", { seg: 28 });
    box(c - 4.4, d - 2, c - 0.6, d + 1.6, Z(73), Z(78), "rgba(228,230,238,.88)");
    cyl(c + 3, d + 1.6, 2, 2, Z(73), Z(74), "#e6e6e6"); cyl(c + 3, d + 1.6, 1.1, 1.1, Z(74), Z(76.5), "#86b44c");
    box(c + 1.2, d - 4, c + 2.8, d - 1.8, Z(73), Z(85), "#6b3b86");
  },
  beanbag(L) {
    const { lw, lh, Z, box, cyl } = L, c = lw / 2, d = lh / 2;
    cyl(c, d, c, d, 0, Z(16), "#6c6c74", { seg: 26, soft: true });
    cyl(c, d + 0.6, c - 1.2, d - 1.2, Z(16), Z(28), "#77777f", { seg: 26, soft: true });
    cyl(c - 0.6, d + 1.6, c - 3.6, d - 3.8, Z(28), Z(34), "#83838b", { seg: 22, soft: true });
  },
  wardrobe(L) {
    const { lw, lh, Z, box, c } = L, top = Z(215);
    box(0, 0, lw, lh, 0, top, c("#efeeeb"), { f: "#f4f3f0" });
    box(lw / 2 - 0.08, lh - 0.02, lw / 2 + 0.08, lh + 0.06, 0.2, top - 0.2, "#c7c5c1");
    box(lw / 2 - 1.4, lh, lw / 2 - 0.9, lh + 0.4, Z(95), Z(130), "#b4b4b4"); box(lw / 2 + 0.9, lh, lw / 2 + 1.4, lh + 0.4, Z(95), Z(130), "#b4b4b4");
  },
  mirrorwr(L) {
    const { lw, lh, Z, box } = L;
    box(0, 0, lw, lh, 0, Z(200), "#efeeeb");
    box(0.8, lh - 0.05, lw * 0.55, lh + 0.08, Z(12), Z(192), "#aeb9c2");
    box(lw * 0.6, lh, lw - 0.8, lh + 0.6, Z(172), Z(176), "#1e1e22");
    box(lw * 0.62, lh + 0.6, lw - 1.4, lh + 4, Z(78), Z(172), "#18181c"); box(lw * 0.7, lh + 2.5, lw - 2.4, lh + 4.6, Z(95), Z(170), "#2a2a30");
  },
  rack(L) {
    const { lw, lh, Z, box, id } = L, rnd = plHash(id), m = lh / 2;
    box(0, 0, 1.4, lh, 0, Z(4), "#1a1a1d"); box(lw - 1.4, 0, lw, lh, 0, Z(4), "#1a1a1d");
    box(0.4, m - 0.4, 1.1, m + 0.4, Z(4), Z(150), "#222226"); box(lw - 1.1, m - 0.4, lw - 0.4, m + 0.4, Z(4), Z(150), "#222226");
    box(1.1, m - 0.3, lw - 1.1, m + 0.3, Z(146), Z(150), "#2c2c31");
    box(1.4, 1, lw - 1.4, lh - 1, Z(14), Z(16), "#202024");
    box(4, 2, 12, lh - 2, Z(16), Z(24), "#2b2b2f");
    const cols = ["#17171b", "#1f1f24", "#2a2a30", "#141417", "#3b3b43", "#d9d9dd", "#24242a", "#e8e8ea", "#1b1b20", "#4a4a52"];
    for (let u = 1.7; u < lw - 2; u += 1.45) {
      const len = 55 + rnd() * 35, col = cols[Math.floor(rnd() * cols.length)];
      box(u, 0.9, u + 1.2, lh - 0.9, Z(146 - len), Z(145.5), col);
    }
    box(3, 0.8, 17, lh - 0.8, Z(150), Z(160), "#3b4c6a"); box(9, 1.2, 22, lh - 1.5, Z(160), Z(166), "#2a2e38");
  },
  dresser(L) {
    const { lw, lh, Z, box, cyl } = L;
    box(0, 0, lw, lh, 0, Z(80), "#f1f0ed", { f: "#f6f5f2" });
    for (const z of [27, 53]) box(0.3, lh - 0.02, lw - 0.3, lh + 0.06, Z(z), Z(z + 1), "#c9c7c3");
    cyl(3, 3, 0.9, 0.9, Z(80), Z(92), "#2b2b30"); cyl(5.4, 3.6, 0.8, 0.8, Z(80), Z(90), "#e1d3b8"); cyl(7.6, 3, 0.7, 0.7, Z(80), Z(95), "#f5f5f5");
    box(10, 2, 13.2, 5.2, Z(80), Z(84), "#c8b79a");
  },
  shoes(L) {
    const { lw, lh, Z, box, cyl } = L;
    box(0, 0, lw, lh, 0, Z(105), "#f1f0ed", { f: "#f6f5f2" });
    box(0.3, lh - 0.02, lw - 0.3, lh + 0.06, Z(52), Z(53), "#c9c7c3");
    cyl(3, 2.5, 0.6, 0.6, Z(105), Z(119), "#1b1b1b"); cyl(8.5, 2.5, 0.9, 0.9, Z(105), Z(112), "#3a2e28");
    for (const d of [-0.4, 0, 0.4]) box(8.5 + d, 2.4, 8.5 + d + 0.12, 2.6, Z(112), Z(128), "#2a2420");
  },
  fridge(L) {
    const { lw, lh, Z, box, rbox } = L, top = Z(185);
    rbox(0, 0, lw, lh, 0, top, "#ecebe8", 0.6);
    box(0.2, lh - 0.02, lw - 0.2, lh + 0.08, Z(118), Z(120), "#bdbcb8");
    box(lw - 1.7, lh + 0.08, lw - 1.1, lh + 0.5, Z(125), Z(165), "#c4c4c4"); box(lw - 1.7, lh + 0.08, lw - 1.1, lh + 0.5, Z(92), Z(112), "#c4c4c4");
    for (const [u, z, c] of [[3, 150, "#222"], [4.6, 142, "#c33"], [6.4, 152, "#ddd"], [3.6, 128, "#333"]]) box(u, lh + 0.02, u + 1.1, lh + 0.16, Z(z), Z(z + 9), c);
    box(1, 0.4, 3.4, 4, top, top + 0.15, "#1d1d20");
  },
  counter(L) {
    const { lw, lh, Z, box, cyl } = L, s0 = lw * 0.42;
    box(0.3, 0.6, lw - 0.3, lh - 1.2, 0, Z(8), "#232327");
    box(0, 0.3, lw, lh - 0.6, Z(8), Z(86), "#6f747b", { f: "#7c8188" });
    for (let k = 1; k < 3; k++) box((k * lw) / 3 - 0.05, lh - 0.62, (k * lw) / 3 + 0.05, lh - 0.5, Z(10), Z(84), "#55595f");
    box(0, 0, lw, lh, Z(86), Z(90), "#c3c5c8");
    box(s0, 2.2, s0 + 9, 8.6, Z(90), Z(90.15), "#8f959b"); box(s0 + 0.8, 3, s0 + 8.2, 7.8, Z(90.15), Z(90.3), "#5d636a");
    cyl(s0 + 4.5, 1.3, 0.4, 0.4, Z(90), Z(112), "#b8bdc2", { seg: 8 }); box(s0 + 4.2, 1.3, s0 + 4.8, 4, Z(108), Z(112), "#b8bdc2");
    cyl(5, 5, 1.7, 1.7, Z(90), Z(110), "#2b2b30"); box(lw - 6, 2, lw - 1.5, 6, Z(90), Z(98), "rgba(150,200,230,.75)");
    box(0, 0, lw, 6.5, Z(140), Z(205), "#5c2020", { f: "#692525" });
    for (let k = 1; k < 3; k++) box((k * lw) / 3 - 0.05, 6.5, (k * lw) / 3 + 0.05, 6.62, Z(142), Z(203), "#3d1414");
  },
  stove(L) {
    const { lw, lh, Z, box, cyl } = L;
    box(0, 0, lw, lh, 0, Z(85), "#ededed", { f: "#e6e6e6" });
    box(1, lh - 0.02, lw - 1, lh + 0.06, Z(20), Z(60), "#2a2a2e");
    box(1.5, lh + 0.06, lw - 1.5, lh + 0.5, Z(65), Z(68), "#bdbdbd");
    for (const [u, v] of [[2.7, 3.3], [7.3, 3.3], [2.7, 8.7], [7.3, 8.7]]) cyl(u, v, 1.9, 1.9, Z(85), Z(86.2), "#1c1c1e", { seg: 14 });
    cyl(7.3, 8.7, 2.2, 2.2, Z(86.2), Z(100), "#c7b088", { seg: 16 }); cyl(7.3, 8.7, 2.3, 2.3, Z(100), Z(101), "#d9c6a0", { seg: 16 }); cyl(7.3, 8.7, 0.4, 0.4, Z(101), Z(103), "#3a3a3a", { seg: 6 });
    for (let k = 0; k < 4; k++) cyl(1.6 + k * 2.3, lh - 0.6, 0.45, 0.45, Z(85), Z(87), "#444", { seg: 6 });
  },
  lowcab(L) {
    const { lw, lh, Z, box, cyl } = L;
    box(0, 0, lw, lh, 0, Z(85), "#151518", { f: "#1d1d21" });
    box(0, 0, lw, lh, Z(85), Z(88), "#28282d");
    box(1.5, 1.5, 7.5, 7, Z(88), Z(94), "#2ea3d6");
    cyl(lw - 2.2, lh - 2.4, 1.3, 1.3, Z(88), Z(108), "#c9a46a");
  },
  wallcab(L) {
    const { lw, lh, Z, box, rbox } = L;
    box(0, 0, lw, lh, Z(140), Z(200), "#7a2a22", { f: "#8a3027" });
    box(lw / 2 - 0.05, lh - 0.02, lw / 2 + 0.05, lh + 0.08, Z(142), Z(198), "#4e1712");
    rbox(1.5, lh, lw - 3, lh + 1.4, Z(70), Z(150), "#211e24", 0.6, true);
  },
  dryer(L) {
    const { lw, lh, Z, box } = L, top = Z(90);
    for (const [u, v] of [[0, 0], [lw - 0.5, 0], [0, lh - 0.5], [lw - 0.5, lh - 0.5]]) box(u, v, u + 0.5, v + 0.5, 0, top - 0.4, "#c9cdd2");
    box(0, 0, 0.5, lh, top - 0.4, top, "#d0d4d9"); box(lw - 0.5, 0, lw, lh, top - 0.4, top, "#d0d4d9");
    for (let k = 0; k <= 6; k++) { const v = 0.6 + (k * (lh - 1.2)) / 6; box(0.5, v - 0.1, lw - 0.5, v + 0.1, top - 0.3, top, "#dfe2e6"); }
    box(2, 2.2, 10, 2.6, Z(40), top - 0.3, "#5a5a61"); box(11, 4.1, 17, 4.5, Z(58), top - 0.3, "#f0f0f0"); box(18, 6, 25.5, 6.4, Z(52), top - 0.3, "#1a1a1e");
    box(3.5, 7.9, 12, 8.3, Z(60), top - 0.3, "#cacace"); box(13.5, 7.9, 19, 8.3, Z(48), top - 0.3, "#2b2b30"); box(20, 0.8, 27, 4.2, top, top + 0.3, "#222226");
  },
  bath(L) {
    const { lw, lh, Z, box, cyl, rbox, WH } = L;
    rbox(1, 1, lw - 1, lh - 1, 0, Z(6), "#cfcfcf", 1);
    rbox(0, 0, lw, lh, Z(6), Z(55), "#f7f7f7", 1.6);
    rbox(1.3, 1.3, lw - 1.3, lh - 1.3, Z(55), Z(55.1), "#e3e9ee", 2.4);
    rbox(2.6, 2.4, lw - 2.4, lh - 2.4, Z(55.1), Z(55.2), "#cbd5de", 3);
    cyl(lw - 4.5, lh / 2, 0.5, 0.5, Z(55.2), Z(55.3), "#9aa3ab", { seg: 8 });
    cyl(1.4, 0.9, 0.32, 0.32, Z(55), WH - 0.9, "#38383d", { seg: 8 });
    box(1.1, 0.6, 1.7, 5, WH - 0.9, WH - 0.5, "#38383d"); rbox(-0.2, 3.6, 3.6, 7.6, WH - 1.3, WH - 1.0, "#2d2d31", 0.4);
    box(1, 0, 4.5, 0.8, Z(80), Z(84), "#38383d"); cyl(2.8, 1.6, 0.35, 0.35, Z(60), Z(84), "#38383d", { seg: 6 });
    for (const [u, v, r, h, c] of [[4.5, 1.2, 0.6, 15, "#e83e8c"], [5.8, 1.1, 0.5, 13, "#ff7a2a"], [7, 1.2, 0.55, 11, "#a83ad6"], [8.2, 1.1, 0.5, 11, "#2a5bd6"], [9.4, 1.2, 0.6, 14, "#f2c6d8"]]) cyl(u, v, r, r, Z(55), Z(55 + h), c, { seg: 8 });
  },
  sink(L) {
    const { lw, lh, Z, box, cyl } = L, c = lw / 2;
    cyl(c, 3.2, 1.6, 1.4, 0, Z(68), "#f3f3f3", { seg: 14 });
    cyl(c, lh / 2, lw / 2, lh / 2, Z(68), Z(84), "#f8f8f8", { seg: 24 });
    cyl(c, lh / 2 + 0.6, lw / 2 - 1.4, lh / 2 - 1.8, Z(84), Z(84.1), "#dbe2e8", { seg: 20 });
    cyl(c, 1.2, 0.35, 0.35, Z(84), Z(93), "#c0c4c8", { seg: 8 }); box(c - 0.25, 1.2, c + 0.25, 3.2, Z(90), Z(93), "#c0c4c8");
    cyl(1.4, 1.5, 0.8, 0.8, Z(84), Z(99), "#f2f2f2", { seg: 10 }); cyl(lw - 1.4, 1.5, 0.7, 0.7, Z(84), Z(97), "#3a63c8", { seg: 10 });
    cyl(lw - 2, lh - 2, 0.7, 0.7, Z(84), Z(91), "#1c2a44", { seg: 10 });
  },
  toilet(L) {
    const { lw, lh, Z, cyl, rbox } = L, c = lw / 2;
    rbox(0.4, 0, lw - 0.4, 3.6, Z(38), Z(82), "#f6f6f6", 0.8);
    cyl(c, 1.8, 0.6, 0.6, Z(82), Z(82.5), "#cfcfcf", { seg: 10 });
    cyl(c, 7.6, 2.2, 3, 0, Z(38), "#f2f2f2", { seg: 16 });
    cyl(c, 8.1, c - 0.2, 4.6, Z(38), Z(42), "#fafafa", { seg: 22 });
    cyl(c, 8.5, c - 1.6, 3.2, Z(42), Z(42.1), "#d4dbe1", { seg: 18 });
    rbox(0.8, 3.7, lw - 0.8, 4.4, Z(42), Z(88), "#fbfbfb", 0.3);
  },
  washer(L) {
    const { lw, lh, Z, box, poly, rbox } = L;
    rbox(0, 0, lw, lh, 0, Z(85), "#f2f2f2", 0.7);
    box(0.5, lh - 0.02, lw - 0.5, lh + 0.08, Z(72), Z(82), "#e2e2e2");
    const ring = (r, c, dv) => { const p = []; for (let i = 0; i < 22; i++) { const a = (i / 22) * Math.PI * 2; p.push([lw / 2 + Math.cos(a) * r, lh + dv, Z(38) + Math.sin(a) * r * 0.5]); } poly(p, c); };
    ring(3.8, "#d4d8dc", 0.1); ring(2.9, "#3a4552", 0.16);
    box(1.5, 1.5, 8, 4, Z(85), Z(88), "#1c1c1e"); box(7, 1.2, 9.5, 2.4, Z(85), Z(86), "#c78b6a");
  },
  radiator(L) {
    const { lw, lh, Z, box } = L;
    box(0, 0.2, lw, 0.6, Z(10), Z(12), "#dedede");
    for (let u = 0; u < lw - 0.4; u += 1.15) box(u, 0.6, u + 0.85, lh, Z(14), Z(70), "#f2f2f2");
  },
  window(L) {
    const { lw, lh, Z, box, glow, WH, c, cut } = L, zt = WH - 0.2, cur = c("#857f76");
    if (cut) { box(0, 0.1, lw, 0.9, 2.2, 2.7, "rgba(150,205,255,.85)"); box(-1, 0.9, lw + 1, 1.6, 2.2, 2.5, "#f4f4f4"); return; }
    box(-1, 0.4, lw + 1, 3.2, Z(82), Z(86), "#f4f4f4");
    box(0, 0, lw, 1, Z(86), Z(88), "#f4f4f4"); box(0, 0, lw, 1, zt - 0.6, zt, "#f4f4f4");
    box(0, 0, 0.6, 1, Z(88), zt - 0.6, "#f4f4f4"); box(lw - 0.6, 0, lw, 1, Z(88), zt - 0.6, "#f4f4f4"); box(lw / 2 - 0.3, 0, lw / 2 + 0.3, 1, Z(88), zt - 0.6, "#f4f4f4");
    box(0.6, 0.35, lw / 2 - 0.3, 0.65, Z(88), zt - 0.6, "rgba(160,210,255,.38)"); box(lw / 2 + 0.3, 0.35, lw - 0.6, 0.65, Z(88), zt - 0.6, "rgba(160,210,255,.38)");
    box(-6.6, 1.7, lw + 6.6, 2.1, zt, zt + 0.3, "#bdbdbd");
    for (let k = 0; k < 4; k++) { const off = (k % 2) * 0.7; box(-6.2 + k * 1.45, 2.2 + off, -4.6 + k * 1.45, 3.4 + off, 0.1, zt, cur); box(lw + 0.4 + k * 1.45, 2.2 + off, lw + 2 + k * 1.45, 3.4 + off, 0.1, zt, cur); }
    glow(lw / 2, lh + 10, 20, "rgba(175,215,255,.10)");
  },
  door(L) {
    const { lw, lh, Z, box, WH, cut } = L, zt = WH - 0.2;
    if (cut) { box(-1.2, 0, 0, 1.8, 0, 2.6, "#7a2219"); box(lw, 0, lw + 1.2, 1.8, 0, 2.6, "#7a2219"); box(0, 0, lw, 1.3, 0, 2.4, "#3a1c17"); return; }
    box(-1.2, 0, 0, 1.8, 0, zt, "#7a2219"); box(lw, 0, lw + 1.2, 1.8, 0, zt, "#7a2219"); box(0, 0, lw, 1.8, zt - 0.9, zt, "#7a2219");
    box(0, 0, lw, 1.3, 0, zt - 0.9, "#3a1c17", { f: "#45231d" });
    box(lw - 2.6, 1.3, lw - 1.6, 1.9, Z(95), Z(100), "#cfcfcf"); box(lw - 2.4, 1.3, lw - 1.8, 1.55, Z(108), Z(116), "#b0b0b0");
    box(lw - 3.6, 1.9, lw - 1, 3.4, Z(52), Z(94), "#151517");
  },
  idoor(L) {
    const { lw, lh, Z, box, WH, cut } = L, zt = WH - 0.2;
    if (cut) { box(0, 0.2, lw, 1.2, 0, 2.4, "#efeeea"); return; }
    box(-1, 0, 0, 1.6, 0, zt, "#e7e6e2"); box(lw, 0, lw + 1, 1.6, 0, zt, "#e7e6e2"); box(0, 0, lw, 1.6, zt - 0.8, zt, "#e7e6e2");
    box(0, 0.2, lw, 1.2, 0, zt - 0.8, "#efeeea", { f: "#f3f2ee" });
    box(1.8, 1.2, lw - 1.8, 1.32, Z(15), Z(92), "#e1dfda"); box(1.8, 1.2, lw - 1.8, 1.32, Z(105), zt - 1.6, "#e1dfda");
    box(lw - 2.4, 1.32, lw - 0.8, 1.9, Z(96), Z(99), "#c8c8c8");
  },
  rug(L) {
    const { lw, lh, box, c } = L;
    box(0, 0, lw, lh, 0, 0.15, c("#4c544c"));
  },
  dock(L) {
    const { lw, lh, Z, box, rbox, halo } = L;
    rbox(0.4, 5.4, lw - 0.4, lh, 0, Z(1.5), "#d9d9d9", 0.8);
    rbox(0, 0, lw, 5.6, 0, Z(56), "#f4f4f4", 0.9);
    rbox(0.3, 0.3, lw - 0.3, 5.3, Z(56), Z(58), "#dedede", 0.8);
    box(lw / 2 - 0.05, 5.6, lw / 2 + 0.05, 5.72, Z(8), Z(54), "#c6c6c6");
    halo(lw / 2, 5.7, Z(50), 1.6, "rgba(140,200,255,.85)", 2);
  },
  humid(L) {
    const { lw, lh, Z, rbox, halo } = L;
    rbox(0, 0, lw, lh, 0, Z(60), "#f2f2f2", 1.2);
    rbox(0.6, 0.6, lw - 0.6, lh - 0.6, Z(60), Z(61), "#2b2b30", 0.8);
    halo(lw / 2, lh, Z(52), 1.4, "rgba(120,220,255,.8)", 2);
  },
  power(L) {
    const { lw, lh, Z, box, rbox, halo } = L;
    rbox(0, 0, lw, lh, 0, Z(38), "#e8e4dc", 0.8);
    box(0.8, lh - 0.02, lw - 0.8, lh + 0.08, Z(6), Z(32), "#17171a");
    box(lw / 2 - 0.5, lh + 0.08, lw / 2 + 0.5, lh + 0.14, Z(14), Z(24), "#f2f2f2");
    box(1, 1, lw - 1, 1.6, Z(38), Z(44), "#cfcac2"); box(1, 1, 1.6, lh - 1, Z(38), Z(44), "#cfcac2"); box(lw - 1.6, 1, lw - 1, lh - 1, Z(38), Z(44), "#cfcac2"); box(1, 1, lw - 1, 1.6, Z(42), Z(44), "#cfcac2");
    halo(lw / 2, lh + 0.1, Z(28), 1.2, "rgba(120,220,160,.8)", 2);
  },
  hookah(L) {
    const { lw, lh, Z, cyl } = L, c = lw / 2;
    cyl(c, c, 1.9, 1.9, 0, Z(4), "#1d2a3a", { seg: 18 });
    cyl(c, c, 2.3, 2.3, Z(4), Z(22), "rgba(70,110,170,.75)", { seg: 18 });
    cyl(c, c, 1.2, 1.2, Z(22), Z(28), "rgba(90,130,190,.8)", { seg: 14 });
    cyl(c, c, 0.3, 0.3, Z(28), Z(66), "#b9bcc0", { seg: 8 });
    cyl(c, c, 1.6, 1.6, Z(52), Z(53), "#c9ccd0", { seg: 14 });
    cyl(c, c, 0.9, 0.7, Z(66), Z(74), "#6b3a24", { seg: 12 });
    cyl(c, c, 1.1, 1.1, Z(74), Z(75), "#c9ccd0", { seg: 12 });
    cyl(c + 2.2, c + 0.4, 0.25, 0.25, Z(10), Z(48), "#2a2a2e", { seg: 6 });
  },
  fan(L) {
    const { lw, lh, Z, cyl, poly } = L, c = lw / 2;
    cyl(c, c, 2.2, 2.2, 0, Z(3), "#1b1b1e", { seg: 14 }); cyl(c, c, 0.35, 0.35, Z(3), Z(70), "#1b1b1e", { seg: 8 });
    const ring = (r, col, dv) => { const p = []; for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2; p.push([c + Math.cos(a) * r, c + dv, Z(88) + Math.sin(a) * r * 0.5]); } poly(p, col); };
    cyl(c, c - 0.6, 1.4, 1.4, Z(80), Z(96), "#f2f2f2", { seg: 12 });
    ring(3.2, "#f4f4f4", 0.9); ring(2.6, "rgba(210,215,220,.85)", 1);
  },
  scale(L) {
    const { lw, lh, Z, box } = L;
    box(0, 0, lw, lh, 0, Z(2.5), "#f4f4f4"); box(lw / 2 - 1, 0.8, lw / 2 + 1, 1.6, Z(2.5), Z(2.6), "#2b2b30");
  },
  mic(L) {
    const { lw, Z, cyl } = L, c = lw / 2;
    cyl(c, c, 1.4, 1.4, 0, Z(2), "#1b1b1b", { seg: 10 }); cyl(c, c, 0.18, 0.18, Z(2), Z(150), "#232326", { seg: 6 });
    cyl(c, c, 0.55, 0.55, Z(150), Z(168), "#3a3a3e", { seg: 10 });
  },
  weights(L) {
    const { Z, cyl } = L;
    cyl(2.2, 2.2, 1.9, 1.9, 0, Z(5), "#151515", { seg: 16 }); cyl(2.2, 2.2, 1.5, 1.5, Z(5), Z(9), "#1f1f1f", { seg: 16 });
    cyl(4.6, 4.4, 1.2, 1.2, 0, Z(3), "#b51e1e", { seg: 14 });
  },
  lamp(L) {
    const { lw, lh, cyl, box, halo, glow, on, WH } = L, c = lw / 2, d = lh / 2, z = WH + 2.4;
    box(c - 0.06, d - 0.06, c + 0.06, d + 0.06, z + 0.7, z + 1.6, "#9a9aa0");
    cyl(c, d, 1, 1, z + 1.6, z + 2, "#cfcfd2", { seg: 12 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3, u = c + Math.cos(a) * 3, v = d + Math.sin(a) * 3;
      box(Math.min(c, u) - 0.05, Math.min(d, v) - 0.05, Math.max(c, u) + 0.05, Math.max(d, v) + 0.05, z + 0.5, z + 0.7, "#a8a8ae");
      cyl(u, v, 0.9, 0.9, z - 0.6, z + 0.5, on ? "#fff1d2" : "#d6d3cc", { seg: 10 });
      if (on) halo(u, v, z, 3, "rgba(255,215,150,.85)", 3);
    }
    if (on) { halo(c, d, z, 16, "rgba(255,190,110,.35)"); glow(c, d, 34, "rgba(255,185,105,.42)"); }
  },
  bulb(L) {
    const { lw, lh, cyl, box, halo, glow, on, WH } = L, c = lw / 2, d = lh / 2, z = WH + 1.6;
    box(c - 0.06, d - 0.06, c + 0.06, d + 0.06, z + 1, WH + 4, "#202022");
    cyl(c, d, 1, 1, z - 0.4, z + 1, on ? "rgba(255,236,200,.95)" : "rgba(220,225,230,.55)", { seg: 12 });
    if (on) { halo(c, d, z + 0.3, 9, "rgba(255,200,130,.6)", 6); glow(c, d, 26, "rgba(255,185,105,.40)"); }
  },
  switch(L) {
    const { lw, lh, Z, box, halo, on, cut } = L, z0 = cut ? 2.2 : Z(88), z1 = cut ? 2.7 : Z(100);
    box(0, 0, lw, lh, z0, z1, "#f3f3f3", { f: "#fafafa" });
    halo(lw / 2, lh + 0.1, z1 - 0.3, 1.3, on ? "rgba(255,175,70,.95)" : "rgba(70,150,255,.9)", 2.2);
  },
  ac(L) {
    const { lw, lh, box, poly, halo, glow, on, WH, cut } = L, z1 = cut ? 3.6 : WH - 0.3, z0 = z1 - (cut ? 1.3 : 3);
    if (!cut) box(lw - 1.1, 0, lw - 0.7, 0.4, 0, z0, "#e6e6e6"); // провод к розетке — только на целой стене
    box(0, 0, lw, lh, z0, z1, "#f6f6f6", { f: "#efefef" });
    box(1, lh, lw - 1, lh + 0.12, z0 + 0.2, z0 + 0.9, on ? "#63717e" : "#c9cdd1");
    halo(lw - 2.6, lh + 0.1, z0 + 2, 1.2, on ? "rgba(120,210,255,.95)" : "rgba(255,255,255,.25)", 2);
    if (on) { poly([[1, lh + 0.2, z0 + 0.4], [lw - 1, lh + 0.2, z0 + 0.4], [lw + 2, lh + 16, 0.3], [-2, lh + 16, 0.3]], "rgba(140,205,255,.13)"); glow(lw / 2, lh + 12, 16, "rgba(110,185,255,.26)"); }
  },
  intercom(L) {
    const { lw, lh, Z, box, cut } = L; if (cut) return;
    box(0, 0, lw, lh * 0.5, Z(118), Z(140), "#e9e9e9"); box(0.3, lh * 0.5, lw - 0.3, lh, Z(120), Z(138), "#f7f7f7");
  },
};

// предмет → детали в координатах карты; r поворачивает модель (спинка на север/восток/юг/запад)
function plBuild(it, WH, st, wallCut) {
  const ty = PL_TYPES[it.t], model = PL_MODELS[it.t]; if (!ty || !model) return null;
  const r = (((it.r || 0) % 4) + 4) % 4, odd = r % 2;
  const lw = odd ? it.h : it.w, lh = odd ? it.w : it.h;
  const T = (u, v) => r === 0 ? [it.x + u, it.y + v] : r === 1 ? [it.x + lh - v, it.y + u] : r === 2 ? [it.x + lw - u, it.y + lh - v] : [it.x + v, it.y + lw - u];
  const FM = [{ b: "n", f: "s", l: "w", r: "e" }, { b: "e", f: "w", l: "n", r: "s" }, { b: "s", f: "n", l: "e", r: "w" }, { b: "w", f: "e", l: "s", r: "n" }][r];
  const prims = [], pre = [], post = [];
  const box = (u0, v0, u1, v1, z0, z1, c, f) => {
    const a = T(u0, v0), b = T(u1, v1), o = { k: "box", x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]), z0, z1, c: plRgb(c) };
    if (f) { o.f = {}; for (const k in f) o.f[k === "t" ? "t" : FM[k]] = plRgb(f[k]); }
    prims.push(o);
  };
  const cyl = (cu, cv, ru, rv, z0, z1, c, o) => {
    const p = T(cu, cv), rx = odd ? rv : ru, ry = odd ? ru : rv;
    prims.push({ k: "cyl", cx: p[0], cy: p[1], rx, ry, x0: p[0] - rx, x1: p[0] + rx, y0: p[1] - ry, y1: p[1] + ry, z0, z1, c: plRgb(c), seg: o && o.seg, soft: !!(o && o.soft) });
  };
  // скруглённый прямоугольник-призма: мягкие формы (матрас, подушки, сиденья, ванна)
  const rbox = (u0, v0, u1, v1, z0, z1, c, rad = 0.6, soft) => {
    rad = Math.max(0.05, Math.min(rad, (u1 - u0) / 2, (v1 - v0) / 2)); const pts = [], n = 4;
    for (const [cu, cv, a0] of [[u1 - rad, v1 - rad, 0], [u0 + rad, v1 - rad, 0.5], [u0 + rad, v0 + rad, 1], [u1 - rad, v0 + rad, 1.5]])
      for (let i = 0; i <= n; i++) { const a = (a0 + (i / n) * 0.5) * Math.PI; pts.push(T(cu + Math.cos(a) * rad, cv + Math.sin(a) * rad)); }
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    prims.push({ k: "cyl", pts, soft: !!soft, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z0, z1, c: plRgb(c) });
  };
  const poly = (pts, c) => {
    const w = pts.map(([u, v, z]) => { const q = T(u, v); return [q[0], q[1], z]; });
    const xs = w.map((q) => q[0]), ys = w.map((q) => q[1]), zs = w.map((q) => q[2]);
    prims.push({ k: "poly", pts: w, c: plRgb(c), x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z0: Math.min(...zs), z1: Math.max(...zs) });
  };
  const glow = (u, v, rad, c) => { const q = T(u, v); pre.push({ k: "glow", x: q[0], y: q[1], r: rad, c }); };
  const halo = (u, v, z, rad, c, min) => { const q = T(u, v); post.push({ x: q[0], y: q[1], z, r: rad, c, min }); };
  let on = false;
  if (ty.dev === "light") on = !!(st.rooms && (st.rooms[it.room] || st.rooms[plCanon(it.room)]));
  else if (ty.dev === "ac") on = !!st.ac; else if (ty.dev === "pc") on = !!st.pc; else if (ty.dev === "router") on = true;
  if (!ty.flat && !ty.air && !ty.wall) {
    pre.push({ k: "shadow", x0: it.x - 0.8, y0: it.y - 0.8, x1: it.x + it.w + 0.8, y1: it.y + it.h + 0.8, a: 0.10 });
    pre.push({ k: "shadow", x0: it.x - 0.1, y0: it.y - 0.1, x1: it.x + it.w + 0.1, y1: it.y + it.h + 0.1, a: 0.18 });
  }
  // предмет на стене, которая сейчас срезана (стоит между зрителем и комнатой), рисуется низким
  const cut = !!(ty.mount && wallCut && wallCut(...T(lw / 2, -1)));
  model({ lw, lh, Z: plZ, WH, on, st, cut, id: it.id, c: (d) => it.c || d, box, rbox, cyl, poly, glow, halo });
  return { prims, pre, post };
}

// стартовая расстановка — по фото и карте пылесоса (база стоит там, где его зарядка); дальше двигается в редакторе
function plDefault() {
  const it = (t, x, y, r = 0, lw, lh, ext) => {
    const ty = PL_TYPES[t]; lw = lw || ty.lw; lh = lh || ty.lh;
    return Object.assign({ id: Math.random().toString(36).slice(2, 9), t, x, y, r, w: r % 2 ? lh : lw, h: r % 2 ? lw : lh }, ext || {});
  };
  return {
    v: 7,
    rooms: { 1: "Зал", 2: "Кухня", 3: "Ванная", 4: "Прихожая" },
    // правки карты: ниша под кроватью — пол зала (робот туда не заезжает), её настоящие стены
    // комнаты прямоугольниками (координаты карты пылесоса, клетки по 5 см): ровные стены вместо рваных краёв лидара
    geo: {
      rooms: {
        2: [[1, 1, 44, 54], [44, 20, 86, 53]],
        4: [[4, 57, 44, 118], [1, 66, 3, 86]],
        3: [[47, 61, 87, 110]],
        1: [[11, 121, 98, 204]], // зал — ровный прямоугольник, северная стена (к ванной) прямая
      },
      doors: [[13, 55, 33, 56, 4], [45, 90, 46, 100, 4], [20, 119, 36, 120, 1]],
    },
    items: [
      // зал — по скану Scaniverse, совмещённому с картой: вдоль западной стены вешалка, база пылесоса (точка зарядки) и стол
      // с ПК в углу; у южной стены батарея под окном, в углу кресло-мешок; кровать изголовьем к восточной стене (где кондиционер), у изголовья тумба
      it("rack", 9, 121, 3, 34, 9), it("weights", 20, 158), it("dock", 11, 163, 3), it("desk", 11, 179, 3, 26, 13),
      it("pc", 12, 198, 3), it("router", 12, 191, 3), it("chair", 26, 186, 1),
      it("window", 34, 203, 2, 26, 3), it("radiator", 39, 201, 2), it("scale", 31, 197), it("beanbag", 67, 187), it("hookah", 60, 181), it("mic", 85, 194),
      it("bed", 58, 121, 1, 31, 40), it("power", 92, 153, 1), it("table", 66, 156), it("ac", 94, 184, 1),
      it("lamp", 52, 165, 0, 0, 0, { room: "Зал" }), it("switch", 37, 121, 0, 0, 0, { room: "Зал" }),
      // кухня (снято от балкона: проём в прихожую — в дальней стене): справа от проёма холодильник и мойка с навесными шкафами,
      // в дальнем углу игровое кресло, вдоль правой стены диванчик, посередине сушилка; у камеры плита, слева тумба с красным шкафчиком
      it("window", 28, 0, 0, 18, 3, { c: "#45454c" }), it("stove", 14, 1, 0), it("lowcab", 1, 10, 3, 16, 10), it("wallcab", 1, 10, 3, 16, 6),
      it("fridge", 34, 43, 2), it("counter", 47, 41, 2, 24, 12), it("gchair", 60, 29, 0), it("sofa", 72, 22, 1, 31, 14), it("dryer", 38, 23, 0, 22, 11),
      it("lamp", 22, 28, 0, 0, 0, { room: "Кухня" }), it("switch", 13, 55, 2, 0, 0, { room: "Кухня" }),
      // прихожая
      it("door", 0, 70, 3), it("rug", 3, 72, 3, 14, 9, { c: "#2f3033" }), it("shoes", 3, 58), it("intercom", 0, 89, 3), it("switch", 0, 65, 3, 0, 0, { room: "Прихожая" }),
      it("mirrorwr", 1, 89, 3), it("dresser", 2, 103, 3), it("wardrobe", 32, 58, 1), it("idoor", 43, 92, 1),
      it("switch", 34, 87, 1, 0, 0, { room: "Ванная" }), it("bulb", 18, 86, 0, 0, 0, { room: "Прихожая" }),
      // ванная
      it("bath", 71, 57, 1), it("toilet", 73, 97, 1), it("sink", 47, 62, 3), it("washer", 47, 75, 3),
      it("rug", 58, 66, 1, 14, 10, { c: "#4a5249" }), it("rug", 63, 96, 1, 10, 8, { c: "#4a5249" }), it("bulb", 62, 90, 0, 0, 0, { room: "Ванная" }),
    ],
  };
}

window.zhPlan = null;
window.zhDevState = { rooms: {}, ac: false, pc: false };
function plRefreshMaps() { (window.zhMaps || []).forEach((m) => { m._dirty = true; if (m.start) m.start(); }); }

async function plLoad() {
  try {
    const p = await api("/api/home/plan");
    window.zhPlan = p && p.v === 7 && Array.isArray(p.items) ? p : plDefault();
    plLoad.ok = true;
  } catch (e) { if (!window.zhPlan) window.zhPlan = plDefault(); }
  plRefreshMaps();
  return window.zhPlan;
}
async function plSave() { await post("/api/home/plan", window.zhPlan); }

// отделка комнат как на фото: пол, стены, плитка (шаг в клетках)
const PL_STYLE = {
  "Зал": { floor: "#4a5162", wall: "#7b7e86", tile: 18, tileA: 0.07 },
  "Кухня": { floor: "#3e4350", wall: "#a5a994" },
  "Прихожая": { floor: "#37393f", wall: "#57524e" },
  "Ванная": { floor: "#4b4b4f", wall: "#6f6e6b", tile: 12, tileA: 0.3 },
};
window.plRoomStyle = (name) => PL_STYLE[plCanon(name)] || { floor: "#45474d", wall: "#8a8780" };

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
  } catch (e) { st.rooms = (window.zhDevState || {}).rooms || {}; }
  try { const a = await api("/api/home/daichi"); st.ac = !!((a.devices || [])[0] || {}).on; } catch (e) {}
  try { const p = await api("/api/home/pc/agent"); st.pc = (p.agents || []).some((x) => x.online); } catch (e) {}
  window.zhDevState = st; plRefreshMaps();
}

// ---------- редактор «План дома» ----------
const ple = { top: null, ov: null, map: null, sel: null, drag: null, view3d: null, dirty: false };
setTimeout(() => plLoad().then(() => { plPollDevices(); setInterval(plPollDevices, 30000); }), 0);

function plEsc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function plEditorOpen() {
  const host = $("#planEditor"); if (!host) return;
  if (!window.zhPlan) await plLoad();
  let c; try { c = await dmLoad(); } catch (e) { host.innerHTML = '<div class="card"><p class="muted">Нужна карта с пылесоса Dreame: подключите его на странице «Пылесос».</p></div>'; return; }
  ple.map = c.map;
  if (!host.dataset.built) {
    host.dataset.built = "1";
    host.innerHTML = `
      <div class="plan-grid">
        <div class="card plan-board"><div class="plan-stage"><canvas id="planCanvas"></canvas><canvas id="planOver"></canvas></div><div class="plan-hint muted small">Тяните предмет мышкой, за оранжевый уголок — меняйте размер. R — повернуть, Delete — удалить.</div></div>
        <div class="plan-side">
          <div class="card"><div class="mono-label">ДОБАВИТЬ</div><div class="plan-palette" id="planPalette"></div></div>
          <div class="card" id="planProps"></div>
          <div class="card"><div class="mono-label">КОМНАТЫ</div><div id="planRooms"></div></div>
          <div class="plan-actions"><button class="btn btn-acc" id="planSave">Сохранить</button><button class="btn" id="planReset">Расставить по фото заново</button></div>
          <div class="muted small" id="planMsg"></div>
        </div>
      </div>
      <div class="card plan-3d"><div class="mono-label">ТАК ДОМ ВЫГЛЯДИТ НА 3D-КАРТЕ · КРУТИТЕ МЫШКОЙ</div><canvas id="plan3d"></canvas></div>`;
    $("#planPalette").innerHTML = Object.entries(PL_TYPES).map(([k, t]) => `<button class="plan-add" data-t="${k}" title="${plEsc(t.n)}"><i>${t.i}</i><span>${plEsc(t.n)}</span></button>`).join("");
    $$(".plan-add", host).forEach((b) => b.onclick = () => plAdd(b.dataset.t));
    $("#planSave").onclick = async () => { try { await plSave(); ple.dirty = false; $("#planMsg").textContent = "Сохранено — план виден на всех картах."; plRefreshMaps(); } catch (e) { $("#planMsg").textContent = e.message || "Не сохранилось"; } };
    $("#planReset").onclick = () => { if (confirm("Расставить всё заново по фото? Ваши перемещения пропадут (до сохранения).")) { window.zhPlan = plDefault(); ple.sel = null; plChanged(); } };
    // план сверху — тот же рендер, что и 3D-карта, только без наклона
    ple.top = new DreameMap3D($("#planCanvas"), { autoRotate: false, interactive: false, labels: true, paths: false, cache: true });
    ple.top.yaw = 0; ple.top.tilt = 0.9999; ple.top.onDraw = plOverlay;
    ple.top.setNames(c.names); ple.top.setData(c.map); ple.top.progress = 1;
    ple.ov = $("#planOver");
    ple.ov.addEventListener("pointerdown", plDown); window.addEventListener("pointermove", plMove); window.addEventListener("pointerup", () => { ple.drag = null; });
    document.addEventListener("keydown", (e) => {
      if (!ple.sel || !$("#page-plan.active") || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
      if (e.key === "r" || e.key === "R" || e.key === "к" || e.key === "К") plRotate();
      if (e.key === "Delete" || e.key === "Backspace") plDelete();
    });
    ple.view3d = new DreameMap3D($("#plan3d"), { autoRotate: false, interactive: true, labels: true, cache: true });
    ple.view3d.tilt = 0.7; ple.view3d.setNames(c.names); ple.view3d.setData(c.map); ple.view3d.progress = 1;
  }
  plRooms(); plProps(); plRefreshMaps();
}

function plChanged() { ple.dirty = true; $("#planMsg").textContent = "Есть несохранённые изменения"; plProps(); plRefreshMaps(); }
function plItem() { return (window.zhPlan.items || []).find((x) => x.id === ple.sel); }

function plAdd(t) {
  const ty = PL_TYPES[t], m = ple.map, room = (m.rooms || [])[0];
  const it = { id: Math.random().toString(36).slice(2, 9), t, r: 0, w: ty.lw, h: ty.lh };
  it.x = Math.round((room ? room.cx : m.w / 2) - it.w / 2); it.y = Math.round((room ? room.cy : m.h / 2) - it.h / 2);
  if (ty.dev === "light") it.room = Object.values(window.zhPlan.rooms || {})[0] || "";
  window.zhPlan.items.push(it); ple.sel = it.id; plChanged();
}
function plRotate() { const it = plItem(); if (!it) return; const cx = it.x + it.w / 2, cy = it.y + it.h / 2; it.r = ((it.r || 0) + 1) % 4; [it.w, it.h] = [it.h, it.w]; it.x = Math.round(cx - it.w / 2); it.y = Math.round(cy - it.h / 2); plChanged(); }
function plDelete() { const it = plItem(); if (!it) return; window.zhPlan.items = window.zhPlan.items.filter((x) => x !== it); ple.sel = null; plChanged(); }

function plRooms() {
  const el = $("#planRooms"); if (!el) return;
  const rooms = window.zhPlan.rooms || (window.zhPlan.rooms = {});
  el.innerHTML = (ple.map.rooms || []).map((r) => `<label class="plan-room"><span>${r.area} м²</span><input class="field" data-r="${r.id}" value="${plEsc(rooms[r.id] || "")}" placeholder="Комната ${r.id}"></label>`).join("");
  $$("input[data-r]", el).forEach((i) => i.oninput = () => { rooms[i.dataset.r] = i.value.trim(); ple.dirty = true; $("#planMsg").textContent = "Есть несохранённые изменения"; plRefreshMaps(); });
}
function plProps() {
  const el = $("#planProps"); if (!el) return;
  const it = plItem();
  if (!it) { el.innerHTML = '<div class="mono-label">ПРЕДМЕТ</div><p class="muted small">Нажмите на предмет на плане, чтобы изменить его.</p>'; return; }
  const ty = PL_TYPES[it.t] || {};
  const roomNames = [...new Set([...Object.values(window.zhPlan.rooms || {}), ...plDevNames, it.room].filter(Boolean))];
  el.innerHTML = `<div class="mono-label">ПРЕДМЕТ</div><b class="plan-pname">${ty.i || ""} ${plEsc(ty.n || it.t)}</b>
    <div class="muted small">${Math.round(it.w * 5)} × ${Math.round(it.h * 5)} см</div>
    ${ty.dev === "light" ? `<label class="plan-room"><span>Свет комнаты</span><select class="field" id="planLampRoom">${roomNames.map((n) => `<option ${n === it.room ? "selected" : ""}>${plEsc(n)}</option>`).join("")}</select></label>` : ""}
    <div class="plan-actions"><button class="btn" id="planRot">↻ Повернуть</button><button class="btn" id="planDel">Удалить</button></div>`;
  $("#planRot").onclick = plRotate; $("#planDel").onclick = plDelete;
  const lr = $("#planLampRoom"); if (lr) lr.onchange = () => { it.room = lr.value; plChanged(); };
}

// экран ↔ клетки карты (вид сверху: yaw = 0)
// картинка отражена относительно карты пылесоса (как в жизни) — переводим обратно в координаты карты
function plMirY(y) { return ple.top && ple.top.mir ? ple.top.h - y : y; }
function plToCell(px, py) { const P = ple.top && ple.top._proj; if (!P) return null; return [(px - P.OX) / P.s + P.cx, plMirY((py - P.OY) / (P.s * P.sinT) + P.cy)]; }
function plToPx(x, y) { const P = ple.top._proj; return [P.OX + (x - P.cx) * P.s, P.OY + (plMirY(y) - P.cy) * P.s * P.sinT]; }
// углы предмета на экране: верхний левый и нижний правый (с учётом отражения)
function plRectPx(it) { const a = plToPx(it.x, it.y), b = plToPx(it.x + it.w, it.y + it.h); return [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]]; }
function plOverlay() {
  const ov = ple.ov, top = ple.top; if (!ov || !top || !top._proj) return;
  const W = top.W, H = top.H, dpr = top.dpr;
  if (ov.width !== Math.round(W * dpr) || ov.height !== Math.round(H * dpr)) { ov.width = Math.round(W * dpr); ov.height = Math.round(H * dpr); }
  const x = ov.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
  const it = plItem(); if (!it) return;
  const [a, b] = plRectPx(it);
  x.strokeStyle = "#ff5a1f"; x.lineWidth = 2; x.setLineDash([5, 3]); x.strokeRect(a[0] - 2, a[1] - 2, b[0] - a[0] + 4, b[1] - a[1] + 4); x.setLineDash([]);
  x.fillStyle = "#ff5a1f"; x.fillRect(b[0] - 4, b[1] - 4, 10, 10);
  const ty = PL_TYPES[it.t] || {}; x.font = "600 12px Inter, sans-serif"; x.textAlign = "left"; x.textBaseline = "bottom";
  const lbl = ty.n || it.t, tw = x.measureText(lbl).width; x.fillStyle = "rgba(8,8,10,.8)"; x.fillRect(a[0] - 2, a[1] - 22, tw + 12, 18); x.fillStyle = "#f2f0ed"; x.fillText(lbl, a[0] + 4, a[1] - 6);
}
function plHit(px, py) {
  const q = plToCell(px, py); if (!q) return {};
  const [x, y] = q, items = window.zhPlan.items || [], sel = plItem();
  if (sel) { const h = plRectPx(sel)[1]; if (Math.abs(px - h[0]) < 10 && Math.abs(py - h[1]) < 10) return { it: sel, resize: true, x, y }; }
  let best = null; // при наложении берём самый маленький предмет (роутер на столе, коврик под дверью…)
  for (const it of items) if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h && (!best || it.w * it.h < best.w * best.h)) best = it;
  return { it: best, x, y };
}
function plDown(e) {
  const r = ple.ov.getBoundingClientRect(), hit = plHit(e.clientX - r.left, e.clientY - r.top);
  if (hit.it) { ple.sel = hit.it.id; ple.drag = { it: hit.it, resize: !!hit.resize, dx: hit.x - hit.it.x, dy: hit.y - hit.it.y, top: hit.it.y + hit.it.h, bottom: hit.it.y }; e.preventDefault(); }
  else ple.sel = null;
  plProps(); plOverlay();
}
function plMove(e) {
  if (!ple.drag || !ple.ov) return;
  const r = ple.ov.getBoundingClientRect(), q = plToCell(e.clientX - r.left, e.clientY - r.top); if (!q) return;
  const it = ple.drag.it;
  if (ple.drag.resize) {
    it.w = Math.max(1, Math.round(q[0] - it.x));
    if (ple.top.mir) { const top = ple.drag.top; it.y = Math.min(top - 1, Math.round(q[1])); it.h = top - it.y; } // нижний край на экране — меньший y карты
    else it.h = Math.max(1, Math.round(q[1] - it.y));
  }
  else { it.x = Math.round(q[0] - ple.drag.dx); it.y = Math.round(q[1] - ple.drag.dy); }
  ple.dirty = true; $("#planMsg").textContent = "Есть несохранённые изменения"; plRefreshMaps();
}

const _goPlan = go;
go = function (p) { _goPlan(p); if (p === "plan") plEditorOpen(); };
