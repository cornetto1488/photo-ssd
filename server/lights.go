// Состояние Bluetooth-ламп (Beacon): сами лампы ничего не сообщают — облако хранит
// только старые значения. Поэтому роутер помнит свои команды и сверяет их
// с выключателем той же комнаты: нет питания — лампа точно не горит,
// питание подали позже последней команды — лампа включилась сама.
package main

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
	"time"
)

type lightMem struct {
	At     int64          `json:"at"` // мс
	Values map[string]any `json:"values"`
}

var lightsMu sync.Mutex

func (p *homePortal) lightsPath() string { return p.s.meta("light-state.json") }

func (p *homePortal) loadLights() map[string]*lightMem {
	m := map[string]*lightMem{}
	if b, err := os.ReadFile(p.lightsPath()); err == nil {
		json.Unmarshal(b, &m)
	}
	return m
}

// rememberLight сохраняет отправленную лампе команду.
func (p *homePortal) rememberLight(id string, cmds []deviceState) {
	lightsMu.Lock()
	defer lightsMu.Unlock()
	m := p.loadLights()
	lm := m[id]
	if lm == nil {
		lm = &lightMem{Values: map[string]any{}}
		m[id] = lm
	}
	for _, c := range cmds {
		lm.Values[c.Code] = c.Value
	}
	lm.At = time.Now().UnixMilli()
	b, _ := json.Marshal(m)
	os.WriteFile(p.lightsPath(), b, 0o644)
}

func stateVal(st []deviceState, code string) (any, int64, bool) {
	for _, s := range st {
		if s.Code == code {
			return s.Value, s.Time, true
		}
	}
	return nil, 0, false
}

func setState(st []deviceState, code string, v any) []deviceState {
	for i := range st {
		if st[i].Code == code {
			st[i].Value = v
			return st
		}
	}
	return append(st, deviceState{Code: code, Value: v})
}

func pct(v any, lo, hi float64) int {
	f, ok := toNum(v)
	if !ok || hi <= lo {
		return -1
	}
	x := (f - lo) / (hi - lo) * 100
	if x < 0 {
		x = 0
	}
	if x > 100 {
		x = 100
	}
	return int(x + 0.5)
}

// inferLights дополняет состояние ламп: память команд + питание от выключателя комнаты.
func (p *homePortal) inferLights(devs []homeDevice) {
	lightsMu.Lock()
	mem := p.loadLights()
	lightsMu.Unlock()
	// выключатели по комнатам
	type sw struct {
		name string
		on   bool
		at   int64
	}
	switches := map[string]sw{}
	for _, d := range devs {
		if d.Kind != "switch" || d.Room == "" {
			continue
		}
		v, t, ok := stateVal(d.Status, "switch_1")
		if !ok {
			continue
		}
		on, _ := v.(bool)
		switches[d.Room] = sw{d.Name, on, t}
	}
	for i := range devs {
		d := &devs[i]
		if d.Kind != "light" {
			continue
		}
		d.Bright, d.Temp = -1, -1
		lastAt := int64(0)
		if _, t, ok := stateVal(d.Status, "switch_led"); ok {
			lastAt = t
		}
		// своя память свежее облака — берём её
		if lm := mem[d.ID]; lm != nil && lm.At > lastAt {
			lastAt = lm.At
			for k, v := range lm.Values {
				d.Status = setState(d.Status, k, v)
			}
		}
		on := false
		if v, _, ok := stateVal(d.Status, "switch_led"); ok {
			on, _ = v.(bool)
		}
		if s, ok := switches[d.Room]; ok {
			d.PowerSwitch = s.name
			switch {
			case !s.on:
				on = false
				d.Power = "off"
			case s.at > lastAt:
				on = true // питание подали после последней команды — лампа зажглась сама
				d.Power = "on"
			default:
				d.Power = "on"
			}
		}
		d.Status = setState(d.Status, "switch_led", on)
		d.Guess = true
		// яркость и тон в процентах — по тем кодам, что есть
		var spec map[string]dpSpec
		if p.local != nil {
			spec = p.local.spec(d.ID, d.ProductID)
		}
		rng := func(code string, lo, hi float64) (float64, float64) {
			if s, ok := spec[code]; ok && s.Max > s.Min {
				return s.Min, s.Max
			}
			return lo, hi
		}
		if v, _, ok := stateVal(d.Status, "bright_value_v2"); ok {
			d.Bright = pct(v, 10, 1000)
		} else if v, _, ok := stateVal(d.Status, "bright_value"); ok {
			lo, hi := rng("bright_value", 10, 1000)
			d.Bright = pct(v, lo, hi)
		}
		if v, _, ok := stateVal(d.Status, "temp_value_v2"); ok {
			d.Temp = pct(v, 0, 1000)
		} else if v, _, ok := stateVal(d.Status, "temp_value"); ok {
			lo, hi := rng("temp_value", 0, 1000)
			d.Temp = pct(v, lo, hi)
		}
		if strings.TrimSpace(d.PowerSwitch) == "" {
			d.PowerSwitch = ""
		}
	}
}
