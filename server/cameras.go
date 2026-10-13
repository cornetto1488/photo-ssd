// Камеры ZALET HOME: автопоиск, сохранённый список (порядок/имена) и смена session_id из веба.
// Все пункты вешаются только через карту api в home.go (PIN-сессия).
package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	modusSessionFile = "/etc/modus.session"
	camerasConfFile  = "/mnt/ssd/.router/cameras.json"
	camerasScanMax   = 96
)

var modusSessionRe = regexp.MustCompile(`^[A-Za-z0-9._~%=+/-]{8,400}$`)

// modusSessionID: файл (меняется из веба без рестарта) важнее переменной окружения.
func modusSessionID() string {
	if b, err := os.ReadFile(modusSessionFile); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			return s
		}
	}
	return strings.TrimSpace(os.Getenv("MODUS_SESSION_ID"))
}

func modusProbe(ctx context.Context, sessionID string, camera int) (ok bool, status int, msg string) {
	now := time.Now().UnixMilli()
	raw, st, m := modusFetch(ctx, sessionID, modusArchiveRequest{Camera: camera, StartMs: now - 60000, EndMs: now})
	if m != "" {
		return false, st, m
	}
	var d struct {
		Code int `json:"code"`
	}
	if json.Unmarshal(raw, &d) != nil || d.Code != 0 {
		return false, 0, ""
	}
	return true, 0, ""
}

// GET /api/cameras/scan — перебирает каналы 1..96 и возвращает найденные.
func homeCameraScan(w http.ResponseWriter, r *http.Request) {
	sid := modusSessionID()
	if sid == "" {
		modusError(w, http.StatusServiceUnavailable, "Session ID не задан")
		return
	}
	var (
		mu    sync.Mutex
		found []int
		fail  string
		fst   int
		wg    sync.WaitGroup
	)
	sem := make(chan struct{}, 8)
	for n := 1; n <= camerasScanMax; n++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(n int) {
			defer wg.Done()
			defer func() { <-sem }()
			ok, st, m := modusProbe(r.Context(), sid, n)
			mu.Lock()
			if ok {
				found = append(found, n)
			} else if m != "" && fail == "" {
				fail, fst = m, st
			}
			mu.Unlock()
		}(n)
	}
	wg.Wait()
	if len(found) == 0 && fail != "" {
		modusError(w, fst, fail)
		return
	}
	sort.Ints(found)
	writeJSON(w, http.StatusOK, map[string]any{"cameras": found, "scanned": camerasScanMax})
}

var camerasConfMu sync.Mutex

// GET — отдать сохранённый список, POST — сохранить (JSON как есть, до 64 КБ).
func homeCameraConfig(w http.ResponseWriter, r *http.Request) {
	camerasConfMu.Lock()
	defer camerasConfMu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodGet:
		b, err := os.ReadFile(camerasConfFile)
		if err != nil || !json.Valid(b) {
			b = []byte("{}")
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Write(b)
	case http.MethodPost:
		b, err := io.ReadAll(io.LimitReader(r.Body, 64<<10+1))
		if err != nil || len(b) > 64<<10 || !json.Valid(b) {
			modusError(w, http.StatusBadRequest, "Некорректный список камер")
			return
		}
		tmp := camerasConfFile + ".tmp"
		if err := os.WriteFile(tmp, b, 0o600); err != nil {
			modusError(w, http.StatusInternalServerError, "Не удалось сохранить список камер")
			return
		}
		if err := os.Rename(tmp, camerasConfFile); err != nil {
			modusError(w, http.StatusInternalServerError, "Не удалось сохранить список камер")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		w.Header().Set("Allow", "GET, POST")
		modusError(w, http.StatusMethodNotAllowed, "Только GET или POST")
	}
}

// GET — статус сессии (значение не отдаём), POST {session_id} — проверить у Modus и сохранить.
func homeCameraSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodGet:
		sid := modusSessionID()
		resp := map[string]any{"set": sid != ""}
		if sid != "" {
			ok, _, m := modusProbe(r.Context(), sid, 1)
			resp["valid"] = ok
			if !ok && m != "" {
				resp["error"] = m
			}
			resp["hint"] = "…" + sid[max(0, len(sid)-4):]
		}
		writeJSON(w, http.StatusOK, resp)
	case http.MethodPost:
		var p struct {
			SessionID string `json:"session_id"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&p) != nil {
			modusError(w, http.StatusBadRequest, "Некорректный JSON")
			return
		}
		sid := strings.TrimSpace(p.SessionID)
		sid = strings.TrimPrefix(sid, "session_id=")
		if !modusSessionRe.MatchString(sid) {
			modusError(w, http.StatusBadRequest, "Session ID выглядит неправильно")
			return
		}
		ok, st, m := modusProbe(r.Context(), sid, 1)
		if !ok {
			if m == "" {
				m, st = "Modus не принял этот session ID", http.StatusBadRequest
			}
			modusError(w, st, m)
			return
		}
		if err := os.WriteFile(modusSessionFile, []byte(sid+"\n"), 0o600); err != nil {
			modusError(w, http.StatusInternalServerError, "Не удалось сохранить session ID")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "valid": true})
	default:
		w.Header().Set("Allow", "GET, POST")
		modusError(w, http.StatusMethodNotAllowed, "Только GET или POST")
	}
}
