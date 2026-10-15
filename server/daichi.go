package main

// Кондиционер Daichi (облако Daichi Comfort): состояние и управление из портала и киоска.
// Логин и пароль аккаунта лежат на роутере в /etc/photossd-daichi.json (права 600): {"email","password"}.
// API облака неофициальный: POST /token, GET /buildings, GET /devices/{id}, POST /devices/{id}/ctrl.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math/rand"
	"net/http"
	"os"
	"sync"
	"time"
)

const (
	daichiCfgPath = "/etc/photossd-daichi.json"
	daichiBase    = "https://web.daichicloud.ru/api/v4/"
	daichiClient  = "sOJO7B6SqgaKudTfCzqLAy540cCuDzpI"
)

var daichi struct {
	sync.Mutex
	token string
	at    time.Time
	cache []byte
	cacheAt time.Time
}

func daichiCall(method, path string, body any, out any) error {
	cfg := struct{ Email, Password string }{}
	b, err := os.ReadFile(daichiCfgPath)
	if err != nil || json.Unmarshal(b, &cfg) != nil || cfg.Email == "" {
		return errors.New("Daichi не подключён")
	}
	hc := &http.Client{Timeout: 20 * time.Second}
	send := func(tok string) (int, []byte, error) {
		var rd io.Reader
		if body != nil {
			j, _ := json.Marshal(body)
			rd = bytes.NewReader(j)
		}
		req, _ := http.NewRequest(method, daichiBase+path, rd)
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		resp, err := hc.Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()
		d, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		return resp.StatusCode, d, nil
	}
	login := func() (string, error) {
		j, _ := json.Marshal(map[string]string{"grant_type": "password", "email": cfg.Email, "password": cfg.Password, "clientId": daichiClient})
		req, _ := http.NewRequest("POST", daichiBase+"token", bytes.NewReader(j))
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Content-Type", "application/json")
		resp, err := hc.Do(req)
		if err != nil {
			return "", errors.New("облако Daichi недоступно")
		}
		defer resp.Body.Close()
		d, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		var r struct {
			Done    bool
			Message string
			Data    struct {
				Access string `json:"access_token"`
			}
		}
		json.Unmarshal(d, &r)
		if !r.Done || r.Data.Access == "" {
			if r.Message != "" {
				return "", errors.New("Daichi: " + r.Message)
			}
			return "", errors.New("Daichi не принял логин и пароль")
		}
		daichi.Lock()
		daichi.token, daichi.at = r.Data.Access, time.Now()
		daichi.Unlock()
		return r.Data.Access, nil
	}
	daichi.Lock()
	tok := daichi.token
	if time.Since(daichi.at) > 6*time.Hour {
		tok = ""
	}
	daichi.Unlock()
	if tok == "" {
		if tok, err = login(); err != nil {
			return err
		}
	}
	st, d, err := send(tok)
	if err == nil && (st == http.StatusUnauthorized || st == http.StatusFound) {
		if tok, err = login(); err != nil {
			return err
		}
		st, d, err = send(tok)
	}
	if err != nil {
		return errors.New("облако Daichi недоступно")
	}
	var env struct {
		Done    bool            `json:"done"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	json.Unmarshal(d, &env)
	if st >= 500 || !env.Done {
		if env.Message != "" {
			return errors.New("Daichi: " + env.Message)
		}
		return errors.New("Daichi: ошибка облака")
	}
	if out != nil {
		return json.Unmarshal(env.Data, out)
	}
	return nil
}

type daichiFn struct {
	ID          int    `json:"id"`
	Title       string `json:"title"`
	Type        string `json:"type"`
	Units       string `json:"units,omitempty"`
	On          bool   `json:"on"`
	Value       any    `json:"value,omitempty"`
	Controllable bool  `json:"controllable"`
	Blocked     bool   `json:"blocked"`
	Power       bool   `json:"power,omitempty"`
	Range       []float64 `json:"range,omitempty"`
	Cmd         string `json:"cmd,omitempty"`
	Link        *daichiFn `json:"link,omitempty"`
}

type daichiDev struct {
	ID     int        `json:"id"`
	Title  string     `json:"title"`
	Status string     `json:"status"`
	Temp   float64    `json:"temp"`
	On     bool       `json:"on"`
	Info   string     `json:"info,omitempty"`
	Model  string     `json:"model,omitempty"`
	PowerFn int       `json:"powerFn,omitempty"`
	Fns    []daichiFn `json:"functions"`
}

func daichiDevices() ([]daichiDev, error) {
	var buildings []struct {
		Places []struct{ ID int } `json:"places"`
	}
	if err := daichiCall("GET", "buildings", nil, &buildings); err != nil {
		return nil, err
	}
	devs := []daichiDev{}
	for _, b := range buildings {
		for _, pl := range b.Places {
			var d struct {
				ID      int
				Title   string
				Status  string
				CurTemp float64 `json:"curTemp"`
				State   struct {
					IsOn bool `json:"isOn"`
					Info struct{ Text string }
				}
				DeviceInfo struct{ Brand, Seria, Model string }
				Pult       []struct {
					Functions []struct {
						ID    int
						Title *string
						UI    struct {
							ControlType string `json:"controlType"`
							Units       *string
							Ranges      []struct{ Range []float64 } `json:"rangeIconsInfo"`
						} `json:"uiInfo"`
						State struct {
							Value        any
							IsOn         bool
							Blocked      bool
							Controllable bool
							ValueRange   []float64 `json:"valueRange"`
						}
						Meta struct {
							IsPowerOnFunction bool `json:"isPowerOnFunction"`
							Ble               struct {
								OnCmd *string `json:"bleOnCommand"`
							} `json:"bleTagInfo"`
						} `json:"metaData"`
						Linked *struct {
							ID    int
							Title *string
							State struct {
								IsOn         bool
								Controllable bool
							}
							Meta struct {
								IsPowerOnFunction bool `json:"isPowerOnFunction"`
							} `json:"metaData"`
						} `json:"linkedFunction"`
					}
				}
			}
			if err := daichiCall("GET", "devices/"+itoa(pl.ID), nil, &d); err != nil {
				return nil, err
			}
			dev := daichiDev{ID: d.ID, Title: d.Title, Status: d.Status, Temp: d.CurTemp, On: d.State.IsOn, Info: d.State.Info.Text, Model: d.DeviceInfo.Brand + " " + d.DeviceInfo.Model, Fns: []daichiFn{}}
			for _, p := range d.Pult {
				for _, f := range p.Functions {
					fn := daichiFn{ID: f.ID, Type: f.UI.ControlType, On: f.State.IsOn, Value: f.State.Value, Controllable: f.State.Controllable, Blocked: f.State.Blocked, Power: f.Meta.IsPowerOnFunction}
					if f.Title != nil {
						fn.Title = *f.Title
					}
					if f.UI.Units != nil {
						fn.Units = *f.UI.Units
					}
					if len(f.State.ValueRange) == 2 {
						fn.Range = f.State.ValueRange
					} else if f.UI.ControlType == "LINEAR_SLIDER" && len(f.UI.Ranges) > 0 {
						fn.Range = []float64{1, float64(len(f.UI.Ranges))}
					}
					if f.Meta.Ble.OnCmd != nil {
						fn.Cmd = *f.Meta.Ble.OnCmd
					}
					if l := f.Linked; l != nil {
						lk := &daichiFn{ID: l.ID, On: l.State.IsOn, Controllable: l.State.Controllable, Power: l.Meta.IsPowerOnFunction}
						if l.Title != nil {
							lk.Title = *l.Title
						}
						fn.Link = lk
						if lk.Power {
							dev.PowerFn = l.ID
						}
					}
					dev.Fns = append(dev.Fns, fn)
				}
			}
			devs = append(devs, dev)
		}
	}
	return devs, nil
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func (p *homePortal) handleDaichi(w http.ResponseWriter, r *http.Request) {
	daichi.Lock()
	if time.Since(daichi.cacheAt) < 8*time.Second && daichi.cache != nil && r.URL.Query().Get("fresh") == "" {
		c := daichi.cache
		daichi.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write(c)
		return
	}
	daichi.Unlock()
	devs, err := daichiDevices()
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	b, _ := json.Marshal(map[string]any{"devices": devs})
	daichi.Lock()
	daichi.cache, daichi.cacheAt = b, time.Now()
	daichi.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

// handleDaichiCtrl: {"device":id,"function":id,"value":число} или {"device":id,"function":id,"on":true|false}
func (p *homePortal) handleDaichiCtrl(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Device   int      `json:"device"`
		Function int      `json:"function"`
		Value    *float64 `json:"value"`
		On       *bool    `json:"on"`
	}
	json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&q)
	if q.Device <= 0 || q.Function <= 0 || (q.Value == nil && q.On == nil) {
		fail(w, http.StatusBadRequest, "неверная команда")
		return
	}
	ctl := map[string]any{"functionId": q.Function, "parameters": nil}
	if q.Value != nil {
		ctl["value"] = *q.Value
	} else {
		ctl["isOn"] = *q.On
	}
	body := map[string]any{"cmdId": rand.Intn(99999999), "value": ctl, "conflictResolveData": nil}
	if err := daichiCall("POST", "devices/"+itoa(q.Device)+"/ctrl?ignoreConflicts=false", body, nil); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	daichi.Lock()
	daichi.cache = nil
	daichi.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleDaichiLogin сохраняет логин и пароль Daichi (из настроек портала); перед сохранением проверяет вход.
func (p *homePortal) handleDaichiLogin(w http.ResponseWriter, r *http.Request) {
	var q struct{ Email, Password string }
	json.NewDecoder(io.LimitReader(r.Body, 2048)).Decode(&q)
	if q.Email == "" || q.Password == "" {
		fail(w, http.StatusBadRequest, "введите email и пароль")
		return
	}
	j, _ := json.Marshal(map[string]string{"grant_type": "password", "email": q.Email, "password": q.Password, "clientId": daichiClient})
	req, _ := http.NewRequest("POST", daichiBase+"token", bytes.NewReader(j))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		fail(w, http.StatusBadGateway, "облако Daichi недоступно")
		return
	}
	defer resp.Body.Close()
	d, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var rr struct {
		Done    bool
		Message string
		Data    struct {
			Access string `json:"access_token"`
		}
	}
	json.Unmarshal(d, &rr)
	if !rr.Done || rr.Data.Access == "" {
		msg := "Daichi не принял логин и пароль"
		if rr.Message != "" {
			msg = "Daichi: " + rr.Message
		}
		fail(w, http.StatusUnauthorized, msg)
		return
	}
	b, _ := json.Marshal(map[string]string{"email": q.Email, "password": q.Password})
	if err := os.WriteFile(daichiCfgPath, b, 0600); err != nil {
		fail(w, http.StatusInternalServerError, "не удалось сохранить на роутере")
		return
	}
	daichi.Lock()
	daichi.token, daichi.at, daichi.cache = rr.Data.Access, time.Now(), nil
	daichi.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (p *homePortal) handleDaichiLogout(w http.ResponseWriter, r *http.Request) {
	os.Remove(daichiCfgPath)
	daichi.Lock()
	daichi.token, daichi.cache = "", nil
	daichi.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleDaichiAccount: есть ли сохранённый аккаунт (сам пароль наружу не отдаётся)
func (p *homePortal) handleDaichiAccount(w http.ResponseWriter, r *http.Request) {
	cfg := struct{ Email string }{}
	if b, err := os.ReadFile(daichiCfgPath); err == nil {
		json.Unmarshal(b, &cfg)
	}
	writeJSON(w, 200, map[string]any{"connected": cfg.Email != "", "email": cfg.Email})
}
