package main

// План дома: мебель и устройства на карте квартиры (рисуется на 3D-карте в портале, киоске и обоях).
// GET /api/home/plan — сохранённый план (или {}), POST — сохранить (JSON до 512 КБ).

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"sync"
)

var planMu sync.Mutex

func (p *homePortal) handlePlan(w http.ResponseWriter, r *http.Request) {
	path := p.s.meta("homeplan.json")
	planMu.Lock()
	defer planMu.Unlock()
	if r.Method == http.MethodPost {
		b, err := io.ReadAll(io.LimitReader(r.Body, 512<<10))
		if err != nil || !json.Valid(b) {
			fail(w, http.StatusBadRequest, "план повреждён")
			return
		}
		if err := os.WriteFile(path+".tmp", b, 0o644); err != nil {
			fail(w, http.StatusInternalServerError, "не удалось сохранить план")
			return
		}
		if err := os.Rename(path+".tmp", path); err != nil {
			fail(w, http.StatusInternalServerError, "не удалось сохранить план")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}
