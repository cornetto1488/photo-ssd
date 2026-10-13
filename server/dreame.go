// Пылесос Dreame (облако Dreamehome): статус, управление, история уборок.
// Протокол — по открытой интеграции Tasshack/dreame-vacuum. Логин и пароль вводятся
// в панели и хранятся на роутере (/etc/dreame.json, пароль — только как md5 с солью приложения).
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	dreameConfFile = "/etc/dreame.json"
	dreamePort     = "13267"
	dreameSalt     = "RAylYC%fmSKp7%Tq"
	dreameBasic    = "ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg="
	dreameCID      = "EETjszu*XI5znHsI"
	dreameUA       = "Dart/3.9 (dart:io)"
	dreameVer      = "102060300"
)

type dreameConf struct {
	User    string `json:"user"`
	PwHash  string `json:"pw"`      // md5(пароль + соль)
	Country string `json:"country"` // ru, eu, cn, us, sg
}

type dreameClient struct {
	mu sync.Mutex
	cf dreameConf

	vs      string // случайный «отпечаток» сессии
	key     string
	refresh string
	expire  time.Time
	tenant  string
	region  string
	lang    string
	ccode   string

	did, model, host, uid, name string
	id                          int

	statusAt time.Time
	status   map[string]any
	histAt   time.Time
	hist     []map[string]any
}

var dreame = &dreameClient{}

// setFrom копирует состояние (кроме мьютекса) из o.
func (c *dreameClient) setFrom(o *dreameClient) {
	c.cf, c.vs, c.key, c.refresh, c.expire, c.tenant = o.cf, o.vs, o.key, o.refresh, o.expire, o.tenant
	c.region, c.lang, c.ccode = o.region, o.lang, o.ccode
	c.did, c.model, c.host, c.uid, c.name, c.id = o.did, o.model, o.host, o.uid, o.name, o.id
	c.statusAt, c.status, c.histAt, c.hist = o.statusAt, o.status, o.histAt, o.hist
}

func md5hex(s string) string { h := md5.Sum([]byte(s)); return hex.EncodeToString(h[:]) }

func dreameLoad() {
	dreame.mu.Lock()
	defer dreame.mu.Unlock()
	if dreame.cf.User != "" {
		return
	}
	if b, err := os.ReadFile(dreameConfFile); err == nil {
		json.Unmarshal(b, &dreame.cf)
	}
}

func (c *dreameClient) apiURL() string { return "https://" + c.cf.Country + ".iot.dreame.tech:" + dreamePort }

func (c *dreameClient) headers(contentType string) http.Header {
	if c.vs == "" {
		b := make([]byte, 16)
		rand.Read(b)
		c.vs = md5hex(string(b))
	}
	h := http.Header{}
	h.Set("User-Agent", dreameUA)
	h.Set("Dreame-Meta", "cv=a_"+dreameVer+";canvasHash="+md5hex(c.cf.User+"c")[:8]+";webglHash="+md5hex(c.cf.User+"w")[:8]+";visitorIdHash="+c.vs)
	if c.region != "" && c.lang != "" && c.ccode != "" {
		data := []byte(c.region + "|" + c.lang + "|" + c.ccode)
		pad := 16 - len(data)%16
		data = append(data, bytes.Repeat([]byte{byte(pad)}, pad)...)
		blk, _ := aes.NewCipher([]byte(dreameCID))
		out := make([]byte, len(data))
		for i := 0; i < len(data); i += 16 {
			blk.Encrypt(out[i:i+16], data[i:i+16])
		}
		h.Set("Dreame-Rlc", base64.StdEncoding.EncodeToString(out))
	}
	t := c.tenant
	if t == "" {
		t = "000000"
	}
	h.Set("Tenant-Id", t)
	h.Set("Authorization", "Basic "+dreameBasic)
	h.Set("Content-Type", contentType)
	return h
}

var dreameHTTP = &http.Client{Timeout: 15 * time.Second}

// login — пароль или refresh-токен. Вызывать под c.mu.
func (c *dreameClient) login(useRefresh bool) error {
	var body string
	if useRefresh && c.refresh != "" {
		body = "grant_type=refresh_token&scope=all&platform=ANDROID&type=account&refresh_token=" + c.refresh
	} else {
		body = "grant_type=password&scope=all&platform=ANDROID&type=account&username=" + url.QueryEscape(c.cf.User) +
			"&password=" + c.cf.PwHash
		if c.ccode != "" && c.lang != "" {
			body += "&country=" + c.ccode + "&lang=" + c.lang
		} else {
			body += "&country=" + strings.ToUpper(c.cf.Country) + "&lang=ru"
		}
	}
	req, _ := http.NewRequest("POST", c.apiURL()+"/dreame-auth/oauth/token", strings.NewReader(body))
	req.Header = c.headers("application/x-www-form-urlencoded")
	resp, err := dreameHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("облако Dreame недоступно: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var d map[string]any
	json.Unmarshal(raw, &d)
	if resp.StatusCode != 200 {
		desc, _ := d["error_description"].(string)
		if useRefresh && strings.Contains(desc, "refresh token") {
			c.refresh = ""
			return c.login(false)
		}
		if desc == "" {
			desc = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return fmt.Errorf("вход не удался: %s", desc)
	}
	tok, _ := d["access_token"].(string)
	if tok == "" {
		return fmt.Errorf("облако не вернуло токен")
	}
	c.key = tok
	c.refresh, _ = d["refresh_token"].(string)
	exp, _ := d["expires_in"].(float64)
	c.expire = time.Now().Add(time.Duration(exp) * time.Second)
	if v, ok := d["tenant_id"].(string); ok && v != "" {
		c.tenant = v
	}
	if v, ok := d["region"].(string); ok && v != "" {
		c.region = v
	}
	if v, ok := d["lang"].(string); ok && v != "" {
		c.lang = v
	}
	if v, ok := d["country"].(string); ok && v != "" {
		c.ccode = v
	}
	return nil
}

// ---- подпись запросов (как в приложении) ----

func dreameJSON(v any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	e.Encode(v)
	return strings.TrimRight(b.String(), "\n")
}

func dreameSplice(m map[string]any, top bool) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		switch v := m[k].(type) {
		case map[string]any:
			if inner := dreameSplice(v, false); inner != "" {
				parts = append(parts, k+"=["+inner+"]")
			} else {
				parts = append(parts, k+"=]")
			}
		case []any:
			if top {
				parts = append(parts, k+"="+dreameJSON(v))
			}
		case bool:
			parts = append(parts, k+"="+strconv.FormatBool(v))
		case nil:
			parts = append(parts, k+"=null")
		default:
			if top {
				parts = append(parts, k+"="+fmt.Sprint(v))
			} else {
				parts = append(parts, k+"="+dreameJSON(v))
			}
		}
	}
	return strings.Join(parts, "&")
}

func dreameSigned(p map[string]any) map[string]any {
	ms := time.Now().UnixMilli()
	out := map[string]any{}
	for k, v := range p {
		out[k] = v
	}
	out["sign"] = md5hex(dreameSplice(p, true) + strconv.FormatInt(ms, 10) + dreameCID)
	out["timestamp"] = ms
	return out
}

// call — подписанный POST к API. path без начального слэша. Вызывать под c.mu.
func (c *dreameClient) call(path string, params map[string]any, retried bool) (map[string]any, error) {
	if c.key == "" {
		if err := c.login(false); err != nil {
			return nil, err
		}
	} else if rem := time.Until(c.expire); rem > 0 && rem <= 10*time.Minute {
		c.login(true)
	}
	var rdr io.Reader
	if params != nil {
		rdr = strings.NewReader(dreameJSON(dreameSigned(params)))
	}
	req, _ := http.NewRequest("POST", c.apiURL()+"/"+path, rdr)
	req.Header = c.headers("application/json")
	req.Header.Set("Dreame-Auth", c.key)
	resp, err := dreameHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("облако Dreame недоступно")
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == 401 && !retried {
		if err := c.login(true); err != nil {
			return nil, err
		}
		return c.call(path, params, true)
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("Dreame ответил HTTP %d", resp.StatusCode)
	}
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil {
		return nil, fmt.Errorf("Dreame вернул не JSON")
	}
	return out, nil
}

// ensureDevice находит пылесос в аккаунте. Под c.mu.
func (c *dreameClient) ensureDevice() error {
	if c.did != "" {
		return nil
	}
	r, err := c.call("dreame-user-iot/iotuserbind/device/listV2", nil, false)
	if err != nil {
		return err
	}
	if code, _ := r["code"].(float64); code != 0 {
		return fmt.Errorf("Dreame: %v", r["msg"])
	}
	data, _ := r["data"].(map[string]any)
	page, _ := data["page"].(map[string]any)
	recs, _ := page["records"].([]any)
	for _, x := range recs {
		d, _ := x.(map[string]any)
		model, _ := d["model"].(string)
		if !strings.Contains(model, ".vacuum.") {
			continue
		}
		c.did = fmt.Sprint(d["did"])
		c.model = model
		c.host, _ = d["bindDomain"].(string)
		c.uid = fmt.Sprint(d["masterUid"])
		if n, _ := d["customName"].(string); n != "" {
			c.name = n
		} else if di, ok := d["deviceInfo"].(map[string]any); ok {
			c.name, _ = di["displayName"].(string)
		}
		return nil
	}
	return fmt.Errorf("в аккаунте Dreame не найден пылесос")
}

// send — команда устройству (get_properties / set_properties / action). Под c.mu.
func (c *dreameClient) send(method string, params any) (any, error) {
	if err := c.ensureDevice(); err != nil {
		return nil, err
	}
	c.id++
	host := ""
	if c.host != "" {
		host = "-" + strings.SplitN(c.host, ".", 2)[0]
	}
	r, err := c.call("dreame-iot-com"+host+"/device/sendCommand", map[string]any{
		"did": c.did, "id": c.id,
		"data": map[string]any{"did": c.did, "id": c.id, "method": method, "params": params},
	}, false)
	if err != nil {
		return nil, err
	}
	data, _ := r["data"].(map[string]any)
	if data == nil || data["result"] == nil {
		if code, _ := r["code"].(float64); code != 0 {
			return nil, fmt.Errorf("Dreame: %v", r["msg"])
		}
		return nil, fmt.Errorf("пылесос не ответил (возможно, спит или вне сети)")
	}
	return data["result"], nil
}

var dreameStateRU = map[int]string{
	1: "Убирает", 2: "Ожидает", 3: "Пауза", 4: "Ошибка", 5: "Возвращается на базу", 6: "Заряжается", 7: "Моет пол",
	8: "Сушит швабру", 9: "Моет швабру", 10: "Едет на мойку", 11: "Строит карту", 12: "Убирает и моет", 13: "Заряжен",
	14: "Обновляется", 15: "Едет к вам", 16: "Сброс станции", 17: "Ставит швабру", 18: "Снимает швабру", 19: "Проверяет воду",
	20: "Набирает воду", 21: "Мойка на паузе", 22: "Опустошает пылесборник", 23: "Ручное управление", 24: "Умная зарядка",
	25: "Повторная уборка", 26: "Следует за вами", 27: "Точечная уборка", 28: "Едет опустошаться", 29: "Ждёт задачу",
	30: "Чистит станцию", 31: "Едет на слив", 32: "Сливает воду", 33: "Сливает воду", 34: "Опустошается",
	35: "Сушит пылесборник", 107: "Уход за полом", 118: "Умная подзарядка", 121: "Заезжает на базу", 122: "Выезжает с базы",
}

// ---- статус ----

type dreameProp struct{ s, p int }

var dreameProps = []dreameProp{
	{2, 1}, {2, 2}, {3, 1}, {3, 2}, {4, 2}, {4, 3}, {4, 4}, {4, 5},
	{9, 2}, {10, 2}, {11, 1}, {16, 1}, {17, 1}, {18, 1},
	{12, 1}, {12, 2}, {12, 3}, {12, 4},
}

func num(v any) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case string:
		n, _ := strconv.Atoi(x)
		return n
	case bool:
		if x {
			return 1
		}
	}
	return -1
}

func (c *dreameClient) fetchStatus() (map[string]any, error) {
	params := make([]any, 0, len(dreameProps))
	for _, p := range dreameProps {
		params = append(params, map[string]any{"did": c.did, "siid": p.s, "piid": p.p})
	}
	if err := c.ensureDevice(); err != nil {
		return nil, err
	}
	for i := range params {
		params[i].(map[string]any)["did"] = c.did
	}
	res, err := c.send("get_properties", params)
	if err != nil {
		return nil, err
	}
	list, _ := res.([]any)
	vals := map[string]any{}
	for _, x := range list {
		m, _ := x.(map[string]any)
		if code, _ := m["code"].(float64); code != 0 {
			continue
		}
		vals[fmt.Sprintf("%d.%d", num(m["siid"]), num(m["piid"]))] = m["value"]
	}
	st := num(vals["2.1"])
	text := dreameStateRU[st]
	if text == "" {
		text = "Состояние " + strconv.Itoa(st)
	}
	cons := []map[string]any{}
	for _, cdef := range []struct {
		key, name string
	}{{"9.2", "Основная щётка"}, {"10.2", "Боковая щётка"}, {"11.1", "Фильтр"}, {"16.1", "Датчики"}, {"17.1", "Фильтр бака"}, {"18.1", "Швабра"}} {
		if v, ok := vals[cdef.key]; ok && num(v) >= 0 {
			cons = append(cons, map[string]any{"name": cdef.name, "pct": num(v)})
		}
	}
	return map[string]any{
		"name": c.name, "model": c.model,
		"state": st, "stateText": text, "error": num(vals["2.2"]),
		"battery": num(vals["3.1"]), "charging": num(vals["3.2"]),
		"cleanMin": num(vals["4.2"]), "cleanArea": num(vals["4.3"]),
		"suction": num(vals["4.4"]), "water": num(vals["4.5"]),
		"totals": map[string]any{"first": num(vals["12.1"]), "minutes": num(vals["12.2"]), "count": num(vals["12.3"]), "area": num(vals["12.4"])},
		"consumables": cons,
		"at":          time.Now().Unix(),
	}, nil
}

func dreameReply(w http.ResponseWriter, code int, v any) { writeJSON(w, code, v) }

func (p *homePortal) handleDreame(w http.ResponseWriter, r *http.Request) {
	dreameLoad()
	c := dreame
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cf.User == "" {
		dreameReply(w, 200, map[string]any{"configured": false})
		return
	}
	if r.URL.Query().Get("fresh") != "1" && c.status != nil && time.Since(c.statusAt) < 15*time.Second {
		dreameReply(w, 200, map[string]any{"configured": true, "status": c.status})
		return
	}
	st, err := c.fetchStatus()
	if err != nil {
		out := map[string]any{"configured": true, "error": err.Error()}
		if c.status != nil {
			out["status"], out["stale"] = c.status, true
		}
		dreameReply(w, 200, out)
		return
	}
	c.status, c.statusAt = st, time.Now()
	dreameReply(w, 200, map[string]any{"configured": true, "status": st})
}

// POST /api/home/dreame/login {user, password, country}
func (p *homePortal) handleDreameLogin(w http.ResponseWriter, r *http.Request) {
	var q struct{ User, Password, Country string }
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&q) != nil || strings.TrimSpace(q.User) == "" || q.Password == "" {
		fail(w, http.StatusBadRequest, "Введите логин и пароль от Dreamehome")
		return
	}
	cty := strings.ToLower(strings.TrimSpace(q.Country))
	switch cty {
	case "ru", "eu", "cn", "us", "sg":
	default:
		cty = "ru"
	}
	c := &dreameClient{cf: dreameConf{User: strings.TrimSpace(q.User), PwHash: md5hex(q.Password + dreameSalt), Country: cty}}
	c.mu.Lock()
	err := c.login(false)
	if err == nil {
		err = c.ensureDevice()
	}
	c.mu.Unlock()
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	b, _ := json.Marshal(c.cf)
	if os.WriteFile(dreameConfFile, b, 0o600) != nil {
		fail(w, http.StatusInternalServerError, "не удалось сохранить настройки")
		return
	}
	dreame.mu.Lock()
	dreame.setFrom(c)
	dreame.mu.Unlock()
	log.Printf("Dreame: аккаунт подключён (%s)", c.model)
	dreameReply(w, 200, map[string]any{"ok": true, "name": c.name, "model": c.model})
}

func (p *homePortal) handleDreameLogout(w http.ResponseWriter, r *http.Request) {
	os.Remove(dreameConfFile)
	dreame.mu.Lock()
	dreame.setFrom(&dreameClient{})
	dreame.mu.Unlock()
	dreameReply(w, 200, map[string]any{"ok": true})
}

// POST /api/home/dreame/cmd {action: start|pause|stop|dock|locate}
func (p *homePortal) handleDreameCmd(w http.ResponseWriter, r *http.Request) {
	dreameLoad()
	var q struct{ Action string }
	json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&q)
	acts := map[string][2]int{"start": {2, 1}, "pause": {2, 2}, "dock": {3, 1}, "stop": {4, 2}, "locate": {7, 1}}
	a, ok := acts[q.Action]
	if !ok {
		fail(w, http.StatusBadRequest, "неизвестная команда")
		return
	}
	c := dreame
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cf.User == "" {
		fail(w, http.StatusConflict, "Dreame не подключён")
		return
	}
	if err := c.ensureDevice(); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	res, err := c.send("action", map[string]any{"did": c.did, "siid": a[0], "aiid": a[1], "in": []any{}})
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	c.statusAt = time.Time{}
	log.Printf("Dreame: команда %s (%s)", q.Action, clientIP(r))
	dreameReply(w, 200, map[string]any{"ok": true, "result": res})
}

// GET /api/home/dreame/history — последние уборки.
func (p *homePortal) handleDreameHistory(w http.ResponseWriter, r *http.Request) {
	dreameLoad()
	c := dreame
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cf.User == "" {
		dreameReply(w, 200, map[string]any{"configured": false, "items": []any{}})
		return
	}
	if c.hist != nil && time.Since(c.histAt) < 2*time.Minute {
		dreameReply(w, 200, map[string]any{"configured": true, "items": c.hist})
		return
	}
	if err := c.ensureDevice(); err != nil {
		dreameReply(w, 200, map[string]any{"configured": true, "error": err.Error(), "items": []any{}})
		return
	}
	first := 1687019188
	if c.status != nil {
		if t, ok := c.status["totals"].(map[string]any); ok {
			if f := num(t["first"]); f > 0 {
				first = f
			}
		}
	}
	resp, err := c.call("dreame-user-iot/iotstatus/history", map[string]any{
		"uid": c.uid, "did": c.did, "from": first, "limit": 50, "siid": "4", "region": c.cf.Country, "type": 3, "eiid": "1",
	}, false)
	if err != nil {
		dreameReply(w, 200, map[string]any{"configured": true, "error": err.Error(), "items": []any{}})
		return
	}
	data, _ := resp["data"].(map[string]any)
	list, _ := data["list"].([]any)
	items := []map[string]any{}
	seen := map[int]bool{}
	for _, x := range list {
		m, _ := x.(map[string]any)
		raw, _ := m["history"].(string)
		if raw == "" {
			raw, _ = m["value"].(string)
		}
		var kv []map[string]any
		if json.Unmarshal([]byte(raw), &kv) != nil {
			continue
		}
		it := map[string]any{}
		for _, e := range kv {
			val := e["value"]
			if val == nil {
				val = e["val"]
			}
			switch num(e["piid"]) {
			case 8:
				it["t"] = num(val)
			case 2:
				it["min"] = num(val)
			case 3:
				it["area"] = num(val)
			case 4:
				it["suction"] = num(val)
			case 13:
				it["done"] = num(val) == 1
			}
		}
		t, _ := it["t"].(int)
		if t == 0 || seen[t] {
			continue
		}
		seen[t] = true
		items = append(items, it)
	}
	sort.Slice(items, func(i, j int) bool { return items[i]["t"].(int) > items[j]["t"].(int) })
	if len(items) > 30 {
		items = items[:30]
	}
	c.hist, c.histAt = items, time.Now()
	dreameReply(w, 200, map[string]any{"configured": true, "items": items})
}
