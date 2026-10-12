// ZALET HOME — панель дома: статус роутера и сервисов, устройства Tuya, ПК, клиенты сети.
package main

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed portal
var portalFS embed.FS

// ---------- Tuya Cloud ----------

type tuyaClient struct {
	id, secret, host, device string
	mu                       sync.Mutex
	token                    string
	tokenExp                 time.Time
	http                     *http.Client
}

func loadTuya(confPath string) *tuyaClient {
	f, err := os.Open(confPath)
	if err != nil {
		log.Printf("tuya: нет %s", confPath)
		return nil
	}
	defer f.Close()
	vals := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(strings.TrimPrefix(sc.Text(), string([]byte{0xEF, 0xBB, 0xBF})))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		vals[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
	}
	if vals["TUYA_ID"] == "" || vals["TUYA_SECRET"] == "" {
		return nil
	}
	host := vals["TUYA_HOST"]
	if host == "" {
		host = "openapi.tuyaeu.com"
	}
	return &tuyaClient{id: vals["TUYA_ID"], secret: vals["TUYA_SECRET"], host: host, device: vals["TUYA_DEVICE"],
		http: &http.Client{Timeout: 12 * time.Second}}
}

func (t *tuyaClient) sign(method, pathQuery, body, token, ts string) string {
	bh := sha256.Sum256([]byte(body))
	str := method + "\n" + hex.EncodeToString(bh[:]) + "\n\n" + pathQuery
	m := hmac.New(sha256.New, []byte(t.secret))
	m.Write([]byte(t.id + token + ts + str))
	return strings.ToUpper(hex.EncodeToString(m.Sum(nil)))
}

func (t *tuyaClient) raw(method, pathQuery, body, token string) (map[string]any, error) {
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	req, _ := http.NewRequest(method, "https://"+t.host+pathQuery, strings.NewReader(body))
	req.Header.Set("client_id", t.id)
	req.Header.Set("t", ts)
	req.Header.Set("sign_method", "HMAC-SHA256")
	req.Header.Set("sign", t.sign(method, pathQuery, body, token, ts))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("access_token", token)
	}
	resp, err := t.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if ok, _ := out["success"].(bool); !ok {
		return out, fmt.Errorf("tuya: %v", out["msg"])
	}
	return out, nil
}

func (t *tuyaClient) call(method, pathQuery, body string) (map[string]any, error) {
	t.mu.Lock()
	if t.token == "" || time.Now().After(t.tokenExp) {
		out, err := t.raw("GET", "/v1.0/token?grant_type=1", "", "")
		if err != nil {
			t.mu.Unlock()
			return nil, err
		}
		res, _ := out["result"].(map[string]any)
		t.token, _ = res["access_token"].(string)
		exp, _ := res["expire_time"].(float64)
		if exp == 0 {
			exp = 7200
		}
		t.tokenExp = time.Now().Add(time.Duration(exp-300) * time.Second)
	}
	tok := t.token
	t.mu.Unlock()
	out, err := t.raw(method, pathQuery, body, tok)
	if err != nil && strings.Contains(fmt.Sprint(out["code"]), "1010") { // токен протух
		t.mu.Lock()
		t.token = ""
		t.mu.Unlock()
	}
	return out, err
}

// ---------- модель устройств для панели ----------

type deviceState struct {
	Code  string `json:"code"`
	Value any    `json:"value"`
}

type homeDevice struct {
	ID       string        `json:"id"`
	Name     string        `json:"name"`
	Icon     string        `json:"icon"`
	Online   bool          `json:"online"`
	Category string        `json:"category"`
	Product  string        `json:"product"`
	Room     string        `json:"room"`
	Kind     string        `json:"kind"` // light, switch, plug, pc, gateway, other
	Status   []deviceState `json:"status"`
}

type homePortal struct {
	s       *server
	tuya    *tuyaClient
	proxy   *httputil.ReverseProxy
	pcIP    string
	pcMAC   string
	devMu   sync.Mutex
	devAt   time.Time
	devs    []homeDevice
	homeID  string
	rooms   map[string]string // id устройства -> комната
	roomsAt time.Time
}

func newPortal(s *server, tuyaConf, proxyTo, pcIP, pcMAC string) *homePortal {
	p := &homePortal{s: s, tuya: loadTuya(tuyaConf), pcIP: pcIP, pcMAC: pcMAC, rooms: map[string]string{}}
	if u, err := url.Parse(proxyTo); err == nil && proxyTo != "" {
		p.proxy = httputil.NewSingleHostReverseProxy(u)
	}
	return p
}

func kindOf(category, id string, tuyaPC string) string {
	if id == tuyaPC {
		return "pc"
	}
	switch category {
	case "dj", "dd", "xdd", "fwd", "dc", "tgq", "tgkg":
		return "light"
	case "kg", "tdq", "dlq", "qjdcz":
		return "switch"
	case "cz", "pc":
		return "plug"
	case "wg2", "wg", "wfcon", "gw":
		return "gateway"
	}
	return "other"
}

func (p *homePortal) loadRooms() {
	if time.Since(p.roomsAt) < 10*time.Minute && len(p.rooms) > 0 {
		return
	}
	if p.homeID == "" {
		return
	}
	out, err := p.tuya.call("GET", "/v1.0/homes/"+p.homeID+"/rooms", "")
	if err != nil {
		return
	}
	res, _ := out["result"].(map[string]any)
	rooms, _ := res["rooms"].([]any)
	m := map[string]string{}
	for _, r := range rooms {
		rm, _ := r.(map[string]any)
		name := strings.TrimSpace(fmt.Sprint(rm["name"]))
		rid := strconv.FormatInt(int64(toFloat(rm["room_id"])), 10)
		dout, err := p.tuya.call("GET", "/v1.0/homes/"+p.homeID+"/rooms/"+rid+"/devices", "")
		if err != nil {
			continue
		}
		list, _ := dout["result"].([]any)
		for _, d := range list {
			dm, _ := d.(map[string]any)
			m[fmt.Sprint(dm["id"])] = name
		}
	}
	p.rooms = m
	p.roomsAt = time.Now()
}

func toFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case json.Number:
		f, _ := x.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	}
	return 0
}

func (p *homePortal) devices(force bool) ([]homeDevice, error) {
	if p.tuya == nil {
		return nil, errors.New("облако Tuya не настроено")
	}
	p.devMu.Lock()
	defer p.devMu.Unlock()
	if !force && time.Since(p.devAt) < 8*time.Second && p.devs != nil {
		return p.devs, nil
	}
	out, err := p.tuya.call("GET", "/v1.0/iot-01/associated-users/devices?size=100", "")
	if err != nil {
		return p.devs, err
	}
	res, _ := out["result"].(map[string]any)
	list, _ := res["devices"].([]any)
	if p.homeID == "" {
		for _, d := range list {
			dm, _ := d.(map[string]any)
			if o := fmt.Sprint(dm["owner_id"]); o != "" && o != "<nil>" {
				p.homeID = o
				break
			}
		}
	}
	p.loadRooms()

	iconHost := "https://images.tuyaeu.com/"
	if strings.Contains(p.tuya.host, "tuyaus") {
		iconHost = "https://images.tuyaus.com/"
	}
	devs := make([]homeDevice, 0, len(list))
	for _, d := range list {
		dm, _ := d.(map[string]any)
		id := fmt.Sprint(dm["id"])
		cat := fmt.Sprint(dm["category"])
		hd := homeDevice{
			ID: id, Name: strings.TrimSpace(fmt.Sprint(dm["name"])), Category: cat,
			Product: fmt.Sprint(dm["product_name"]), Room: p.rooms[id],
			Kind: kindOf(cat, id, p.tuya.device),
		}
		hd.Online, _ = dm["online"].(bool)
		if ic, _ := dm["icon"].(string); ic != "" {
			if strings.HasPrefix(ic, "http") {
				hd.Icon = ic
			} else {
				hd.Icon = iconHost + ic
			}
		}
		if hd.Kind == "pc" {
			hd.Name = "Компьютер"
		}
		devs = append(devs, hd)
	}
	// Состояние: для каждого устройства берём «тень» (последние значения), она есть и у Bluetooth-ламп.
	var wg sync.WaitGroup
	for i := range devs {
		if devs[i].Kind == "gateway" {
			continue
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			devs[i].Status = p.state(devs[i].ID)
		}(i)
	}
	wg.Wait()
	sort.SliceStable(devs, func(i, j int) bool {
		if devs[i].Room != devs[j].Room {
			return devs[i].Room < devs[j].Room
		}
		return devs[i].Name < devs[j].Name
	})
	p.devs = devs
	p.devAt = time.Now()
	return devs, nil
}

func (p *homePortal) state(id string) []deviceState {
	out, err := p.tuya.call("GET", "/v2.0/cloud/thing/"+id+"/shadow/properties", "")
	var st []deviceState
	if err == nil {
		res, _ := out["result"].(map[string]any)
		props, _ := res["properties"].([]any)
		for _, pr := range props {
			pm, _ := pr.(map[string]any)
			if v, ok := pm["value"]; ok {
				st = append(st, deviceState{Code: fmt.Sprint(pm["code"]), Value: v})
			}
		}
	}
	if len(st) == 0 {
		if out, err := p.tuya.call("GET", "/v1.0/iot-03/devices/"+id+"/status", ""); err == nil {
			list, _ := out["result"].([]any)
			for _, x := range list {
				xm, _ := x.(map[string]any)
				st = append(st, deviceState{Code: fmt.Sprint(xm["code"]), Value: xm["value"]})
			}
		}
	}
	return st
}

func (p *homePortal) command(id string, cmds []deviceState) error {
	body, _ := json.Marshal(map[string]any{"commands": cmds})
	_, err := p.tuya.call("POST", "/v1.0/iot-03/devices/"+id+"/commands", string(body))
	if err == nil {
		// Сразу обновим кэш, чтобы панель показала новое состояние.
		p.devMu.Lock()
		for i := range p.devs {
			if p.devs[i].ID != id {
				continue
			}
			for _, c := range cmds {
				found := false
				for k := range p.devs[i].Status {
					if p.devs[i].Status[k].Code == c.Code {
						p.devs[i].Status[k].Value = c.Value
						found = true
					}
				}
				if !found {
					p.devs[i].Status = append(p.devs[i].Status, c)
				}
			}
		}
		p.devMu.Unlock()
	}
	return err
}

// ---------- статус дома ----------

func readFile(p string) string { b, _ := os.ReadFile(p); return strings.TrimSpace(string(b)) }

func procRunning(names ...string) map[string]bool {
	out := map[string]bool{}
	for _, n := range names {
		out[n] = false
	}
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		cmd := readFile("/proc/" + e.Name() + "/cmdline")
		comm := readFile("/proc/" + e.Name() + "/comm")
		for _, n := range names {
			if comm == n || strings.Contains(cmd, "/"+n) || strings.HasPrefix(cmd, n) {
				out[n] = true
			}
		}
	}
	return out
}

func pingHost(ip string) bool {
	return exec.Command("ping", "-c", "1", "-W", "1", ip).Run() == nil
}

func dialOK(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func memInfo() (total, avail int64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fs := strings.Fields(sc.Text())
		if len(fs) < 2 {
			continue
		}
		v, _ := strconv.ParseInt(fs[1], 10, 64)
		switch fs[0] {
		case "MemTotal:":
			total = v * 1024
		case "MemAvailable:":
			avail = v * 1024
		}
	}
	return
}

func (p *homePortal) handleStatus(w http.ResponseWriter, r *http.Request) {
	up := 0.0
	if f := strings.Fields(readFile("/proc/uptime")); len(f) > 0 {
		up, _ = strconv.ParseFloat(f[0], 64)
	}
	load := strings.Fields(readFile("/proc/loadavg"))
	memT, memA := memInfo()
	temp := 0.0
	if t := readFile("/sys/class/thermal/thermal_zone0/temp"); t != "" {
		v, _ := strconv.ParseFloat(t, 64)
		temp = v / 1000
	}
	var st syscall.Statfs_t
	var free, total uint64
	if syscall.Statfs(p.s.root, &st) == nil {
		free = st.Bavail * uint64(st.Bsize)
		total = st.Blocks * uint64(st.Bsize)
	}
	var internet, pc bool
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); internet = dialOK("77.88.8.8:53") || dialOK("1.1.1.1:53") }()
	go func() { defer wg.Done(); pc = pingHost(p.pcIP) }()
	wg.Wait()
	svc := procRunning("v2raya", "xray", "tailscaled", "zerotier-one", "smbd", "pc-remote", "dnsmasq", "syncthing")

	p.s.mu.Lock()
	files, trash := 0, 0
	var bytesTotal int64
	var last int64
	for _, rec := range p.s.byID {
		if p.s.live(rec) {
			files++
			bytesTotal += rec.Size
			if rec.Time > last {
				last = rec.Time
			}
		} else if rec.Trashed > 0 && !rec.Purged {
			trash++
		}
	}
	p.s.mu.Unlock()

	loadStr := ""
	if len(load) > 0 {
		loadStr = load[0]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"router": map[string]any{"uptime": up, "load": loadStr, "memTotal": memT, "memAvail": memA, "temp": temp,
			"model": readFile("/tmp/sysinfo/model")},
		"ssd":      map[string]any{"free": free, "total": total},
		"internet": internet,
		"pc":       map[string]any{"online": pc, "ip": p.pcIP},
		"services": svc,
		"photos":   map[string]any{"files": files, "bytes": bytesTotal, "trash": trash, "last": last},
		"tuya":     p.tuya != nil,
		"time":     time.Now().Unix(),
	})
}

func (p *homePortal) handleDevices(w http.ResponseWriter, r *http.Request) {
	devs, err := p.devices(r.URL.Query().Get("fresh") == "1")
	if err != nil && devs == nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": devs})
}

func (p *homePortal) handleCommand(w http.ResponseWriter, r *http.Request) {
	if !needPost(w, r) {
		return
	}
	if p.tuya == nil {
		fail(w, http.StatusBadGateway, "облако Tuya не настроено")
		return
	}
	var req struct {
		ID       string        `json:"id"`
		Commands []deviceState `json:"commands"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil || req.ID == "" || len(req.Commands) == 0 {
		fail(w, http.StatusBadRequest, "нужны id и commands")
		return
	}
	if err := p.command(req.ID, req.Commands); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// «Всё выключить»: свет и выключатели, кроме компьютера и шлюза.
func (p *homePortal) handleAllOff(w http.ResponseWriter, r *http.Request) {
	if !needPost(w, r) {
		return
	}
	devs, err := p.devices(false)
	if err != nil && devs == nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	done, failed := 0, 0
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
		wg.Add(1)
		go func(id, code string) {
			defer wg.Done()
			err := p.command(id, []deviceState{{Code: code, Value: false}})
			mu.Lock()
			if err == nil {
				done++
			} else {
				failed++
			}
			mu.Unlock()
		}(d.ID, code)
	}
	wg.Wait()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "done": done, "failed": failed})
}

// Включить/выключить ПК: переключаем «флажок» Tuya — так Маруся и роутер видят одно и то же состояние.
func (p *homePortal) handlePC(w http.ResponseWriter, r *http.Request) {
	if !needPost(w, r) {
		return
	}
	on := r.URL.Query().Get("action") == "on"
	if p.tuya != nil && p.tuya.device != "" {
		if err := p.command(p.tuya.device, []deviceState{{Code: "switch_1", Value: on}}); err == nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "via": "tuya"})
			return
		}
	}
	// запасной путь — напрямую
	script := "/usr/bin/pc-off"
	if on {
		script = "/usr/bin/pc-on"
	}
	if err := exec.Command(script).Run(); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "via": "direct"})
}

type client struct {
	Name   string `json:"name"`
	IP     string `json:"ip"`
	MAC    string `json:"mac"`
	Online bool   `json:"online"`
}

func (p *homePortal) handleClients(w http.ResponseWriter, r *http.Request) {
	reach := map[string]bool{}
	if out, err := exec.Command("ip", "neigh", "show").Output(); err == nil {
		for _, l := range strings.Split(string(out), "\n") {
			f := strings.Fields(l)
			if len(f) < 4 {
				continue
			}
			st := f[len(f)-1]
			if st == "REACHABLE" || st == "DELAY" || st == "PROBE" || st == "STALE" {
				reach[f[0]] = st != "STALE" || reach[f[0]]
				if st == "STALE" {
					if _, ok := reach[f[0]]; !ok {
						reach[f[0]] = false
					}
				}
			}
		}
	}
	list := []client{}
	for _, l := range strings.Split(readFile("/tmp/dhcp.leases"), "\n") {
		f := strings.Fields(l)
		if len(f) < 4 {
			continue
		}
		name := f[3]
		if name == "*" {
			name = ""
		}
		list = append(list, client{Name: name, IP: f[2], MAC: strings.ToUpper(f[1]), Online: reach[f[2]]})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Online != list[j].Online {
			return list[i].Online
		}
		return list[i].IP < list[j].IP
	})
	writeJSON(w, http.StatusOK, map[string]any{"clients": list})
}

// ---------- журналы ----------

type logLine struct {
	Time  string `json:"time"`
	Tag   string `json:"tag"`
	Level string `json:"level"`
	Text  string `json:"text"`
}

// Источники журналов для панели: метка syslog -> понятное имя.
var logSources = map[string][]string{
	"zalet":     {"photossd"},
	"pc":        {"pc-remote"},
	"vpn":       {"v2raya", "xray", "youtubeUnblock"},
	"samba":     {"smbd", "nmbd", "samba4-server", "ksmbd"},
	"tailscale": {"tailscaled", "tailscale"},
	"zerotier":  {"zerotier-one", "zerotier"},
	"dns":       {"dnsmasq", "stubby", "doh-proxy", "dns-failsafe-proxy"},
	"wifi":      {"hostapd", "wpa_supplicant"},
	"system":    {"kernel", "netifd", "procd", "dropbear", "uhttpd", "firewall"},
}

func (p *homePortal) handleLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	source := q.Get("source")
	text := strings.ToLower(q.Get("q"))
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 2000 {
		limit = 400
	}
	out, err := exec.Command("logread").Output()
	if err != nil {
		fail(w, http.StatusInternalServerError, "logread: "+err.Error())
		return
	}
	tags := logSources[source]
	lines := strings.Split(string(out), "\n")
	res := make([]logLine, 0, limit)
	for i := len(lines) - 1; i >= 0 && len(res) < limit; i-- {
		l := lines[i]
		if l == "" {
			continue
		}
		// формат: "Mon Oct 12 18:32:25 2026 daemon.err photossd[6559]: текст"
		f := strings.Fields(l)
		if len(f) < 7 {
			continue
		}
		ts := f[3]
		lvl := f[5]
		k := strings.Index(l, " "+lvl+" ")
		if k < 0 {
			continue
		}
		rest := l[k+len(lvl)+2:]
		tag, msg, _ := strings.Cut(rest, ": ")
		if j := strings.IndexByte(tag, '['); j > 0 {
			tag = tag[:j]
		}
		if len(tags) > 0 {
			ok := false
			for _, t := range tags {
				if tag == t {
					ok = true
					break
				}
			}
			if !ok {
				continue
			}
		}
		if text != "" && !strings.Contains(strings.ToLower(l), text) {
			continue
		}
		level := "info"
		switch {
		case strings.HasSuffix(lvl, ".err"), strings.HasSuffix(lvl, ".crit"), strings.HasSuffix(lvl, ".alert"):
			level = "error"
		case strings.HasSuffix(lvl, ".warn"):
			level = "warn"
		case strings.HasSuffix(lvl, ".debug"):
			level = "debug"
		}
		// photossd и samba пишут обычные сообщения в stderr (уровень err) — не пугаем красным.
		if level == "error" && (tag == "photossd" || tag == "smbd" || tag == "nmbd") &&
			!strings.Contains(strings.ToLower(msg), "error") && !strings.Contains(strings.ToLower(msg), "fail") {
			level = "info"
		}
		res = append(res, logLine{Time: ts, Tag: tag, Level: level, Text: msg})
	}
	writeJSON(w, http.StatusOK, map[string]any{"lines": res})
}

// ---------- сервер панели ----------

func (p *homePortal) handler() http.Handler {
	mux := http.NewServeMux()
	api := map[string]http.HandlerFunc{
		"/api/home/status":  p.handleStatus,
		"/api/home/devices": p.handleDevices,
		"/api/home/command": p.handleCommand,
		"/api/home/alloff":  p.handleAllOff,
		"/api/home/pc":      p.handlePC,
		"/api/home/clients": p.handleClients,
		"/api/home/logs":    p.handleLogs,
	}
	for k, h := range api {
		mux.HandleFunc(k, p.s.auth(h))
	}
	// API ZALET тоже доступно через панель (последние фото, превью).
	mux.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) {
		p.s.mux.ServeHTTP(w, r)
	})

	static, _ := fs.Sub(portalFS, "portal")
	files := http.FileServer(http.FS(static))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		// Служебные пути роутера (LuCI, голосовое управление ПК) — отдаём настройкам роутера.
		if p.proxy != nil && (strings.HasPrefix(path, "/cgi-bin/") || strings.HasPrefix(path, "/luci-static/") ||
			strings.HasPrefix(path, "/ubus") || strings.HasPrefix(path, "/pc/")) {
			p.proxy.ServeHTTP(w, r)
			return
		}
		if path == "/" || filepath.Ext(path) != "" {
			w.Header().Set("Cache-Control", "no-cache")
			files.ServeHTTP(w, r)
			return
		}
		// неизвестный путь — на главную (одностраничное приложение)
		r.URL.Path = "/"
		files.ServeHTTP(w, r)
	})
	return mux
}

func (p *homePortal) listen(addrs string) {
	h := p.handler()
	for _, a := range strings.Split(addrs, ",") {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		go func(a string) {
			srv := &http.Server{Addr: a, Handler: h, ReadHeaderTimeout: 20 * time.Second}
			for {
				log.Printf("панель ZALET HOME: %s", a)
				err := srv.ListenAndServe()
				log.Printf("панель %s: %v — повтор через 10 с", a, err)
				time.Sleep(10 * time.Second)
			}
		}(a)
	}
}

var _ = bytes.NewReader
