// Снимок облака Tuya на диске и опрос устройств по домашней сети.
// Облако нужно только один раз — взять список, ключи и схемы; дальше свет живёт локально,
// даже если квота облака кончилась или роутер перезагрузился.
package main

import (
	"encoding/json"
	"log"
	"os"
	"sort"
	"sync"
	"time"
)

type snapLocal struct {
	IP      string `json:"ip"`
	Version string `json:"version"`
	GwID    string `json:"gwId,omitempty"`
	NodeID  string `json:"nodeId,omitempty"`
	Key     string `json:"key"`
}

type tuyaSnap struct {
	At     int64                        `json:"at"`
	List   []any                        `json:"list"`   // ответ облака: устройства (с local_key)
	Rooms  map[string]string            `json:"rooms"`  // id устройства -> комната
	HomeID string                       `json:"homeId"`
	Specs  map[string]map[string]dpSpec `json:"specs"`  // productId -> code -> dp
	Local  map[string]snapLocal         `json:"local"`  // devId -> как достучаться по сети
}

var snapMu sync.Mutex

func (p *homePortal) snapPath() string {
	if p.s == nil {
		return ""
	}
	return p.s.meta("tuya-cache.json")
}

func (p *homePortal) loadSnap() *tuyaSnap {
	path := p.snapPath()
	if path == "" {
		return nil
	}
	snapMu.Lock()
	defer snapMu.Unlock()
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var s tuyaSnap
	if json.Unmarshal(b, &s) != nil {
		return nil
	}
	return &s
}

// saveSnap меняет снимок и атомарно пишет его на диск.
func (p *homePortal) saveSnap(fn func(s *tuyaSnap)) {
	path := p.snapPath()
	if path == "" {
		return
	}
	snapMu.Lock()
	defer snapMu.Unlock()
	var s tuyaSnap
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &s)
	}
	fn(&s)
	s.At = time.Now().Unix()
	b, err := json.Marshal(&s)
	if err != nil {
		return
	}
	if os.WriteFile(path+".tmp", b, 0o600) == nil {
		os.Rename(path+".tmp", path)
	}
}

// restore поднимает локальные адреса и ключи из снимка — управление работает сразу после запуска.
func (tl *tuyaLocal) restore() {
	s := tl.p.loadSnap()
	if s == nil {
		return
	}
	tl.mu.Lock()
	defer tl.mu.Unlock()
	for id, l := range s.Local {
		if l.IP == "" || l.Key == "" {
			continue
		}
		tl.devs[id] = &localDev{ID: id, Key: []byte(l.Key), IP: l.IP, Version: l.Version, GwID: l.GwID, NodeID: l.NodeID}
	}
	for prod, sp := range s.Specs {
		if len(sp) > 0 {
			tl.specs[prod] = sp
		}
	}
	if len(tl.devs) > 0 {
		log.Printf("tuya local: из снимка %d устройств", len(tl.devs))
	}
}

func (tl *tuyaLocal) saveLocal(found map[string]*localDev) {
	tl.p.saveSnap(func(s *tuyaSnap) {
		s.Local = map[string]snapLocal{}
		for id, d := range found {
			s.Local[id] = snapLocal{IP: d.IP, Version: d.Version, GwID: d.GwID, NodeID: d.NodeID, Key: string(d.Key)}
		}
	})
}

type localState struct {
	dps map[string]any
	at  time.Time
}

// pollLoop по очереди спрашивает состояние у каждого устройства в сети (одно соединение за раз —
// шлюзы Tuya плохо переносят параллельные подключения).
func (tl *tuyaLocal) pollLoop() {
	for {
		tl.mu.Lock()
		list := make([]*localDev, 0, len(tl.devs))
		for _, d := range tl.devs {
			list = append(list, d)
		}
		tl.mu.Unlock()
		sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
		for _, d := range list {
			tl.io.Lock()
			st, err := localStatus(d)
			tl.io.Unlock()
			if err != nil || len(st) == 0 {
				continue
			}
			tl.mu.Lock()
			tl.states[d.ID] = localState{dps: st, at: time.Now()}
			tl.mu.Unlock()
		}
		time.Sleep(15 * time.Second)
	}
}

// fresh — устройство недавно ответило по сети.
func (tl *tuyaLocal) fresh(devID string) bool {
	tl.mu.Lock()
	defer tl.mu.Unlock()
	ls, ok := tl.states[devID]
	return ok && time.Since(ls.at) < 90*time.Second
}

// codes переводит номера DP из локального ответа в коды облака (switch_led, bright_value_v2…).
// Время не ставим: локальное значение не должно перебивать память о последней команде (lights.go).
func (tl *tuyaLocal) codes(devID, productID string) []deviceState {
	tl.mu.Lock()
	ls, ok := tl.states[devID]
	tl.mu.Unlock()
	if !ok || time.Since(ls.at) > 2*time.Minute {
		return nil
	}
	sp := tl.spec(devID, productID)
	if len(sp) == 0 {
		return nil
	}
	byID := map[string]string{}
	for code, s := range sp {
		byID[s.ID] = code
	}
	var st []deviceState
	for dp, v := range ls.dps {
		code, ok := byID[dp]
		if !ok {
			continue
		}
		st = append(st, deviceState{Code: code, Value: v})
		// у Bluetooth-ламп коды без _v2 и свой диапазон — даём панели и облачный вариант 10..1000 / 0..1000
		if code == "bright_value" || code == "temp_value" {
			s := sp[code]
			if _, has := sp[code+"_v2"]; !has && s.Max > s.Min && s.Max != 1000 {
				if f, isNum := toNum(v); isNum {
					srcMin := 0.0
					if code == "bright_value" {
						srcMin = 10
					}
					nv := srcMin + (f-s.Min)/(s.Max-s.Min)*(1000-srcMin)
					st = append(st, deviceState{Code: code + "_v2", Value: float64(int(nv + 0.5))})
				}
			}
		}
	}
	sort.Slice(st, func(i, j int) bool { return st[i].Code < st[j].Code })
	return st
}
