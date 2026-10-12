// Действия с роутером из панели: перезагрузка, Wi-Fi, Wake-on-LAN любого устройства, Wi-Fi для гостей.
package main

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os/exec"
	"strings"
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
		writeJSON(w, http.StatusOK, map[string]any{"wifi": wifiNets(r.URL.Query().Get("qr") == "1"), "qr": err == nil})
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


