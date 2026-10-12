// Связка облака Tuya (список, ключи, схемы) с локальным управлением по сети.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type cloudDev struct {
	ID, Name, Key, NodeID, Category, ProductID string
	Sub                                        bool
}

// dpSpec — какой номер DP у кода и в каком диапазоне значения.
type dpSpec struct {
	ID  string
	Min float64
	Max float64
}

type tuyaLocal struct {
	p      *homePortal
	mu     sync.Mutex
	devs   map[string]*localDev       // devId -> как достучаться
	specs  map[string]map[string]dpSpec // productId -> code -> dp
	ipName map[string]string           // ip -> имя устройства Tuya (для списка клиентов)
	at     time.Time
	busy   bool
}

func newTuyaLocal(p *homePortal) *tuyaLocal {
	return &tuyaLocal{p: p, devs: map[string]*localDev{}, specs: map[string]map[string]dpSpec{}, ipName: map[string]string{}}
}

func (tl *tuyaLocal) cloudList() ([]cloudDev, error) {
	out, err := tl.p.tuya.call("GET", "/v1.0/iot-01/associated-users/devices?size=100", "")
	if err != nil {
		return nil, err
	}
	res, _ := out["result"].(map[string]any)
	list, _ := res["devices"].([]any)
	var devs []cloudDev
	for _, d := range list {
		m, _ := d.(map[string]any)
		cd := cloudDev{ID: fmt.Sprint(m["id"]), Name: strings.TrimSpace(fmt.Sprint(m["name"])),
			Key: fmt.Sprint(m["local_key"]), NodeID: fmt.Sprint(m["node_id"]), Category: fmt.Sprint(m["category"]),
			ProductID: fmt.Sprint(m["product_id"])}
		cd.Sub, _ = m["sub"].(bool)
		if cd.NodeID == "<nil>" {
			cd.NodeID = ""
		}
		if strings.HasPrefix(cd.ID, "vdevo") { // виртуальные — только облако
			continue
		}
		devs = append(devs, cd)
	}
	return devs, nil
}

// spec берёт из облака модель продукта: номера DP и диапазоны.
func (tl *tuyaLocal) spec(devID, productID string) map[string]dpSpec {
	tl.mu.Lock()
	if s, ok := tl.specs[productID]; ok {
		tl.mu.Unlock()
		return s
	}
	tl.mu.Unlock()
	s := map[string]dpSpec{}
	if out, err := tl.p.tuya.call("GET", "/v2.0/cloud/thing/"+devID+"/model", ""); err == nil {
		res, _ := out["result"].(map[string]any)
		var model struct {
			Services []struct {
				Properties []struct {
					AbilityID int    `json:"abilityId"`
					Code      string `json:"code"`
					TypeSpec  struct {
						Min float64 `json:"min"`
						Max float64 `json:"max"`
					} `json:"typeSpec"`
				} `json:"properties"`
			} `json:"services"`
		}
		if raw, ok := res["model"].(string); ok {
			json.Unmarshal([]byte(raw), &model)
		}
		for _, sv := range model.Services {
			for _, pr := range sv.Properties {
				s[pr.Code] = dpSpec{ID: strconv.Itoa(pr.AbilityID), Min: pr.TypeSpec.Min, Max: pr.TypeSpec.Max}
			}
		}
	}
	tl.mu.Lock()
	tl.specs[productID] = s
	tl.mu.Unlock()
	return s
}

func candidateIPs() []string {
	seen := map[string]bool{}
	var ips []string
	add := func(ip string) {
		if strings.HasPrefix(ip, "192.168.1.") && ip != "192.168.1.1" && ip != "192.168.1.2" && !seen[ip] {
			seen[ip] = true
			ips = append(ips, ip)
		}
	}
	for _, l := range strings.Split(readFile("/tmp/dhcp.leases"), "\n") {
		if f := strings.Fields(l); len(f) >= 3 {
			add(f[2])
		}
	}
	return ips
}

// discover находит IP и версию протокола каждого Wi-Fi устройства Tuya.
func (tl *tuyaLocal) discover() {
	tl.mu.Lock()
	if tl.busy {
		tl.mu.Unlock()
		return
	}
	tl.busy = true
	tl.mu.Unlock()
	defer func() { tl.mu.Lock(); tl.busy = false; tl.at = time.Now(); tl.mu.Unlock() }()

	devs, err := tl.cloudList()
	if err != nil {
		log.Printf("tuya local: список устройств: %v", err)
		return
	}
	// у кого открыт порт 6668
	var open []string
	var om sync.Mutex
	var wg sync.WaitGroup
	for _, ip := range candidateIPs() {
		wg.Add(1)
		go func(ip string) {
			defer wg.Done()
			if dialOKTimeout(ip+":6668", 2*time.Second) {
				om.Lock()
				open = append(open, ip)
				om.Unlock()
			}
		}(ip)
	}
	wg.Wait()

	found := map[string]*localDev{}
	names := map[string]string{}
	var fm sync.Mutex
	for _, cd := range devs {
		if (cd.Sub && !isGateway(cd)) || cd.Key == "" {
			continue
		}
		wg.Add(1)
		go func(cd cloudDev) {
			defer wg.Done()
			for _, ip := range open {
				fm.Lock()
				taken := names[ip] != ""
				fm.Unlock()
				if taken {
					continue
				}
				if d, _ := probe(cd.ID, []byte(cd.Key), ip); d != nil {
					fm.Lock()
					found[cd.ID] = d
					names[ip] = cd.Name
					fm.Unlock()
					log.Printf("tuya local: %s → %s (v%s)", cd.Name, ip, d.Version)
					return
				}
			}
		}(cd)
	}
	wg.Wait()
	// под-устройства (Bluetooth-лампы) — через найденный шлюз
	var gw *localDev
	for _, cd := range devs {
		if d := found[cd.ID]; d != nil && isGateway(cd) {
			gw = d
		}
	}
	if gw != nil {
		for _, cd := range devs {
			if cd.Sub && cd.NodeID != "" && !isGateway(cd) {
				found[cd.ID] = &localDev{ID: cd.ID, Key: gw.Key, IP: gw.IP, Version: gw.Version, GwID: gw.ID, NodeID: cd.NodeID}
			}
		}
	}
	tl.mu.Lock()
	tl.devs = found
	tl.ipName = names
	tl.mu.Unlock()
	log.Printf("tuya local: найдено %d из %d", len(found), len(devs))
}

func isGateway(cd cloudDev) bool {
	return cd.Category == "wg2" || cd.Category == "wfcon" || cd.Category == "gw" || cd.Category == "wg"
}

func dialOKTimeout(addr string, d time.Duration) bool {
	c, err := netDial(addr, d)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// set — команда по коду облака ("switch_led", "bright_value_v2"…) через локальную сеть.
func (tl *tuyaLocal) set(devID, productID string, cmds []deviceState) error {
	tl.mu.Lock()
	d := tl.devs[devID]
	tl.mu.Unlock()
	if d == nil {
		return fmt.Errorf("устройство не найдено в сети")
	}
	sp := tl.spec(devID, productID)
	dps := map[string]any{}
	for _, c := range cmds {
		code := c.Code
		s, ok := sp[code]
		if !ok { // облачные коды v2 → у Bluetooth-ламп бывают коды без _v2
			alt := strings.TrimSuffix(code, "_v2")
			if s2, ok2 := sp[alt]; ok2 {
				s, ok = s2, true
				// пересчёт диапазона 10..1000 / 0..1000 → диапазон устройства
				if f, isNum := toNum(c.Value); isNum && s.Max > 0 && s.Max != 1000 {
					srcMin := 0.0
					if strings.HasPrefix(code, "bright") {
						srcMin = 10
					}
					v := s.Min + (f-srcMin)/(1000-srcMin)*(s.Max-s.Min)
					c.Value = int(v + 0.5)
				}
			}
		}
		if !ok {
			continue
		}
		dps[s.ID] = c.Value
	}
	if len(dps) == 0 {
		return fmt.Errorf("неизвестные команды")
	}
	return localSet(d, dps)
}

func toNum(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

func (tl *tuyaLocal) known(devID string) bool {
	tl.mu.Lock()
	defer tl.mu.Unlock()
	return tl.devs[devID] != nil
}

func (tl *tuyaLocal) nameByIP(ip string) string {
	tl.mu.Lock()
	defer tl.mu.Unlock()
	return tl.ipName[ip]
}

func (tl *tuyaLocal) summary() []map[string]any {
	tl.mu.Lock()
	defer tl.mu.Unlock()
	var out []map[string]any
	for id, d := range tl.devs {
		out = append(out, map[string]any{"id": id, "ip": d.IP, "version": d.Version, "sub": d.NodeID != ""})
	}
	sort.Slice(out, func(i, j int) bool { return fmt.Sprint(out[i]["ip"]) < fmt.Sprint(out[j]["ip"]) })
	return out
}

// runProbeCLI: photossd -tuya-probe — проверка локального управления из консоли роутера.
func runProbeCLI(confPath string) {
	t := loadTuya(confPath)
	if t == nil {
		fmt.Println("нет настроек Tuya")
		os.Exit(1)
	}
	p := &homePortal{tuya: t}
	tl := newTuyaLocal(p)
	p.local = tl
	// отладка: какие IP открыты и что отвечают устройства
	devs, err := tl.cloudList()
	fmt.Println("облако:", len(devs), err)
	for _, cd := range devs {
		fmt.Printf("  %s sub=%v cat=%s keylen=%d node=%s\n", cd.Name, cd.Sub, cd.Category, len(cd.Key), cd.NodeID)
	}
	ips := candidateIPs()
	fmt.Println("кандидаты:", ips)
	for _, ip := range ips {
		if !dialOKTimeout(ip+":6668", 2*time.Second) {
			continue
		}
		fmt.Println("порт 6668 открыт:", ip)
		for _, cd := range devs {
			if cd.Sub && !isGateway(cd) {
				continue
			}
			for _, v := range []string{"3.3", "3.4", "3.5"} {
				d := &localDev{ID: cd.ID, Key: []byte(cd.Key), IP: ip, Version: v}
				st, err := localStatus(d)
				if err == nil {
					fmt.Printf("  ✓ %s (%s) v%s → %v\n", cd.Name, ip, v, st)
				} else if os.Getenv("VERBOSE") != "" {
					fmt.Printf("  · %s keylen=%d v%s: %v\n", cd.Name, len(cd.Key), v, err)
				}
			}
		}
	}
	tl.discover()
	for _, s := range tl.summary() {
		fmt.Printf("%v\n", s)
	}
	for id, d := range tl.devs {
		st, err := localStatus(d)
		fmt.Printf("%s %s v%s cid=%s → %v %v\n", id, d.IP, d.Version, d.NodeID, st, err)
	}
}
