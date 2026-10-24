// Статистика ZALET HOME: сколько и когда горел свет, история скорости интернета,
// трафик WAN и по устройствам. Всё лежит в /mnt/ssd/.router/stats (JSONL, дописывается).
package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const statsDir = "/mnt/ssd/.router/stats"

var statsMu sync.Mutex

func statsAppend(name string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	statsMu.Lock()
	defer statsMu.Unlock()
	os.MkdirAll(statsDir, 0o755)
	f, err := os.OpenFile(filepath.Join(statsDir, name), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	f.Write(append(b, '\n'))
	f.Close()
}

// statsRead читает JSONL построчно, отдавая только строки со временем t >= since.
func statsRead(name string, since int64, each func(raw []byte)) {
	statsMu.Lock()
	b, err := os.ReadFile(filepath.Join(statsDir, name))
	statsMu.Unlock()
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(b), "\n") {
		if line == "" {
			continue
		}
		var h struct {
			T int64 `json:"t"`
		}
		if json.Unmarshal([]byte(line), &h) != nil || h.T < since {
			continue
		}
		each([]byte(line))
	}
}

// statsPrune убирает записи старше keepDays (при старте).
func statsPrune(name string, keepDays int) {
	cut := time.Now().AddDate(0, 0, -keepDays).Unix()
	statsMu.Lock()
	defer statsMu.Unlock()
	path := filepath.Join(statsDir, name)
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var keep []string
	changed := false
	for _, line := range strings.Split(string(b), "\n") {
		if line == "" {
			continue
		}
		var h struct {
			T int64 `json:"t"`
		}
		if json.Unmarshal([]byte(line), &h) == nil && h.T >= cut {
			keep = append(keep, line)
		} else {
			changed = true
		}
	}
	if changed {
		os.WriteFile(path, []byte(strings.Join(keep, "\n")+"\n"), 0o644)
	}
}

// ---------- свет ----------

type lightEv struct {
	T    int64  `json:"t"`
	ID   string `json:"id"`
	Name string `json:"n"`
	Room string `json:"r,omitempty"`
	Kind string `json:"k"`
	On   bool   `json:"on"`
}

var (
	statsLMu sync.Mutex
	statsLMem   = map[string]bool{}
	statsLInit  bool
)

// deviceOn — горит ли устройство (выключатель / розетка / лампа).
func deviceOn(d homeDevice) (on, known bool) {
	switch d.Kind {
	case "switch", "plug":
		isOn := false
		seen := false
		for _, s := range d.Status {
			if strings.HasPrefix(s.Code, "switch") {
				if b, ok := s.Value.(bool); ok {
					seen = true
					isOn = isOn || b
				}
			}
		}
		return isOn, seen
	case "light":
		if v, _, ok := stateVal(d.Status, "switch_led"); ok {
			b, _ := v.(bool)
			return b, true
		}
		if d.Power != "" {
			return d.Power == "on", true
		}
	}
	return false, false
}

// statsLights вызывается после каждого свежего опроса устройств и пишет только изменения.
func (p *homePortal) statsLights(devs []homeDevice) {
	statsLMu.Lock()
	defer statsLMu.Unlock()
	if !statsLInit {
		statsLInit = true
		statsRead("lights.jsonl", 0, func(raw []byte) {
			var e lightEv
			if json.Unmarshal(raw, &e) == nil {
				statsLMem[e.ID] = e.On
			}
		})
	}
	now := time.Now().Unix()
	for _, d := range devs {
		if d.Kind != "switch" && d.Kind != "plug" && d.Kind != "light" {
			continue
		}
		if !d.Online {
			continue
		}
		on, known := deviceOn(d)
		if !known {
			continue
		}
		if prev, ok := statsLMem[d.ID]; ok && prev == on {
			continue
		}
		statsLMem[d.ID] = on
		statsAppend("lights.jsonl", lightEv{T: now, ID: d.ID, Name: d.Name, Room: d.Room, Kind: d.Kind, On: on})
	}
}

// GET /api/home/stats/lights?days=14
func (p *homePortal) handleStatsLights(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days < 1 || days > 90 {
		days = 14
	}
	now := time.Now()
	loc := now.Location()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	start := midnight.AddDate(0, 0, -(days - 1))

	type devAgg struct {
		ID, Name, Room, Kind string
		evs                  []lightEv
	}
	byDev := map[string]*devAgg{}
	var order []string
	statsRead("lights.jsonl", 0, func(raw []byte) {
		var e lightEv
		if json.Unmarshal(raw, &e) != nil {
			return
		}
		a := byDev[e.ID]
		if a == nil {
			a = &devAgg{ID: e.ID}
			byDev[e.ID] = a
			order = append(order, e.ID)
		}
		a.Name, a.Room, a.Kind = e.Name, e.Room, e.Kind
		a.evs = append(a.evs, e)
	})

	type devOut struct {
		ID    string  `json:"id"`
		Name  string  `json:"name"`
		Room  string  `json:"room"`
		Kind  string  `json:"kind"`
		Days  []int64 `json:"days"` // секунд «горел» в каждом дне, от старого к новому
		Total int64   `json:"total"`
		On    bool    `json:"on"`
		Since int64   `json:"since"` // когда включился (если сейчас горит)
		Count int     `json:"count"` // сколько раз включали за период
	}
	hours := make([]int64, 24) // суммарно по всем устройствам, по часам суток
	dayTotals := make([]int64, days)
	out := []devOut{}
	for _, id := range order {
		a := byDev[id]
		do := devOut{ID: a.ID, Name: a.Name, Room: a.Room, Kind: a.Kind, Days: make([]int64, days)}
		on := false
		var onAt int64
		addInterval := func(from, to int64) {
			if to <= from {
				return
			}
			for t := from; t < to; {
				tm := time.Unix(t, 0).In(loc)
				dayEnd := time.Date(tm.Year(), tm.Month(), tm.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, 1).Unix()
				hourEnd := time.Date(tm.Year(), tm.Month(), tm.Day(), tm.Hour(), 0, 0, 0, loc).Add(time.Hour).Unix()
				end := to
				if dayEnd < end {
					end = dayEnd
				}
				if hourEnd < end {
					end = hourEnd
				}
				if t >= start.Unix() {
					idx := int(time.Date(tm.Year(), tm.Month(), tm.Day(), 0, 0, 0, 0, loc).Sub(start).Hours()/24 + 0.5)
					if idx >= 0 && idx < days {
						do.Days[idx] += end - t
						dayTotals[idx] += end - t
						do.Total += end - t
						hours[tm.Hour()] += end - t
					}
				}
				t = end
			}
		}
		for _, e := range a.evs {
			if e.On && !on {
				on, onAt = true, e.T
				if e.T >= start.Unix() {
					do.Count++
				}
			} else if !e.On && on {
				addInterval(onAt, e.T)
				on = false
			}
		}
		if on {
			addInterval(onAt, now.Unix())
			do.On, do.Since = true, onAt
		}
		out = append(out, do)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Total > out[j].Total })
	labels := make([]string, days)
	for i := 0; i < days; i++ {
		labels[i] = start.AddDate(0, 0, i).Format("2006-01-02")
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": out, "labels": labels, "dayTotals": dayTotals, "hours": hours, "days": days})
}

// ---------- сеть ----------

type speedRec struct {
	T    int64   `json:"t"`
	Mbps float64 `json:"mbps"`
	Ping int64   `json:"ping"`
	Src  string  `json:"src"` // auto / manual
}

type wanRec struct {
	T  int64 `json:"t"`
	Rx int64 `json:"rx"`
	Tx int64 `json:"tx"`
}

type cliRec struct {
	T int64              `json:"t"`
	C map[string][2]int64 `json:"c"` // ip -> [upload, download]
}

type ctKey struct {
	proto, src, dst, sp, dp string
}

var (
	ctPrev   = map[ctKey][2]int64{}
	ctPrevOK bool
)

func isLANAddr(ip string) bool {
	return strings.HasPrefix(ip, "192.168.1.") || strings.HasPrefix(ip, "10.10.10.")
}

func isPrivateAddr(ip string) bool {
	return strings.HasPrefix(ip, "192.168.") || strings.HasPrefix(ip, "10.") || strings.HasPrefix(ip, "127.") ||
		strings.HasPrefix(ip, "100.") || strings.HasPrefix(ip, "172.16.") || strings.HasPrefix(ip, "fe80") || strings.HasPrefix(ip, "169.254.")
}

// ctSample читает conntrack (учёт байт включён) и возвращает прирост по LAN-клиентам с прошлого замера.
func ctSample() map[string][2]int64 {
	b, err := os.ReadFile("/proc/net/nf_conntrack")
	if err != nil {
		return nil
	}
	cur := map[ctKey][2]int64{}
	res := map[string][2]int64{}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 8 {
			continue
		}
		var k ctKey
		k.proto = f[2]
		var nb int
		var up, down int64
		for _, x := range f {
			switch {
			case strings.HasPrefix(x, "src=") && k.src == "":
				k.src = x[4:]
			case strings.HasPrefix(x, "dst=") && k.dst == "":
				k.dst = x[4:]
			case strings.HasPrefix(x, "sport=") && k.sp == "":
				k.sp = x[6:]
			case strings.HasPrefix(x, "dport=") && k.dp == "":
				k.dp = x[6:]
			case strings.HasPrefix(x, "bytes="):
				v, _ := strconv.ParseInt(x[6:], 10, 64)
				if nb == 0 {
					up = v
				} else if nb == 1 {
					down = v
				}
				nb++
			}
		}
		if nb < 2 || !isLANAddr(k.src) || isPrivateAddr(k.dst) {
			continue
		}
		cur[k] = [2]int64{up, down}
		if !ctPrevOK {
			continue
		}
		pv := ctPrev[k]
		du, dd := up-pv[0], down-pv[1]
		if du < 0 {
			du = up
		}
		if dd < 0 {
			dd = down
		}
		if du > 0 || dd > 0 {
			a := res[k.src]
			res[k.src] = [2]int64{a[0] + du, a[1] + dd}
		}
	}
	ctPrev, ctPrevOK = cur, true
	return res
}

func wanBytes() (rx, tx int64) {
	ifc := wanIface()
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
	return
}

// statsLoop: каждые 30 с собирает трафик, раз в 5 минут сбрасывает в файлы,
// каждые 3 минуты опрашивает свет, раз в 6 часов меряет скорость.
func (p *homePortal) statsLoop() {
	for _, f := range []string{"lights.jsonl", "speed.jsonl", "wan.jsonl", "clients.jsonl"} {
		days := 400
		if f == "wan.jsonl" || f == "clients.jsonl" {
			days = 35
		}
		statsPrune(f, days)
	}
	const bucket = 300
	var (
		bStart             = time.Now().Unix() / bucket * bucket
		lastRx, lastTx     int64
		accRx, accTx       int64
		accCli             = map[string][2]int64{}
		haveWan            bool
		nextLights         = time.Now().Add(20 * time.Second)
		nextSpeed          = time.Now().Add(3 * time.Minute)
		tick               = time.NewTicker(30 * time.Second)
	)
	defer tick.Stop()
	for range tick.C {
		now := time.Now()
		rx, tx := wanBytes()
		if haveWan {
			if rx >= lastRx {
				accRx += rx - lastRx
			}
			if tx >= lastTx {
				accTx += tx - lastTx
			}
		}
		lastRx, lastTx, haveWan = rx, tx, true
		for ip, v := range ctSample() {
			a := accCli[ip]
			accCli[ip] = [2]int64{a[0] + v[0], a[1] + v[1]}
		}
		if now.Unix()-bStart >= bucket {
			statsAppend("wan.jsonl", wanRec{T: bStart, Rx: accRx, Tx: accTx})
			if len(accCli) > 0 {
				statsAppend("clients.jsonl", cliRec{T: bStart, C: accCli})
			}
			bStart, accRx, accTx, accCli = now.Unix()/bucket*bucket, 0, 0, map[string][2]int64{}
		}
		if now.After(nextLights) {
			nextLights = now.Add(3 * time.Minute)
			if p.tuya != nil {
				go p.devices(false) // из кэша: облако само не чаще раза в 10 минут
			}
		}
		if now.After(nextSpeed) {
			nextSpeed = now.Add(6 * time.Hour)
			go func() {
				if res, err := runSpeedTest(); err == nil {
					statsAppend("speed.jsonl", speedRec{T: time.Now().Unix(), Mbps: res.Mbps, Ping: res.Ping, Src: "auto"})
				}
			}()
		}
	}
}

// GET /api/home/stats/net?hours=24
func (p *homePortal) handleStatsNet(w http.ResponseWriter, r *http.Request) {
	hours, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	if hours < 1 || hours > 24*30 {
		hours = 24
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour).Unix()
	speed := []speedRec{}
	statsRead("speed.jsonl", since, func(raw []byte) {
		var s speedRec
		if json.Unmarshal(raw, &s) == nil {
			speed = append(speed, s)
		}
	})
	// WAN и клиенты складываем в корзины: 1 ч для суток и меньше, иначе 1 сутки
	step := int64(3600)
	if hours > 48 {
		step = 86400
	}
	type wanOut struct {
		T  int64 `json:"t"`
		Rx int64 `json:"rx"`
		Tx int64 `json:"tx"`
	}
	wanMap := map[int64]*wanOut{}
	statsRead("wan.jsonl", since, func(raw []byte) {
		var x wanRec
		if json.Unmarshal(raw, &x) != nil {
			return
		}
		k := x.T / step * step
		o := wanMap[k]
		if o == nil {
			o = &wanOut{T: k}
			wanMap[k] = o
		}
		o.Rx += x.Rx
		o.Tx += x.Tx
	})
	wan := make([]wanOut, 0, len(wanMap))
	for _, o := range wanMap {
		wan = append(wan, *o)
	}
	sort.Slice(wan, func(i, j int) bool { return wan[i].T < wan[j].T })

	totals := map[string][2]int64{}
	series := map[string]map[int64]int64{} // ip -> bucket -> байт всего
	statsRead("clients.jsonl", since, func(raw []byte) {
		var x cliRec
		if json.Unmarshal(raw, &x) != nil {
			return
		}
		k := x.T / step * step
		for ip, v := range x.C {
			t := totals[ip]
			totals[ip] = [2]int64{t[0] + v[0], t[1] + v[1]}
			if series[ip] == nil {
				series[ip] = map[int64]int64{}
			}
			series[ip][k] += v[0] + v[1]
		}
	})
	names := p.clientNames()
	type cliOut struct {
		IP     string  `json:"ip"`
		Name   string  `json:"name"`
		Up     int64   `json:"up"`
		Down   int64   `json:"down"`
		Series []int64 `json:"series"` // по корзинам wan[].t, в тех же границах
	}
	cl := []cliOut{}
	for ip, t := range totals {
		cl = append(cl, cliOut{IP: ip, Name: names[ip], Up: t[0], Down: t[1]})
	}
	sort.Slice(cl, func(i, j int) bool { return cl[i].Up+cl[i].Down > cl[j].Up+cl[j].Down })
	if len(cl) > 12 {
		cl = cl[:12]
	}
	for i := range cl {
		cl[i].Series = make([]int64, len(wan))
		for j, wp := range wan {
			cl[i].Series[j] = series[cl[i].IP][wp.T]
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"speed": speed, "wan": wan, "clients": cl, "step": step, "hours": hours})
}

// clientNames: ip -> имя из аренд DHCP и своих названий.
func (p *homePortal) clientNames() map[string]string {
	out := map[string]string{}
	custom := p.customNames()
	for _, l := range strings.Split(readFile("/tmp/dhcp.leases"), "\n") {
		f := strings.Fields(l)
		if len(f) < 4 {
			continue
		}
		mac := strings.ToUpper(f[1])
		switch {
		case custom[mac] != "":
			out[f[2]] = custom[mac]
		case f[3] != "*" && f[3] != "":
			out[f[2]] = f[3]
		case p.local != nil && p.local.nameByIP(f[2]) != "":
			out[f[2]] = p.local.nameByIP(f[2])
		case vendorOf(mac) != "":
			out[f[2]] = vendorOf(mac)
		}
		if f[2] == p.pcIP && custom[mac] == "" {
			out[f[2]] = "Компьютер"
		}
	}
	return out
}

var _ = http.StatusOK
