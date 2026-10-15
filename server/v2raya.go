package main

// Управление узлами v2rayA с рабочего стола: список узлов и переключение.
// Логин и пароль v2rayA лежат на роутере в /etc/photossd-v2raya.json (права 600): {"url","username","password"}.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

const v2rayaCfgPath = "/etc/photossd-v2raya.json"

var v2raya struct {
	sync.Mutex
	token string
}

type v2rayaCfg struct {
	URL      string `json:"url"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func v2rayaConfig() (v2rayaCfg, error) {
	var c v2rayaCfg
	b, err := os.ReadFile(v2rayaCfgPath)
	if err != nil {
		return c, errors.New("v2rayA не настроен на роутере")
	}
	if json.Unmarshal(b, &c) != nil || c.Username == "" {
		return c, errors.New("файл настроек v2rayA повреждён")
	}
	if c.URL == "" {
		c.URL = "http://127.0.0.1:2017"
	}
	return c, nil
}

// v2rayaCall вызывает API v2rayA; при 401 один раз перелогинивается.
func v2rayaCall(method, path string, body any) (json.RawMessage, error) {
	c, err := v2rayaConfig()
	if err != nil {
		return nil, err
	}
	hc := &http.Client{Timeout: 25 * time.Second}
	do := func(tok string) (int, []byte, error) {
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, c.URL+path, rd)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if tok != "" {
			req.Header.Set("Authorization", tok)
		}
		resp, err := hc.Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		return resp.StatusCode, b, nil
	}
	v2raya.Lock()
	tok := v2raya.token
	v2raya.Unlock()
	login := func() (string, error) {
		st, b, err := do0(hc, c, "/api/login")
		if err != nil || st != 200 {
			return "", errors.New("v2rayA не принимает логин и пароль")
		}
		var r struct{ Data struct{ Token string } }
		json.Unmarshal(b, &r)
		if r.Data.Token == "" {
			return "", errors.New("v2rayA не выдала токен")
		}
		v2raya.Lock()
		v2raya.token = r.Data.Token
		v2raya.Unlock()
		return r.Data.Token, nil
	}
	if tok == "" {
		if tok, err = login(); err != nil {
			return nil, err
		}
	}
	st, b, err := do(tok)
	if err == nil && st == http.StatusUnauthorized {
		if tok, err = login(); err != nil {
			return nil, err
		}
		st, b, err = do(tok)
	}
	if err != nil {
		return nil, errors.New("v2rayA не отвечает")
	}
	var r struct {
		Code    string          `json:"code"`
		Data    json.RawMessage `json:"data"`
		Message string          `json:"message"`
	}
	json.Unmarshal(b, &r)
	if st != 200 || r.Code != "SUCCESS" {
		msg := r.Message
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", st)
		}
		return nil, errors.New("v2rayA: " + msg)
	}
	return r.Data, nil
}

func do0(hc *http.Client, c v2rayaCfg, path string) (int, []byte, error) {
	b, _ := json.Marshal(map[string]string{"username": c.Username, "password": c.Password})
	resp, err := hc.Post(c.URL+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, out, nil
}

type v2rayaSrv struct {
	ID   int    `json:"id"`
	Type string `json:"type"`
	Sub  int    `json:"sub"`
	Name string `json:"name"`
	Addr string `json:"address"`
	Net  string `json:"net"`
	Ping string `json:"ping,omitempty"`
	On   bool   `json:"on"`
}

func (p *homePortal) handleV2raya(w http.ResponseWriter, r *http.Request) {
	data, err := v2rayaCall("GET", "/api/touch", nil)
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	var t struct {
		Running bool `json:"running"`
		Touch   struct {
			Servers []struct {
				ID                      int
				Type                    string `json:"_type"`
				Name, Address, Net, Ping string
				PingLatency             string `json:"pingLatency"`
			} `json:"servers"`
			Subs []struct {
				ID      int
				Host    string
				Servers []struct {
					ID                       int
					Type                     string `json:"_type"`
					Name, Address, Net       string
					PingLatency              string `json:"pingLatency"`
				} `json:"servers"`
			} `json:"subscriptions"`
			Connected []struct {
				ID   int
				Type string `json:"_type"`
				Sub  int
			} `json:"connectedServer"`
		} `json:"touch"`
	}
	if json.Unmarshal(data, &t) != nil {
		fail(w, http.StatusBadGateway, "v2rayA вернула непонятный ответ")
		return
	}
	on := func(id int, typ string, sub int) bool {
		for _, c := range t.Touch.Connected {
			if c.ID == id && c.Type == typ && (typ != "subscriptionServer" || c.Sub == sub) {
				return true
			}
		}
		return false
	}
	list := []v2rayaSrv{}
	for _, s := range t.Touch.Servers {
		list = append(list, v2rayaSrv{ID: s.ID, Type: "server", Name: s.Name, Addr: s.Address, Net: s.Net, Ping: s.PingLatency, On: on(s.ID, "server", 0)})
	}
	for i, sub := range t.Touch.Subs {
		for _, s := range sub.Servers {
			list = append(list, v2rayaSrv{ID: s.ID, Type: "subscriptionServer", Sub: i, Name: s.Name, Addr: s.Address, Net: s.Net, Ping: s.PingLatency, On: on(s.ID, "subscriptionServer", i)})
		}
	}
	cur := ""
	for _, s := range list {
		if s.On {
			cur = s.Name
		}
	}
	writeJSON(w, 200, map[string]any{"running": t.Running, "current": cur, "servers": list})
}

func (p *homePortal) handleV2rayaConnect(w http.ResponseWriter, r *http.Request) {
	var q struct {
		ID   int    `json:"id"`
		Type string `json:"type"`
		Sub  int    `json:"sub"`
	}
	json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&q)
	if q.Type != "server" && q.Type != "subscriptionServer" {
		fail(w, http.StatusBadRequest, "неизвестный тип узла")
		return
	}
	if q.ID <= 0 {
		fail(w, http.StatusBadRequest, "не указан узел")
		return
	}
	// сначала снимаем текущее подключение, потом выбираем новый узел и (пере)запускаем ядро
	if data, err := v2rayaCall("GET", "/api/touch", nil); err == nil {
		var t struct {
			Touch struct {
				Connected []struct {
					ID   int
					Type string `json:"_type"`
					Sub  int
				} `json:"connectedServer"`
			} `json:"touch"`
		}
		json.Unmarshal(data, &t)
		for _, c := range t.Touch.Connected {
			v2rayaCall("DELETE", "/api/connection", map[string]any{"id": c.ID, "_type": c.Type, "sub": c.Sub, "outbound": "proxy"})
		}
	}
	if _, err := v2rayaCall("POST", "/api/connection", map[string]any{"id": q.ID, "_type": q.Type, "sub": q.Sub, "outbound": "proxy"}); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if _, err := v2rayaCall("POST", "/api/v2ray", nil); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
