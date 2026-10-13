// Действия с роутером из панели: перезагрузка, Wi-Fi, Wake-on-LAN любого устройства, Wi-Fi для гостей.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"
)

func wakeMAC(mac string) error {
	hw, err := net.ParseMAC(mac)
	if err != nil {
		return err
	}
	pkt := make([]byte, 0, 102)
	for i := 0; i < 6; i++ {
		pkt = append(pkt, 0xff)
	}
	for i := 0; i < 16; i++ {
		pkt = append(pkt, hw...)
	}
	for _, dst := range []string{"192.168.1.255:9", "255.255.255.255:9"} {
		if c, err := net.Dial("udp", dst); err == nil {
			c.Write(pkt)
			c.Close()
		}
	}
	return nil
}

type wifiNet struct {
	Name     string `json:"name"`
	SSID     string `json:"ssid"`
	Key      string `json:"key"`
	Enc      string `json:"enc"`
	Band     string `json:"band"`
	Disabled bool   `json:"disabled"`
	QR       string `json:"qr,omitempty"`
}

func wifiNets(withQR bool) []wifiNet {
	out, _ := exec.Command("uci", "-q", "show", "wireless").Output()
	ifaces := map[string]*wifiNet{}
	radios := map[string]string{}
	var order []string
	dev := map[string]string{}
	for _, l := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(l, "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, "'")
		parts := strings.Split(k, ".")
		if len(parts) == 2 && v == "wifi-iface" {
			ifaces[parts[1]] = &wifiNet{Name: parts[1]}
			order = append(order, parts[1])
			continue
		}
		if len(parts) != 3 {
			continue
		}
		sec, opt := parts[1], parts[2]
		if opt == "band" || (opt == "hwmode" && radios[sec] == "") {
			radios[sec] = v
		}
		w := ifaces[sec]
		if w == nil {
			continue
		}
		switch opt {
		case "ssid":
			w.SSID = v
		case "key":
			w.Key = v
		case "encryption":
			w.Enc = v
		case "disabled":
			w.Disabled = v == "1"
		case "device":
			dev[sec] = v
		}
	}
	var res []wifiNet
	for _, n := range order {
		w := ifaces[n]
		if w.SSID == "" {
			continue
		}
		w.Band = map[string]string{"2g": "2,4 ГГц", "5g": "5 ГГц", "6g": "6 ГГц", "11g": "2,4 ГГц", "11a": "5 ГГц"}[radios[dev[n]]]
		if withQR {
			t := "WPA"
			if w.Enc == "none" || w.Enc == "" {
				t = "nopass"
			}
			esc := strings.NewReplacer(`\`, `\\`, `;`, `\;`, `,`, `\,`, `:`, `\:`, `"`, `\"`)
			s := "WIFI:T:" + t + ";S:" + esc.Replace(w.SSID) + ";P:" + esc.Replace(w.Key) + ";;"
			if q, err := exec.Command("qrencode", "-t", "SVG", "-m", "1", "-o", "-", s).Output(); err == nil {
				w.QR = string(q)
			}
		}
		res = append(res, *w)
	}
	return res
}

func (p *homePortal) handleSystem(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		_, err := exec.LookPath("qrencode")
		writeJSON(w, http.StatusOK, map[string]any{"wifi": wifiNets(r.URL.Query().Get("qr") == "1"), "qr": err == nil, "router": routerInfo()})
		return
	}
	var req struct {
		Action string `json:"action"` // reboot, wifi, wol
		MAC    string `json:"mac"`
	}
	json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req)
	switch req.Action {
	case "reboot":
		log.Printf("панель: перезагрузка роутера (%s)", clientIP(r))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		go func() { time.Sleep(time.Second); exec.Command("reboot").Run() }()
	case "wifi":
		log.Printf("панель: перезапуск Wi-Fi (%s)", clientIP(r))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		go func() { time.Sleep(500 * time.Millisecond); exec.Command("wifi", "reload").Run() }()
	case "wol":
		if err := wakeMAC(req.MAC); err != nil {
			fail(w, http.StatusBadRequest, "неверный MAC")
			return
		}
		log.Printf("панель: Wake-on-LAN %s", req.MAC)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		fail(w, http.StatusBadRequest, "неизвестное действие")
	}
}



// Погода для окна на главной: роутер сам спрашивает Open-Meteo и держит ответ 10 минут.
var weatherCache struct {
	sync.Mutex
	at   time.Time
	body []byte
}

func (p *homePortal) handleWeather(w http.ResponseWriter, r *http.Request) {
	weatherCache.Lock()
	defer weatherCache.Unlock()
	if time.Since(weatherCache.at) > 10*time.Minute || weatherCache.body == nil {
		u := "https://api.open-meteo.com/v1/forecast?latitude=55.03&longitude=73.37&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day" +
			"&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto&forecast_days=4&wind_speed_unit=ms"
		c := &http.Client{Timeout: 4 * time.Second}
		if resp, err := c.Get(u); err == nil {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			resp.Body.Close()
			if resp.StatusCode == 200 {
				weatherCache.body, weatherCache.at = b, time.Now()
			}
		}
	}
	if weatherCache.body == nil || time.Since(weatherCache.at) > 10*time.Minute {
		if b := wttrWeather(); b != nil {
			weatherCache.body, weatherCache.at = b, time.Now()
		}
	}
	if weatherCache.body == nil {
		fail(w, http.StatusBadGateway, "погода недоступна")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(weatherCache.body)
}

// wttr.in — запасной источник (Open-Meteo из России открывается не всегда); ответ приводится к формату Open-Meteo.
func wttrWeather() []byte {
	c := &http.Client{Timeout: 10 * time.Second}
	resp, err := c.Get("https://wttr.in/55.03,73.37?format=j1")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var j struct {
		Current []struct {
			TempC                                         string `json:"temp_C"`
			FeelsLikeC, Humidity, WindspeedKmph, WeatherCode string
		} `json:"current_condition"`
		Weather []struct {
			Date, MaxtempC, MintempC string
			Astronomy                []struct{ Sunrise, Sunset string } `json:"astronomy"`
			Hourly                   []struct{ WeatherCode string } `json:"hourly"`
		} `json:"weather"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&j) != nil || len(j.Current) == 0 {
		return nil
	}
	num := func(s string) float64 { var f float64; fmt.Sscan(s, &f); return f }
	wmo := func(code string) int {
		n := int(num(code))
		switch {
		case n == 113:
			return 0
		case n == 116:
			return 2
		case n == 119 || n == 122:
			return 3
		case n == 143 || n == 248 || n == 260:
			return 45
		case n == 200 || n >= 386:
			return 95
		case n == 179 || n == 227 || n == 230 || (n >= 323 && n <= 338) || n == 368 || n == 371:
			if n == 338 || n == 230 || n == 371 {
				return 75
			}
			return 73
		case n == 182 || n == 185 || n == 281 || n == 284 || (n >= 311 && n <= 320) || n == 350 || (n >= 362 && n <= 377):
			return 66
		case n >= 299 && n <= 314 || n == 356 || n == 359:
			return 65
		default:
			return 61
		}
	}
	cur := j.Current[0]
	isDay := 1
	now := time.Now()
	if len(j.Weather) > 0 && len(j.Weather[0].Astronomy) > 0 {
		a := j.Weather[0].Astronomy[0]
		rise, e1 := time.ParseInLocation("2006-01-02 03:04 PM", j.Weather[0].Date+" "+a.Sunrise, now.Location())
		set, e2 := time.ParseInLocation("2006-01-02 03:04 PM", j.Weather[0].Date+" "+a.Sunset, now.Location())
		if e1 == nil && e2 == nil && (now.Before(rise) || now.After(set)) {
			isDay = 0
		}
	}
	out := map[string]any{"source": "wttr.in", "current": map[string]any{
		"temperature_2m": num(cur.TempC), "apparent_temperature": num(cur.FeelsLikeC), "relative_humidity_2m": num(cur.Humidity),
		"wind_speed_10m": num(cur.WindspeedKmph) / 3.6, "weather_code": wmo(cur.WeatherCode), "is_day": isDay}}
	d := map[string][]any{"time": {}, "weather_code": {}, "temperature_2m_max": {}, "temperature_2m_min": {}}
	for _, day := range j.Weather {
		code := 0
		if len(day.Hourly) > 4 {
			code = wmo(day.Hourly[4].WeatherCode)
		}
		d["time"] = append(d["time"], day.Date)
		d["weather_code"] = append(d["weather_code"], code)
		d["temperature_2m_max"] = append(d["temperature_2m_max"], num(day.MaxtempC))
		d["temperature_2m_min"] = append(d["temperature_2m_min"], num(day.MintempC))
	}
	out["daily"] = d
	b, _ := json.Marshal(out)
	return b
}

// routerInfo — модель, прошивка, адреса.
func routerInfo() map[string]any {
	rel := map[string]string{}
	for _, l := range strings.Split(readFile("/etc/openwrt_release"), "
") {
		if k, v, ok := strings.Cut(l, "="); ok {
			rel[k] = strings.Trim(v, "'\"")
		}
	}
	kernel, _ := exec.Command("uname", "-r").Output()
	ifc := wanIface()
	wanIP := ""
	if out, err := exec.Command("ip", "-4", "-o", "addr", "show", "dev", ifc).Output(); err == nil {
		if f := strings.Fields(string(out)); len(f) >= 4 {
			wanIP = strings.Split(f[3], "/")[0]
		}
	}
	gw := ""
	if out, err := exec.Command("ip", "route", "show", "default").Output(); err == nil {
		if f := strings.Fields(string(out)); len(f) >= 3 {
			gw = f[2]
		}
	}
	tsIP := ""
	if out, err := exec.Command("tailscale", "ip", "-4").Output(); err == nil {
		tsIP = strings.TrimSpace(string(out))
	}
	clients := 0
	for _, l := range strings.Split(readFile("/tmp/dhcp.leases"), "
") {
		if strings.TrimSpace(l) != "" {
			clients++
		}
	}
	return map[string]any{
		"model": readFile("/tmp/sysinfo/model"), "firmware": rel["DISTRIB_DESCRIPTION"], "target": rel["DISTRIB_TARGET"],
		"kernel": strings.TrimSpace(string(kernel)), "hostname": readFile("/proc/sys/kernel/hostname"),
		"wanIface": ifc, "wanIP": wanIP, "gateway": gw, "lan": "192.168.1.1 · 192.168.1.2 (LuCI)",
		"tailscale": tsIP, "zerotier": "10.10.10.1", "leases": clients,
	}
}
