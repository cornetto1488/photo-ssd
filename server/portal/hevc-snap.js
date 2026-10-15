"use strict";
// «Живые кадры» камеры без видеодекодера (обои Wallpaper Engine и др.): берём ключевой кадр H.265 из fMP4-потока,
// декодируем его в фоновом потоке (hevc-worker.js, libheif/WebAssembly) и рисуем на canvas.
// Режим poll: открыть поток → один ключевой кадр → закрыть → пауза → снова. Ничего не копится, трафик минимальный.
window.HevcSnap = (() => {
  const u32 = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function find(buf, t, from = 0) {
    const a = t.charCodeAt(0), b = t.charCodeAt(1), c = t.charCodeAt(2), d = t.charCodeAt(3);
    for (let i = from; i + 4 <= buf.length; i++) if (buf[i] === a && buf[i + 1] === b && buf[i + 2] === c && buf[i + 3] === d) return i;
    return -1;
  }
  const isKey = (s) => { // в семпле есть кадр IDR/BLA/CRA (типы NAL 16..21)
    let p = 0; while (p + 5 <= s.length) { const len = u32(s, p), t = (s[p + 4] >> 1) & 63; if (t >= 16 && t <= 21) return true; if (len <= 0) break; p += 4 + len; }
    return false;
  };

  // opt: getUrl() -> Promise<string> (режим poll, каждый раз новая одноразовая ссылка) или url строкой (постоянный поток)
  function start(url, canvas, opt = {}) {
    const interval = opt.intervalMs || 6000, maxW = opt.maxW || 960, poll = typeof opt.getUrl === "function";
    const ctx = canvas.getContext("2d");
    let stopped = false, ac = null, worker = null, badRun = 0, waiter = null, last = 0;
    const out = { frames: 0, errors: 0, stop() { stopped = true; try { ac && ac.abort(); } catch (e) {} try { worker && worker.terminate(); } catch (e) {} } };
    const fail = (e) => { if (!stopped && opt.onError) opt.onError(e); };

    function newWorker() {
      worker = new Worker("/hevc-worker.js");
      worker.onmessage = (e) => {
        const w = waiter; waiter = null;
        if (e.data.error) { out.errors++; badRun++; if (w) w(false); if (badRun >= 8) fail(new Error(e.data.error)); return; } // единичные сбои декодера пропускаем
        badRun = 0; out.frames++;
        const b = e.data.bitmap; canvas.width = b.width; canvas.height = b.height; ctx.drawImage(b, 0, 0); b.close && b.close();
        last = performance.now(); if (opt.onFrame) opt.onFrame();
        if (w) w(true);
      };
      worker.onerror = (e) => { const w = waiter; waiter = null; if (w) w(false); fail(new Error("worker: " + (e.message || "ошибка"))); };
    }

    // читает поток и отдаёт декодеру ключевые кадры; в режиме poll возвращается после первого удачного кадра
    async function grab(u) {
      ac = new AbortController();
      const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, poll ? 12000 : 0);
      if (!poll) clearTimeout(timer);
      try {
        const resp = await fetch(u, { signal: ac.signal });
        if (!resp.ok || !resp.body) throw new Error("поток недоступен (HTTP " + resp.status + ")");
        const rd = resp.body.getReader();
        let buf = new Uint8Array(0), inited = false;
        const append = (c) => { const n = new Uint8Array(buf.length + c.length); n.set(buf, 0); n.set(c, buf.length); buf = n; };
        while (!stopped) {
          const { value, done } = await rd.read();
          if (done) break;
          append(value);
          for (;;) {
            if (buf.length < 8) break;
            const size = u32(buf, 0), type = tag(buf, 4);
            if (size < 8) { buf = new Uint8Array(0); break; }
            if (buf.length < size) break;
            const bx = buf.subarray(0, size);
            if (type === "moov" && !inited) {
              const hv = find(bx, "hvcC"), he = find(bx, "hev1") >= 0 ? find(bx, "hev1") : find(bx, "hvc1");
              if (hv < 4 || he < 0) throw new Error("в потоке нет H.265");
              worker.postMessage({ init: { hvcC: bx.slice(hv - 4, hv - 4 + u32(bx, hv - 4)), W: (bx[he + 28] << 8) | bx[he + 29], H: (bx[he + 30] << 8) | bx[he + 31] } });
              inited = true;
            } else if (type === "mdat" && inited && !waiter && performance.now() - last >= (poll ? 0 : interval)) {
              const sample = bx.subarray(8);
              if (isKey(sample)) {
                const copy = sample.slice();
                const ok = await new Promise((res) => { waiter = res; worker.postMessage({ sample: copy, maxW }, [copy.buffer]); });
                if (poll && ok) { try { ac.abort(); } catch (e) {} return true; } // кадр есть — поток закрываем
              }
            }
            buf = buf.slice(size);
          }
        }
        return false;
      } finally { clearTimeout(timer); }
    }

    (async () => {
      newWorker();
      if (!poll) { await grab(url); if (!stopped) fail(new Error("поток закончился")); return; }
      let wait = interval;
      while (!stopped) {
        try { const u = await opt.getUrl(); if (stopped) break; const ok = await grab(u); wait = ok ? interval : 8000; }
        catch (e) { if (stopped) break; wait = 10000; if (opt.onWarn) opt.onWarn(e); }
        await sleep(wait + Math.random() * 600); // небольшой разброс, чтобы камеры не просили кадры одновременно
      }
    })().catch((e) => { if (!stopped && !(e && e.name === "AbortError")) fail(e); });
    return out;
  }
  return { start };
})();
