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
	"strconv"
	"strings"
	"sync"
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

	raw, status, msg := modusFetch(r.Context(), sessionID, p)
	if msg != "" {
		modusError(w, status, msg)
		return
	}
	modusRemember(p)

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

// modusFetch просит у Modus ссылку на архив. При ошибке возвращает текст для браузера и HTTP-статус.
func modusFetch(parent context.Context, sessionID string, p modusArchiveRequest) (raw []byte, status int, msg string) {
	body, _ := json.Marshal(map[string]any{
		"start_ms": p.StartMs,
		"end_ms":   p.EndMs,
		"item_key": fmt.Sprintf(modusItemKeyFmt, p.Camera),
	})
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, modusAPIURL, bytes.NewReader(body))
	if err != nil {
		return nil, http.StatusInternalServerError, "Не удалось собрать запрос к Modus API"
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
			return nil, http.StatusGatewayTimeout, "Modus API не ответил вовремя"
		}
		log.Printf("modus: request error: %v", err)
		return nil, http.StatusBadGateway, "Не удалось связаться с Modus API"
	}
	defer resp.Body.Close()
	raw, err = io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, http.StatusBadGateway, "Не удалось прочитать ответ Modus API"
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, http.StatusBadGateway, "Сессия Modus истекла или не имеет доступа"
	}
	if resp.StatusCode >= 400 {
		// Заголовки/куки и креды в браузер не отдаём.
		return nil, http.StatusBadGateway, fmt.Sprintf("Modus API вернул HTTP %d", resp.StatusCode)
	}
	return raw, 0, ""
}

// Ссылка Modus одноразовая, а <video> часто делает 2 запроса (проверка + основной) или переподключается.
// Поэтому помним последний период камеры и берём свежую ссылку, когда у потока нет зрителей.
var (
	modusMu   sync.Mutex
	modusLast = map[int]modusArchiveRequest{}
)

func modusRemember(p modusArchiveRequest) {
	modusMu.Lock()
	modusLast[p.Camera] = p
	modusMu.Unlock()
}

// modusRefresh обновляет источник потока camN, если на нём никто не смотрит.
func modusRefresh(ctx context.Context, camera int) {
	modusMu.Lock()
	defer modusMu.Unlock()
	p, ok := modusLast[camera]
	if !ok {
		return
	}
	var st struct {
		Consumers []any `json:"consumers"`
	}
	c, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if req, err := http.NewRequestWithContext(c, http.MethodGet, fmt.Sprintf("http://%s/api/streams?src=cam%d", go2rtcAddr, camera), nil); err == nil {
		if resp, err := http.DefaultClient.Do(req); err == nil {
			json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&st)
			resp.Body.Close()
		}
	}
	if len(st.Consumers) > 0 {
		return
	}
	sessionID := strings.TrimSpace(os.Getenv("MODUS_SESSION_ID"))
	if sessionID == "" {
		return
	}
	if raw, _, msg := modusFetch(ctx, sessionID, p); msg == "" {
		modusAttachStream(raw, camera)
	}
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
	src := r.URL.Query().Get("src")
	if src != "" && !strings.HasPrefix(src, "cam") {
		http.NotFound(w, r)
		return
	}
	if n, err := strconv.Atoi(strings.TrimPrefix(src, "cam")); err == nil && (rest == "/api/stream.mp4" || rest == "/api/stream.m3u8") {
		modusRefresh(r.Context(), n)
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
