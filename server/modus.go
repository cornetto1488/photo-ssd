// Modus archive proxy for ZALET HOME (Go-версия modus_backend.py).
//
// MODUS_SESSION_ID держи только на сервере (переменная окружения),
// никогда не клади в app.js, index.html или любой конфиг, видимый браузеру.
//
// Подключён в home.go через карту api: "/api/cameras/archive-url": homeCameraArchive.
// Все пункты карты оборачиваются p.s.auth (PIN-сессия), поэтому сам handler
// авторизацию не повторяет — вешать его ТОЛЬКО через эту карту.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	modusAPIURL      = "https://api.modus-omsk.ru/api/clients/cameras/archive-url"
	modusMaxPeriodMs = 24 * 60 * 60 * 1000
	modusItemKeyFmt  = "cam:194.186.196.248:34567:%d"
)

type modusArchiveRequest struct {
	Camera  int   `json:"camera"`
	StartMs int64 `json:"start_ms"`
	EndMs   int64 `json:"end_ms"`
}

var modusClient = &http.Client{
	Timeout: 20 * time.Second,
	// аналог follow_redirects=False
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func homeCameraArchive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		modusError(w, http.StatusMethodNotAllowed, "Только POST")
		return
	}
	// Читаем на каждый запрос: можно обновить сессию без пересборки (после рестарта сервиса).
	sessionID := strings.TrimSpace(os.Getenv("MODUS_SESSION_ID"))
	if sessionID == "" {
		modusError(w, http.StatusServiceUnavailable, "На сервере не настроена переменная MODUS_SESSION_ID")
		return
	}

	var p modusArchiveRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&p); err != nil {
		modusError(w, http.StatusBadRequest, "Некорректный JSON")
		return
	}
	switch {
	case p.Camera < 1 || p.Camera > 40:
		modusError(w, http.StatusBadRequest, "Номер камеры должен быть от 1 до 40")
		return
	case p.StartMs <= 0 || p.EndMs <= 0 || p.StartMs >= p.EndMs:
		modusError(w, http.StatusBadRequest, "Некорректный период архива")
		return
	case p.EndMs-p.StartMs > modusMaxPeriodMs:
		modusError(w, http.StatusBadRequest, "Период архива не должен превышать 24 часа")
		return
	}

	body, _ := json.Marshal(map[string]any{
		"start_ms": p.StartMs,
		"end_ms":   p.EndMs,
		"item_key": fmt.Sprintf(modusItemKeyFmt, p.Camera),
	})

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, modusAPIURL, bytes.NewReader(body))
	if err != nil {
		modusError(w, http.StatusInternalServerError, "Не удалось собрать запрос к Modus API")
		return
	}
	req.Header.Set("X-AppVersion", "3.1.3 (2)")
	req.Header.Set("X-Api-Version", "2")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ZALET-HOME-Modus-Archive/1.0")
	req.AddCookie(&http.Cookie{Name: "session_id", Value: sessionID})

	resp, err := modusClient.Do(req)
	if err != nil {
		var ne interface{ Timeout() bool }
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
			modusError(w, http.StatusGatewayTimeout, "Modus API не ответил вовремя")
			return
		}
		log.Printf("modus: request error: %v", err)
		modusError(w, http.StatusBadGateway, "Не удалось связаться с Modus API")
		return
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		modusError(w, http.StatusBadGateway, "Не удалось прочитать ответ Modus API")
		return
	}

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		modusError(w, http.StatusBadGateway, "Сессия Modus истекла или не имеет доступа")
		return
	}
	if resp.StatusCode >= 400 {
		// Заголовки/куки и креды в браузер не отдаём.
		modusError(w, http.StatusBadGateway, fmt.Sprintf("Modus API вернул HTTP %d", resp.StatusCode))
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if json.Valid(raw) {
		w.Write(raw)
		return
	}
	text := string(raw)
	if len(text) > 12000 {
		text = text[:12000]
	}
	json.NewEncoder(w).Encode(map[string]string{"raw": text})
}

// app.js читает текст ошибки из поля "error" (FastAPI отдавал "detail" — фронт его не видел).
func modusError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
