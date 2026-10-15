"use strict";
// Фоновый декодер ключевых кадров H.265: оборачивает кадр в мини-HEIF и раскрывает его libheif (WebAssembly).
// Нужен там, где в браузере нет видеодекодера (например, обои Wallpaper Engine).
importScripts("/libheif-bundle.js");

const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16 = (n) => new Uint8Array([(n >> 8) & 255, n & 255]);
const str = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const cat = (...a) => { let n = 0; a.forEach((x) => (n += x.length)); const o = new Uint8Array(n); let p = 0; a.forEach((x) => { o.set(x, p); p += x.length; }); return o; };
const box = (type, ...p) => { const body = cat(...p); return cat(u32(8 + body.length), str(type), body); };
const fbox = (type, ver, ...p) => box(type, new Uint8Array([ver, 0, 0, 0]), ...p);

function wrapHeif(hvcCbox, W, H, sample) {
  const ftyp = box("ftyp", str("heic"), u32(0), str("mif1"), str("heic"));
  const hdlr = fbox("hdlr", 0, u32(0), str("pict"), u32(0), u32(0), u32(0), new Uint8Array([0]));
  const pitm = fbox("pitm", 0, u16(1));
  const iinf = fbox("iinf", 0, u16(1), fbox("infe", 2, u16(1), u16(0), str("hvc1"), new Uint8Array([0])));
  const ipco = box("ipco", hvcCbox, fbox("ispe", 0, u32(W), u32(H)));
  const ipma = fbox("ipma", 0, u32(1), u16(1), new Uint8Array([2, 0x81, 0x02]));
  const iprp = box("iprp", ipco, ipma);
  const iloc = (off) => fbox("iloc", 0, new Uint8Array([0x44, 0x00]), u16(1), u16(1), u16(0), u16(1), u32(off), u32(sample.length));
  let meta = fbox("meta", 0, hdlr, pitm, iloc(0), iinf, iprp);
  meta = fbox("meta", 0, hdlr, pitm, iloc(ftyp.length + meta.length + 8), iinf, iprp);
  return cat(ftyp, meta, box("mdat", sample));
}

let lib = null, cfg = null, busy = false;
async function getLib() { if (!lib) { const l = self.libheif(); lib = l && l.then ? await l : l; } return lib; }

// ошибка внутри libheif (например, рост памяти WebAssembly) не должна ронять поток: сообщаем и пробуем со следующим кадром
self.addEventListener("error", (ev) => { busy = false; lib = null; try { ev.preventDefault(); } catch (e) {} postMessage({ error: String(ev.message || "ошибка декодера") }); });
onmessage = async (e) => {
  const m = e.data;
  if (m.init) { cfg = m.init; return; }
  if (!m.sample || !cfg || busy) return; // пока занят — кадр пропускаем
  busy = true;
  try {
    const L = await getLib();
    const img = new L.HeifDecoder().decode(wrapHeif(cfg.hvcC, cfg.W, cfg.H, m.sample))[0];
    const w = img.get_width(), h = img.get_height();
    const id = new ImageData(w, h);
    await new Promise((res, rej) => img.display(id, (d) => (d ? res(d) : rej(new Error("display failed")))));
    const full = new OffscreenCanvas(w, h); full.getContext("2d").putImageData(id, 0, 0);
    // кодек кодирует 1088 строк вместо 1080 — лишние строки снизу срезаем (кадр 16:9)
    const h169 = Math.round((w * 9) / 16), hh = h > h169 && h - h169 < 17 ? h169 : h;
    const tw = Math.min(w, m.maxW || 960), th = Math.round((hh * tw) / w);
    const oc = new OffscreenCanvas(tw, th); oc.getContext("2d").drawImage(full, 0, 0, w, hh, 0, 0, tw, th);
    const bmp = oc.transferToImageBitmap();
    postMessage({ bitmap: bmp, w: tw, h: th }, [bmp]);
  } catch (err) { lib = null; postMessage({ error: String((err && err.message) || err) }); }
  busy = false;
};
