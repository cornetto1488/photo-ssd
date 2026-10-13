// Агент ZALET на компьютерах (Windows и Linux): присылает состояние (процессор, память, диски,
// температура), по запросу — скриншот, выполняет команды (сон, выключение, таймеры, блокировка, сообщение).
// Агенты сами ходят на роутер (http://192.168.1.1/pcagent/...), ключ — в /etc/zalet-agent.key.
// Компьютеров может быть несколько: каждый узнаётся по имени (host).
package main

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const agentKeyFile = "/etc/zalet-agent.key"

type pcCmd struct {
	ID      string `json:"id"`
	Action  string `json:"action"` // shot, sleep, hibernate, shutdown, restart, lock, cancel, timer, message, mute, volume
	Minutes int    `json:"minutes,omitempty"`
	Mode    string `json:"mode,omitempty"`
	Text    string `json:"text,omitempty"`
	Host    string `json:"host,omitempty"`
	At      int64  `json:"at"`
}

// команды, которым нужен сеанс пользователя (экран)
var userActions = map[string]bool{"shot": true, "lock": true, "message": true, "mute": true, "volume": true}

type pcHost struct {
	stats    map[string]any
	user     map[string]any
	seen     time.Time // фоновая часть
	userSeen time.Time // часть в сеансе
	qSys     []pcCmd
	qUser    []pcCmd
	shot     []byte
	shotAt   time.Time
	history  []map[string]any
}

type pcAgents struct {
	mu    sync.Mutex
	key   string
	hosts map[string]*pcHost
}

var agent = &pcAgents{hosts: map[string]*pcHost{}}

func (a *pcAgents) loadKey() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.key != "" {
		return a.key
	}
	if b, err := os.ReadFile(agentKeyFile); err == nil && len(strings.TrimSpace(string(b))) >= 16 {
		a.key = strings.TrimSpace(string(b))
		return a.key
	}
	a.key = randHex(24)
	os.WriteFile(agentKeyFile, []byte(a.key+"\n"), 0o600)
	return a.key
}

func (a *pcAgents) authOK(r *http.Request) bool {
	k := r.Header.Get("X-Agent-Key")
	want := a.loadKey()
	return k != "" && subtle.ConstantTimeCompare([]byte(k), []byte(want)) == 1
}

func (a *pcAgents) host(name string) *pcHost {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "ПК"
	}
	h := a.hosts[name]
	if h == nil {
		h = &pcHost{}
		a.hosts[name] = h
	}
	return h
}

// POST /pcagent/report?role=system|user — агент присылает состояние, в ответ получает команды.
func (p *homePortal) handleAgentReport(w http.ResponseWriter, r *http.Request) {
	if !agent.authOK(r) {
		fail(w, http.StatusUnauthorized, "неверный ключ агента")
		return
	}
	var st map[string]any
	json.NewDecoder(io.LimitReader(r.Body, 256<<10)).Decode(&st)
	name, _ := st["host"].(string)
	role := r.URL.Query().Get("role")
	agent.mu.Lock()
	h := agent.host(name)
	var q []pcCmd
	if role == "user" {
		h.user, h.userSeen = st, time.Now()
		q, h.qUser = h.qUser, nil
	} else {
		if h.seen.IsZero() || time.Since(h.seen) > 2*time.Minute {
			go p.event("pc", "Компьютер «"+name+"» на связи")
		}
		h.stats, h.seen = st, time.Now()
		h.history = append(h.history, map[string]any{"t": time.Now().Unix(), "cpu": st["cpu"], "ram": st["ramPct"], "temp": firstNum(st["gpuTemp"], st["cpuTemp"])})
		if len(h.history) > 400 {
			h.history = h.history[len(h.history)-400:]
		}
		q, h.qSys = h.qSys, nil
	}
	agent.mu.Unlock()
	if q == nil {
		q = []pcCmd{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"commands": q})
}

func firstNum(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

// POST /pcagent/shot?host= — агент присылает скриншот (JPEG).
func (p *homePortal) handleAgentShot(w http.ResponseWriter, r *http.Request) {
	if !agent.authOK(r) {
		fail(w, http.StatusUnauthorized, "неверный ключ агента")
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 12<<20))
	if err != nil || len(b) < 100 {
		fail(w, http.StatusBadRequest, "пустой скриншот")
		return
	}
	agent.mu.Lock()
	h := agent.host(r.URL.Query().Get("host"))
	h.shot, h.shotAt = b, time.Now()
	agent.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET/POST /api/home/pc/agent — список компьютеров для панели и команды им.
func (p *homePortal) handlePCAgent(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var c pcCmd
		json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&c)
		switch c.Action {
		case "shot", "sleep", "hibernate", "shutdown", "restart", "lock", "cancel", "timer", "message", "mute", "volume":
		default:
			fail(w, http.StatusBadRequest, "неизвестная команда")
			return
		}
		if len(c.Text) > 300 {
			c.Text = c.Text[:300]
		}
		c.ID, c.At = randHex(4), time.Now().Unix()
		agent.mu.Lock()
		h := agent.hosts[c.Host]
		if h == nil {
			agent.mu.Unlock()
			fail(w, http.StatusNotFound, "компьютер не найден")
			return
		}
		if userActions[c.Action] {
			if time.Since(h.userSeen) > 30*time.Second {
				agent.mu.Unlock()
				fail(w, http.StatusConflict, "на компьютере никто не вошёл в систему — скриншот и сообщения недоступны")
				return
			}
			h.qUser = append(h.qUser, c)
		} else {
			h.qSys = append(h.qSys, c)
		}
		agent.mu.Unlock()
		log.Printf("панель: команда ПК «%s»: %s %d мин (%s)", c.Host, c.Action, c.Minutes, clientIP(r))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": c.ID})
		return
	}
	agent.mu.Lock()
	defer agent.mu.Unlock()
	list := []map[string]any{}
	for name, h := range agent.hosts {
		item := map[string]any{"host": name, "online": time.Since(h.seen) < 30*time.Second, "session": time.Since(h.userSeen) < 30*time.Second,
			"stats": h.stats, "user": h.user, "history": h.history}
		if !h.seen.IsZero() {
			item["seen"] = h.seen.Unix()
		}
		if !h.shotAt.IsZero() {
			item["shotAt"] = h.shotAt.Unix()
		}
		list = append(list, item)
	}
	sort.Slice(list, func(i, j int) bool { return fmt.Sprint(list[i]["host"]) < fmt.Sprint(list[j]["host"]) })
	writeJSON(w, http.StatusOK, map[string]any{"agents": list})
}

func (p *homePortal) handlePCShot(w http.ResponseWriter, r *http.Request) {
	agent.mu.Lock()
	var b []byte
	if h := agent.hosts[r.URL.Query().Get("host")]; h != nil {
		b = h.shot
	}
	agent.mu.Unlock()
	if b == nil {
		fail(w, http.StatusNotFound, "скриншота ещё нет")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}

// GET /api/home/pc/download?os=windows|linux&voice=1 — агент с вшитыми настройками (ключ, адрес роутера).
func (p *homePortal) handleAgentDownload(w http.ResponseWriter, r *http.Request) {
	osName := r.URL.Query().Get("os")
	file, name := "portal/agent/zalet-agent.exe", "ZALET-Agent.exe"
	if osName == "linux" {
		file, name = "portal/agent/zalet-agent-linux", "zalet-agent"
	}
	b, err := portalFS.ReadFile(file)
	if err != nil {
		fail(w, http.StatusNotFound, "агент для этой системы не собран")
		return
	}
	cfg, _ := json.Marshal(map[string]any{"router": "http://192.168.1.1", "key": agent.loadKey(), "voice": r.URL.Query().Get("voice") == "1"})
	out := append(append(append([]byte{}, b...), []byte("\nZALETCFG")...), cfg...)
	log.Printf("панель: скачан агент %s (%s)", osName, clientIP(r))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Content-Length", fmt.Sprint(len(out)))
	w.Write(out)
}
