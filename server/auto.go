// Автоматика дома: лента событий, уведомления в Telegram, расписания, «кто дома», присмотр за VPN.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---------- лента событий ----------

type homeEvent struct {
	T    int64  `json:"t"`
	Kind string `json:"kind"` // vpn, pc, presence, schedule, system, photo
	Text string `json:"text"`
}

var eventsMu sync.Mutex

func (p *homePortal) eventsPath() string { return p.s.meta("events.json") }

func (p *homePortal) event(kind, text string) {
	eventsMu.Lock()
	var list []homeEvent
	if b, err := os.ReadFile(p.eventsPath()); err == nil {
		json.Unmarshal(b, &list)
	}
	list = append(list, homeEvent{T: time.Now().Unix(), Kind: kind, Text: text})
	if len(list) > 400 {
		list = list[len(list)-400:]
	}
	b, _ := json.Marshal(list)
	os.WriteFile(p.eventsPath(), b, 0o644)
	eventsMu.Unlock()
	log.Printf("событие [%s] %s", kind, text)
	go p.telegram(kind, text)
}

func (p *homePortal) handleEvents(w http.ResponseWriter, r *http.Request) {
	eventsMu.Lock()
	var list []homeEvent
	if b, err := os.ReadFile(p.eventsPath()); err == nil {
		json.Unmarshal(b, &list)
	}
	eventsMu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].T > list[j].T })
	if len(list) > 150 {
		list = list[:150]
	}
	if list == nil {
		list = []homeEvent{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": list})
}

// ---------- Telegram ----------

const tgFile = "/etc/zalet-telegram.json"

type tgConfig struct {
	Token  string          `json:"token"`
	ChatID int64           `json:"chatId"`
	Kinds  map[string]bool `json:"kinds"` // какие события присылать
}

var tgMu sync.Mutex

func loadTG() tgConfig {
	var c tgConfig
	if b, err := os.ReadFile(tgFile); err == nil {
		json.Unmarshal(b, &c)
	}
	if c.Kinds == nil {
		c.Kinds = map[string]bool{"vpn": true, "pc": true, "presence": true, "schedule": false, "system": true}
	}
	return c
}

func saveTG(c tgConfig) { b, _ := json.Marshal(c); os.WriteFile(tgFile, b, 0o600) }

// tgCall — запрос к Bot API; сначала напрямую, если не вышло — через VPN роутера.
func tgCall(token, method string, params url.Values) (map[string]any, error) {
	u := "https://api.telegram.org/bot" + token + "/" + method
	var lastErr error
	for _, px := range []string{"", "http://127.0.0.1:20171"} {
		tr := &http.Transport{}
		if px != "" {
			pu, _ := url.Parse(px)
			tr.Proxy = http.ProxyURL(pu)
		}
		c := &http.Client{Transport: tr, Timeout: 12 * time.Second}
		resp, err := c.PostForm(u, params)
		if err != nil {
			lastErr = err
			continue
		}
		var out map[string]any
		json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out)
		resp.Body.Close()
		if ok, _ := out["ok"].(bool); !ok {
			return out, fmt.Errorf("%v", out["description"])
		}
		return out, nil
	}
	return nil, fmt.Errorf("Telegram недоступен: %v", lastErr)
}

func (p *homePortal) telegram(kind, text string) {
	tgMu.Lock()
	c := loadTG()
	tgMu.Unlock()
	if c.Token == "" || c.ChatID == 0 || !c.Kinds[kind] {
		return
	}
	icons := map[string]string{"vpn": "⛨", "pc": "🖥", "presence": "🏠", "schedule": "⏰", "system": "⚙️", "photo": "📷"}
	tgCall(c.Token, "sendMessage", url.Values{"chat_id": {fmt.Sprint(c.ChatID)}, "text": {icons[kind] + " " + text}})
}

func (p *homePortal) handleTelegram(w http.ResponseWriter, r *http.Request) {
	tgMu.Lock()
	defer tgMu.Unlock()
	c := loadTG()
	if r.Method == http.MethodPost {
		var req struct {
			Action string          `json:"action"` // token, detect, test, kinds, off
			Token  string          `json:"token"`
			Kinds  map[string]bool `json:"kinds"`
		}
		json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req)
		switch req.Action {
		case "token":
			t := strings.TrimSpace(req.Token)
			out, err := tgCall(t, "getMe", nil)
			if err != nil {
				fail(w, http.StatusBadRequest, "токен не подошёл: "+err.Error())
				return
			}
			c.Token, c.ChatID = t, 0
			saveTG(c)
			res, _ := out["result"].(map[string]any)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "bot": res["username"]})
			return
		case "detect": // пользователь написал боту — берём его чат
			out, err := tgCall(c.Token, "getUpdates", url.Values{"limit": {"20"}})
			if err != nil {
				fail(w, http.StatusBadGateway, err.Error())
				return
			}
			list, _ := out["result"].([]any)
			for i := len(list) - 1; i >= 0; i-- {
				u, _ := list[i].(map[string]any)
				msg, _ := u["message"].(map[string]any)
				chat, _ := msg["chat"].(map[string]any)
				if id, ok := chat["id"].(float64); ok {
					c.ChatID = int64(id)
					saveTG(c)
					tgCall(c.Token, "sendMessage", url.Values{"chat_id": {fmt.Sprint(c.ChatID)}, "text": {"🏠 ZALET HOME подключён. Сюда будут приходить уведомления о доме."}})
					writeJSON(w, http.StatusOK, map[string]any{"ok": true, "chatId": c.ChatID})
					return
				}
			}
			fail(w, http.StatusNotFound, "напишите боту любое сообщение и нажмите ещё раз")
			return
		case "test":
			if _, err := tgCall(c.Token, "sendMessage", url.Values{"chat_id": {fmt.Sprint(c.ChatID)}, "text": {"✅ Проверка: уведомления ZALET HOME работают"}}); err != nil {
				fail(w, http.StatusBadGateway, err.Error())
				return
			}
		case "kinds":
			for k, v := range req.Kinds {
				c.Kinds[k] = v
			}
			saveTG(c)
		case "off":
			c = tgConfig{Kinds: c.Kinds}
			saveTG(c)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": c.Token != "", "connected": c.ChatID != 0, "kinds": c.Kinds})
}

// ---------- расписания ----------

type schedule struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Time    string `json:"time"` // ЧЧ:ММ
	Days    []int  `json:"days"` // 0=вс … 6=сб; пусто — каждый день
	Action  string `json:"action"` // on, off, alloff, pc-on, pc-off, pc-sleep
	Device  string `json:"device,omitempty"`
	Enabled bool   `json:"enabled"`
	LastRun int64  `json:"lastRun,omitempty"`
}

var schedMu sync.Mutex

func (p *homePortal) schedPath() string { return p.s.meta("schedules.json") }

func (p *homePortal) loadSched() []schedule {
	var l []schedule
	if b, err := os.ReadFile(p.schedPath()); err == nil {
		json.Unmarshal(b, &l)
	}
	return l
}

func (p *homePortal) saveSched(l []schedule) { b, _ := json.Marshal(l); os.WriteFile(p.schedPath(), b, 0o644) }

func (p *homePortal) handleSchedules(w http.ResponseWriter, r *http.Request) {
	schedMu.Lock()
	defer schedMu.Unlock()
	l := p.loadSched()
	if r.Method == http.MethodPost {
		var req struct {
			Action   string   `json:"action"` // save, delete, run
			Schedule schedule `json:"schedule"`
		}
		json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req)
		s := req.Schedule
		switch req.Action {
		case "save":
			if _, err := time.Parse("15:04", s.Time); err != nil {
				fail(w, http.StatusBadRequest, "время в формате ЧЧ:ММ")
				return
			}
			if s.ID == "" {
				s.ID = randHex(4)
				l = append(l, s)
			} else {
				for i := range l {
					if l[i].ID == s.ID {
						s.LastRun = l[i].LastRun
						l[i] = s
					}
				}
			}
		case "delete":
			for i := range l {
				if l[i].ID == s.ID {
					l = append(l[:i], l[i+1:]...)
					break
				}
			}
		case "run":
			for _, x := range l {
				if x.ID == s.ID {
					go p.runSchedule(x)
				}
			}
		}
		p.saveSched(l)
	}
	if l == nil {
		l = []schedule{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"schedules": l, "now": time.Now().Format("15:04"), "tz": time.Now().Format("MST -07")})
}

func (p *homePortal) runSchedule(s schedule) {
	var err error
	switch s.Action {
	case "on", "off":
		on := s.Action == "on"
		code := "switch_1"
		p.devMu.Lock()
		for _, d := range p.devs {
			if d.ID == s.Device && d.Kind == "light" {
				code = "switch_led"
			}
		}
		p.devMu.Unlock()
		err = p.command(s.Device, []deviceState{{Code: code, Value: on}})
	case "alloff":
		p.allOff()
	case "pc-on":
		err = exec.Command("/usr/bin/pc-on").Run()
	case "pc-off":
		err = exec.Command("/usr/bin/pc-off").Run()
	case "pc-sleep":
		agent.mu.Lock()
		for _, h := range agent.hosts {
			h.qSys = append(h.qSys, pcCmd{ID: randHex(4), Action: "sleep", At: time.Now().Unix()})
		}
		agent.mu.Unlock()
	}
	if err != nil {
		p.event("schedule", "Расписание «"+s.Name+"» не сработало: "+err.Error())
	} else {
		p.event("schedule", "Сработало расписание «"+s.Name+"»")
	}
}

// allOff — выключить весь свет (для расписаний и «все ушли»).
func (p *homePortal) allOff() (done, failed int) {
	devs, _ := p.devices(false)
	for _, d := range devs {
		code := ""
		switch d.Kind {
		case "light":
			code = "switch_led"
		case "switch", "plug":
			code = "switch_1"
		}
		if code == "" || !d.Online {
			continue
		}
		if p.command(d.ID, []deviceState{{Code: code, Value: false}}) == nil {
			done++
		} else {
			failed++
		}
	}
	return
}

func (p *homePortal) schedLoop() {
	for {
		time.Sleep(20 * time.Second)
		now := time.Now()
		hm := now.Format("15:04")
		schedMu.Lock()
		l := p.loadSched()
		changed := false
		for i := range l {
			s := &l[i]
			if !s.Enabled || s.Time != hm || now.Unix()-s.LastRun < 90 {
				continue
			}
			if len(s.Days) > 0 {
				ok := false
				for _, d := range s.Days {
					if d == int(now.Weekday()) {
						ok = true
					}
				}
				if !ok {
					continue
				}
			}
			s.LastRun = now.Unix()
			changed = true
			go p.runSchedule(*s)
		}
		if changed {
			p.saveSched(l)
		}
		schedMu.Unlock()
	}
}

// ---------- кто дома ----------

type person struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	MACs  []string `json:"macs"`
	Home  bool     `json:"home"`
	Since int64    `json:"since"`
	Seen  int64    `json:"seen"`
}

type presenceCfg struct {
	People      []person `json:"people"`
	AwayAllOff  bool     `json:"awayAllOff"`  // все ушли — выключить свет
	ArriveOn    []string `json:"arriveOn"`    // пришёл — включить эти устройства
	ArriveNight bool     `json:"arriveNight"` // …только вечером и ночью
}

var presMu sync.Mutex

func (p *homePortal) presPath() string { return p.s.meta("presence.json") }

func (p *homePortal) loadPres() presenceCfg {
	var c presenceCfg
	if b, err := os.ReadFile(p.presPath()); err == nil {
		json.Unmarshal(b, &c)
	}
	return c
}

func (p *homePortal) savePres(c presenceCfg) { b, _ := json.Marshal(c); os.WriteFile(p.presPath(), b, 0o644) }

// wifiStations — MAC всех, кто сейчас подключён к Wi-Fi.
func wifiStations() map[string]bool {
	out := map[string]bool{}
	ifs, _ := exec.Command("sh", "-c", "iw dev 2>/dev/null | awk '/Interface/{print $2}'").Output()
	for _, ifc := range strings.Fields(string(ifs)) {
		st, _ := exec.Command("iw", "dev", ifc, "station", "dump").Output()
		for _, l := range strings.Split(string(st), "\n") {
			if f := strings.Fields(l); len(f) >= 2 && f[0] == "Station" {
				out[strings.ToUpper(f[1])] = true
			}
		}
	}
	// и проводные/спящие, но откликающиеся
	nb, _ := exec.Command("ip", "neigh", "show").Output()
	for _, l := range strings.Split(string(nb), "\n") {
		f := strings.Fields(l)
		if len(f) >= 6 && f[3] == "lladdr" && (f[len(f)-1] == "REACHABLE" || f[len(f)-1] == "DELAY" || f[len(f)-1] == "PROBE") {
			out[strings.ToUpper(f[4])] = true
		}
	}
	return out
}

func (p *homePortal) presenceLoop() {
	for {
		time.Sleep(30 * time.Second)
		online := wifiStations()
		now := time.Now().Unix()
		presMu.Lock()
		c := p.loadPres()
		wasAnyone := false
		for _, pr := range c.People {
			if pr.Home {
				wasAnyone = true
			}
		}
		changed, arrived := false, false
		for i := range c.People {
			pr := &c.People[i]
			here := false
			for _, m := range pr.MACs {
				if online[strings.ToUpper(m)] {
					here = true
				}
			}
			if here {
				pr.Seen = now
			}
			switch {
			case here && !pr.Home:
				pr.Home, pr.Since, changed, arrived = true, now, true, true
				go p.event("presence", pr.Name+" дома")
			case !here && pr.Home && now-pr.Seen > 10*60: // iPhone иногда отключает Wi-Fi во сне — ждём 10 минут
				pr.Home, pr.Since, changed = false, now, true
				go p.event("presence", pr.Name+" ушёл(а) из дома")
			}
		}
		anyone := false
		for _, pr := range c.People {
			if pr.Home {
				anyone = true
			}
		}
		if changed {
			p.savePres(c)
		}
		presMu.Unlock()
		if wasAnyone && !anyone && c.AwayAllOff && len(c.People) > 0 {
			go func() { d, _ := p.allOff(); p.event("presence", fmt.Sprintf("Дома никого — выключил свет (%d)", d)) }()
		}
		if arrived && !wasAnyone && len(c.ArriveOn) > 0 {
			h := time.Now().Hour()
			if !c.ArriveNight || h >= 17 || h < 7 {
				go func(ids []string) {
					for _, id := range ids {
						code := "switch_1"
						p.devMu.Lock()
						for _, d := range p.devs {
							if d.ID == id && d.Kind == "light" {
								code = "switch_led"
							}
						}
						p.devMu.Unlock()
						p.command(id, []deviceState{{Code: code, Value: true}})
					}
					p.event("presence", "С возвращением! Включил свет")
				}(c.ArriveOn)
			}
		}
	}
}

func (p *homePortal) handlePresence(w http.ResponseWriter, r *http.Request) {
	presMu.Lock()
	defer presMu.Unlock()
	c := p.loadPres()
	if r.Method == http.MethodPost {
		var req struct {
			Action string      `json:"action"` // person, delete, settings
			Person person      `json:"person"`
			Cfg    presenceCfg `json:"cfg"`
		}
		json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req)
		switch req.Action {
		case "person":
			pr := req.Person
			for i := range pr.MACs {
				pr.MACs[i] = strings.ToUpper(strings.TrimSpace(pr.MACs[i]))
			}
			if pr.ID == "" {
				pr.ID = randHex(4)
				c.People = append(c.People, pr)
			} else {
				for i := range c.People {
					if c.People[i].ID == pr.ID {
						pr.Home, pr.Since, pr.Seen = c.People[i].Home, c.People[i].Since, c.People[i].Seen
						c.People[i] = pr
					}
				}
			}
		case "delete":
			for i := range c.People {
				if c.People[i].ID == req.Person.ID {
					c.People = append(c.People[:i], c.People[i+1:]...)
					break
				}
			}
		case "settings":
			c.AwayAllOff, c.ArriveOn, c.ArriveNight = req.Cfg.AwayAllOff, req.Cfg.ArriveOn, req.Cfg.ArriveNight
		}
		p.savePres(c)
	}
	if c.People == nil {
		c.People = []person{}
	}
	writeJSON(w, http.StatusOK, c)
}

// ---------- присмотр за VPN ----------

func (p *homePortal) vpnLoop() {
	var lastOK *bool
	lastWarn := ""
	for {
		_, err := viaProxy("http://127.0.0.1:20171", "https://ifconfig.me/ip")
		ok := err == nil
		if lastOK != nil && *lastOK != ok {
			if ok {
				p.event("vpn", "VPN снова работает")
			} else {
				p.event("vpn", "VPN-нода не отвечает — заблокированные сайты и Telegram сейчас не работают")
			}
		}
		lastOK = &ok
		// срок подписки — раз в сутки
		if b, err := os.ReadFile(subURLFile); err == nil && lastWarn != time.Now().Format("2006-01-02") {
			c := &http.Client{Timeout: 10 * time.Second}
			if resp, err := c.Get(strings.TrimSpace(string(b))); err == nil {
				resp.Body.Close()
				for _, kv := range strings.Split(resp.Header.Get("subscription-userinfo"), ";") {
					k, v, _ := strings.Cut(strings.TrimSpace(kv), "=")
					if k == "expire" {
						var exp int64
						fmt.Sscan(v, &exp)
						if left := exp - time.Now().Unix(); exp > 0 && left < 3*86400 {
							lastWarn = time.Now().Format("2006-01-02")
							if left < 0 {
								p.event("vpn", "Подписка VPN истекла — продлите на vpnushka.lol")
							} else {
								p.event("vpn", fmt.Sprintf("Подписка VPN закончится через %d ч — продлите на vpnushka.lol", left/3600))
							}
						}
					}
				}
			}
		}
		time.Sleep(2 * time.Minute)
	}
}

var _ = bytes.NewReader
