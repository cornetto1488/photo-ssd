// Полезное в панели: VPN (жив ли, срок подписки), трафик, замер скорости, заметки, резервная копия роутера.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- VPN ----------

var vpnCache struct {
	sync.Mutex
	at  time.Time
	res map[string]any
}

const subURLFile = "/etc/zalet-sub.url"

func (p *homePortal) handleVPN(w http.ResponseWriter, r *http.Request) {
	vpnCache.Lock()
	defer vpnCache.Unlock()
	if vpnCache.res != nil && time.Since(vpnCache.at) < time.Minute && r.URL.Query().Get("fresh") == "" {
		writeJSON(w, http.StatusOK, vpnCache.res)
		return
	}
	res := map[string]any{}
	// 1) работает ли нода: запрос через SOCKS v2raya
	start := time.Now()
	ip, err := viaProxy("http://127.0.0.1:20171", "https://ifconfig.me/ip")
	res["ok"] = err == nil
	if err == nil {
		res["exitIP"] = ip
		res["ms"] = time.Since(start).Milliseconds()
	} else {
		res["error"] = err.Error()
	}
	// 2) подписка: срок и трафик из заголовка subscription-userinfo
	if b, err := os.ReadFile(subURLFile); err == nil {
		su := strings.TrimSpace(string(b))
		c := &http.Client{Timeout: 10 * time.Second}
		if resp, err := c.Get(su); err == nil {
			resp.Body.Close()
			info := map[string]int64{}
			for _, kv := range strings.Split(resp.Header.Get("subscription-userinfo"), ";") {
				k, v, ok := strings.Cut(strings.TrimSpace(kv), "=")
				if ok {
					n, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
					info[k] = n
				}
			}
			res["sub"] = info
			if u, err := url.Parse(su); err == nil {
				res["provider"] = u.Hostname()
			}
		}
	}
	vpnCache.res, vpnCache.at = res, time.Now()
	writeJSON(w, http.StatusOK, res)
}

func viaProxy(px, target string) (string, error) {
	pu, _ := url.Parse(px)
	c := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(pu)}, Timeout: 10 * time.Second}
	resp, err := c.Get(target)
	if err != nil {
		return "", fmt.Errorf("нода не отвечает")
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
	return strings.TrimSpace(string(b)), nil
}

// ---------- трафик ----------

func wanIface() string {
	out, _ := exec.Command("ip", "route", "show", "default").Output()
	f := strings.Fields(string(out))
	for i := range f {
		if f[i] == "dev" && i+1 < len(f) {
			return f[i+1]
		}
	}
	return "wan"
}

func (p *homePortal) handleTraffic(w http.ResponseWriter, r *http.Request) {
	ifc := wanIface()
	var rx, tx int64
	for _, l := range strings.Split(readFile("/proc/net/dev"), "\n") {
		name, rest, ok := strings.Cut(l, ":")
		if !ok || strings.TrimSpace(name) != ifc {
			continue
		}
		f := strings.Fields(rest)
		if len(f) >= 9 {
			rx, _ = strconv.ParseInt(f[0], 10, 64)
			tx, _ = strconv.ParseInt(f[8], 10, 64)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"iface": ifc, "rx": rx, "tx": tx, "t": time.Now().UnixMilli()})
}

// ---------- замер скорости ----------

var speedMu sync.Mutex

func (p *homePortal) handleSpeed(w http.ResponseWriter, r *http.Request) {
	if !speedMu.TryLock() {
		fail(w, http.StatusConflict, "замер уже идёт")
		return
	}
	defer speedMu.Unlock()
	urls := []string{
		"https://speed.cloudflare.com/__down?bytes=60000000",
		"http://speedtest.tele2.net/100MB.zip",
		"https://proof.ovh.net/files/100Mb.dat",
	}
	c := &http.Client{Timeout: 20 * time.Second}
	for _, u := range urls {
		t0 := time.Now()
		resp, err := c.Get(u)
		if err != nil {
			continue
		}
		ping := time.Since(t0).Milliseconds()
		var n int64
		buf := make([]byte, 64<<10)
		deadline := time.Now().Add(8 * time.Second)
		t1 := time.Now()
		for time.Now().Before(deadline) {
			k, err := resp.Body.Read(buf)
			n += int64(k)
			if err != nil {
				break
			}
		}
		resp.Body.Close()
		sec := time.Since(t1).Seconds()
		if n < 1<<20 || sec <= 0 {
			continue
		}
		mbps := float64(n) * 8 / sec / 1e6
		u2, _ := url.Parse(u)
		log.Printf("панель: замер скорости %.0f Мбит/с (%s)", mbps, u2.Hostname())
		writeJSON(w, http.StatusOK, map[string]any{"mbps": mbps, "ping": ping, "bytes": n, "server": u2.Hostname()})
		return
	}
	fail(w, http.StatusBadGateway, "не удалось замерить — серверы недоступны")
}

// ---------- заметки и покупки ----------

type homeNote struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Done bool   `json:"done"`
	List string `json:"list"` // notes / shop
	At   int64  `json:"at"`
}

var notesMu sync.Mutex

func (p *homePortal) handleNotes(w http.ResponseWriter, r *http.Request) {
	notesMu.Lock()
	defer notesMu.Unlock()
	path := p.s.meta("notes.json")
	var notes []homeNote
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &notes)
	}
	if r.Method == http.MethodPost {
		var req struct {
			Action string   `json:"action"` // add, toggle, delete, clear
			Note   homeNote `json:"note"`
		}
		json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req)
		switch req.Action {
		case "add":
			t := strings.TrimSpace(req.Note.Text)
			if t == "" {
				fail(w, http.StatusBadRequest, "пусто")
				return
			}
			if len(t) > 500 {
				t = t[:500]
			}
			l := req.Note.List
			if l != "shop" {
				l = "notes"
			}
			notes = append(notes, homeNote{ID: randHex(5), Text: t, List: l, At: time.Now().Unix()})
		case "toggle", "delete":
			for i := range notes {
				if notes[i].ID == req.Note.ID {
					if req.Action == "toggle" {
						notes[i].Done = !notes[i].Done
					} else {
						notes = append(notes[:i], notes[i+1:]...)
					}
					break
				}
			}
		case "clear": // убрать отмеченные в списке
			keep := notes[:0]
			for _, n := range notes {
				if !(n.Done && n.List == req.Note.List) {
					keep = append(keep, n)
				}
			}
			notes = keep
		}
		b, _ := json.Marshal(notes)
		os.WriteFile(path, b, 0o644)
	}
	if notes == nil {
		notes = []homeNote{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": notes})
}

// ---------- резервная копия настроек роутера ----------

func (p *homePortal) handleBackup(w http.ResponseWriter, r *http.Request) {
	f := "/tmp/zalet-backup.tar.gz"
	if out, err := exec.Command("sysupgrade", "-b", f).CombinedOutput(); err != nil {
		fail(w, http.StatusInternalServerError, strings.TrimSpace(string(out)))
		return
	}
	defer os.Remove(f)
	b, err := os.ReadFile(f)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	log.Printf("панель: резервная копия настроек (%s)", clientIP(r))
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="router-backup-%s.tar.gz"`, time.Now().Format("2006-01-02")))
	w.Write(b)
}
