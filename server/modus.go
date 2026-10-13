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
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	modusLiveURL     = "https://api.modus-omsk.ru/api/clients/cameras/live-url"
	modusAPIURL      = "https://api.modus-omsk.ru/api/clients/cameras/archive-url"
	modusMaxPeriodMs = 24 * 60 * 60 * 1000
	modusItemKeyFmt  = "cam:194.186.196.248:34567:%d"
)

type modusArchiveRequest struct {
	Live    bool   `json:"live"` // прямой эфир: отдельный эндпоинт Modus live-url, период не нужен
	Slot    string `json:"slot"` // "" — плеер, "h" — плитка главной (отдельный поток go2rtc)
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
	sessionID := modusSessionID()
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
	case p.Slot != "" && p.Slot != "h":
		modusError(w, http.StatusBadRequest, "Некорректный слот")
		return
	case p.Camera < 1 || p.Camera > 96:
		modusError(w, http.StatusBadRequest, "Номер камеры должен быть от 1 до 96")
		return
	case !p.Live && (p.StartMs <= 0 || p.EndMs <= 0 || p.StartMs >= p.EndMs):
		modusError(w, http.StatusBadRequest, "Некорректный период архива")
		return
	case !p.Live && p.EndMs-p.StartMs > modusMaxPeriodMs:
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
		if out := modusAttachStream(raw, p.streamName()); out != nil {
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
	apiURL := modusAPIURL
	req0 := map[string]any{
		"start_ms": p.StartMs,
		"end_ms":   p.EndMs,
		"item_key": fmt.Sprintf(modusItemKeyFmt, p.Camera),
	}
	if p.Live {
		apiURL = modusLiveURL
		req0 = map[string]any{"item_key": fmt.Sprintf(modusItemKeyFmt, p.Camera)}
	}
	body, _ := json.Marshal(req0)
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewReader(body))
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

// Ссылка Modus одноразовая, а <video> делает несколько запросов подряд и переподключается.
// Поэтому помним последний период камеры и при ответе go2rtc «ссылка использована»
// берём свежую и повторяем запрос — браузер этого не замечает.
var (
	modusMu   sync.Mutex
	modusLast = map[string]modusArchiveRequest{}
	modusGen  = map[string]int{}
)

func (p modusArchiveRequest) streamName() string { return fmt.Sprintf("cam%d%s", p.Camera, p.Slot) }

func modusRemember(p modusArchiveRequest) {
	modusMu.Lock()
	modusLast[p.streamName()] = p
	modusGen[p.streamName()]++
	modusMu.Unlock()
}

func modusGeneration(name string) int {
	modusMu.Lock()
	defer modusMu.Unlock()
	return modusGen[name]
}

// modusForceRefresh берёт новую ссылку для camN, если с момента gen её никто не обновлял.
func modusForceRefresh(ctx context.Context, name string, gen int) bool {
	modusMu.Lock()
	defer modusMu.Unlock()
	if modusGen[name] != gen {
		return true // параллельный запрос уже обновил
	}
	p, ok := modusLast[name]
	if !ok {
		return false
	}
	sessionID := modusSessionID()
	if sessionID == "" {
		return false
	}
	now := time.Now().UnixMilli()
	if p.EndMs > now { // прямой эфир: начинаем с текущей секунды
		p.StartMs = now - 2000
		modusLast[name] = p
	}
	raw, _, msg := modusFetch(ctx, sessionID, p)
	if msg != "" || modusAttachStream(raw, name) == nil {
		return false
	}
	modusGen[name]++
	return true
}

const go2rtcAddr = "127.0.0.1:1984"

// modusAttachStream кладёт playback_url (одноразовый, живёт ~60 с) в go2rtc как поток camN
// и дописывает в ответ "stream":"camN". Если не получилось — nil, ответ уйдёт как есть.
func modusAttachStream(raw []byte, name string) []byte {
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return nil
	}
	data, _ := doc["data"].(map[string]any)
	src, _ := data["playback_url"].(string)
	if src == "" {
		src, _ = data["live_url"].(string)
	}
	if !strings.HasPrefix(src, "rtsp://") {
		return nil
	}
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
	delete(data, "playback_url")
	delete(data, "live_url") // сырую rtsp-ссылку с токеном браузеру не отдаём
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
	isStream := rest == "/api/stream.mp4" || rest == "/api/stream.m3u8"
	if !isStream && !strings.HasPrefix(rest, "/api/hls/") {
		http.NotFound(w, r)
		return
	}
	src := r.URL.Query().Get("src")
	if src != "" && !go2rtcNameRe.MatchString(src) {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	q.Del("token")
	if !isStream {
		r2 := r.Clone(r.Context())
		r2.URL.Path, r2.URL.RawQuery = rest, q.Encode()
		go2rtcProxy.ServeHTTP(w, r2)
		return
	}
		target := "http://" + go2rtcAddr + rest + "?" + q.Encode()
	for attempt := 0; ; attempt++ {
		gen := modusGeneration(src)
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
		if err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		resp, err := go2rtcStreamClient.Do(req)
		if err != nil {
			if r.Context().Err() == nil {
				http.Error(w, "go2rtc недоступен", http.StatusBadGateway)
			}
			return
		}
		if resp.StatusCode >= 500 {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			if attempt < 2 && modusForceRefresh(r.Context(), src, gen) {
				continue
			}
			http.Error(w, "Не удалось подключиться к камере", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		for _, h := range []string{"Content-Type", "Cache-Control"} {
			if v := resp.Header.Get(h); v != "" {
				w.Header().Set(h, v)
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(resp.StatusCode)
		fl, _ := w.(http.Flusher)
		buf := make([]byte, 32<<10)
		for {
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				if _, werr := w.Write(buf[:n]); werr != nil {
					return
				}
				if fl != nil {
					fl.Flush()
				}
			}
			if rerr != nil {
				return
			}
		}
	}
}

var go2rtcNameRe = regexp.MustCompile(`^cam[0-9]{1,2}h?$`)

var go2rtcStreamClient = &http.Client{} // без таймаута: поток живой

// app.js читает текст ошибки из поля "error" (FastAPI отдавал "detail" — фронт его не видел).
func modusError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
