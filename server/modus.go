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
	"net/http/httputil"
	"net/url"
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
		// RTSP браузер не играет: регистрируем ссылку в go2rtc, фронт получит поле "stream".
		if out := modusAttachStream(raw, p.Camera); out != nil {
			w.Write(out)
			return
		}
		w.Write(raw)
		return
	}
	text := string(raw)
	if len(text) > 12000 {
		text = text[:12000]
	}
	json.NewEncoder(w).Encode(map[string]string{"raw": text})
}

const go2rtcAddr = "127.0.0.1:1984"

// modusAttachStream кладёт playback_url (одноразовый, живёт ~60 с) в go2rtc как поток camN
// и дописывает в ответ "stream":"camN". Если не получилось — nil, ответ уйдёт как есть.
func modusAttachStream(raw []byte, camera int) []byte {
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return nil
	}
	data, _ := doc["data"].(map[string]any)
	src, _ := data["playback_url"].(string)
	if !strings.HasPrefix(src, "rtsp://") {
		return nil
	}
	name := fmt.Sprintf("cam%d", camera)
	q := url.Values{"name": {name}, "src": {src}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://"+go2rtcAddr+"/api/streams?"+q.Encode(), nil)
	if err != nil {
		return nil
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("modus: go2rtc недоступен: %v", err)
		return nil
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("modus: go2rtc ответил HTTP %d", resp.StatusCode)
		return nil
	}
	delete(data, "playback_url") // сырую rtsp-ссылку с токеном браузеру не отдаём
	doc["stream"] = name
	out, err := json.Marshal(doc)
	if err != nil {
		return nil
	}
	return out
}

var go2rtcProxy = func() *httputil.ReverseProxy {
	p := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: go2rtcAddr})
	p.FlushInterval = -1 // живой поток без буферизации
	return p
}()

// homeCameraPlay — прокси к go2rtc: /api/cameras/play/api/stream.mp4?src=cam1 и HLS.
// Вешать только через карту api (PIN-сессия). Пускаем лишь потоки camN и три нужных пути.
func homeCameraPlay(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/cameras/play")
	okPath := rest == "/api/stream.mp4" || rest == "/api/stream.m3u8" || strings.HasPrefix(rest, "/api/hls/")
	if !okPath {
		http.NotFound(w, r)
		return
	}
	if s := r.URL.Query().Get("src"); s != "" && !strings.HasPrefix(s, "cam") {
		http.NotFound(w, r)
		return
	}
	r2 := r.Clone(r.Context())
	r2.URL.Path = rest
	q := r2.URL.Query()
	q.Del("token")
	r2.URL.RawQuery = q.Encode()
	go2rtcProxy.ServeHTTP(w, r2)
}

// app.js читает текст ошибки из поля "error" (FastAPI отдавал "detail" — фронт его не видел).
func modusError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
