// Облако Tuya через приложение Smart Life — тот же официальный вход, что у Home Assistant
// (tuya-device-sharing-sdk): QR-код в приложении, без кабинета разработчика и без его платной квоты.
// Используется для списка устройств, состояния Bluetooth-ламп, команд им и флажка Маруси.
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const slClientID = "HA_3y9q4ak7g4ephrvke"

type smartLife struct {
	file string
	mu   sync.Mutex
	auth struct {
		UserCode     string `json:"user_code"`
		TerminalID   string `json:"terminal_id"`
		Endpoint     string `json:"endpoint"`
		T            int64  `json:"t"`
		ExpireTime   int64  `json:"expire_time"`
		UID          string `json:"uid"`
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		Username     string `json:"username,omitempty"`
	}
	homes   []string
	listAt  time.Time
	list    []any
	httpc   *http.Client
}

// loadSmartLife читает сохранённый вход (файл создаётся при входе по QR-коду).
func loadSmartLife(file string) *smartLife {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	sl := &smartLife{file: file, httpc: &http.Client{Timeout: 20 * time.Second}}
	if json.Unmarshal(b, &sl.auth) != nil || sl.auth.RefreshToken == "" || sl.auth.Endpoint == "" {
		return nil
	}
	log.Printf("smart life: вход %s", sl.auth.Username)
	return sl
}

func (sl *smartLife) save() {
	b, _ := json.Marshal(&sl.auth)
	if os.WriteFile(sl.file+".tmp", b, 0o600) == nil {
		os.Rename(sl.file+".tmp", sl.file)
	}
}

func slNonce(n int) string {
	const t = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
	b := make([]byte, n)
	for i := range b {
		k, _ := rand.Int(rand.Reader, big.NewInt(int64(len(t))))
		b[i] = t[k.Int64()]
	}
	return string(b)
}

func slUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func slEncrypt(plain []byte, secret string) (string, error) {
	blk, err := aes.NewCipher([]byte(secret))
	if err != nil {
		return "", err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return "", err
	}
	nonce := slNonce(12)
	ct := g.Seal(nil, []byte(nonce), plain, nil)
	return base64.StdEncoding.EncodeToString([]byte(nonce)) + base64.StdEncoding.EncodeToString(ct), nil
}

func slDecrypt(data string, secret string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil || len(raw) < 13 {
		return nil, errors.New("smart life: ответ не расшифровать")
	}
	blk, err := aes.NewCipher([]byte(secret))
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	return g.Open(nil, raw[:12], raw[12:], nil)
}

func slHmacHex(key, msg string) string {
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(msg))
	return hex.EncodeToString(m.Sum(nil))
}

// request — запрос к API Smart Life: параметры и тело шифруются AES-GCM, подпись HMAC-SHA256.
func (sl *smartLife) request(method, path string, params, body map[string]any, refreshing bool) (map[string]any, error) {
	if !refreshing {
		sl.refreshIfNeeded()
	}
	sl.mu.Lock()
	access, refresh, endpoint := sl.auth.AccessToken, sl.auth.RefreshToken, sl.auth.Endpoint
	sl.mu.Unlock()
	rid := slUUID()
	hk := md5.Sum([]byte(rid + refresh))
	hashKey := hex.EncodeToString(hk[:])
	secret := slHmacHex(rid, hashKey)[:16]

	q, qEnc := url.Values{}, ""
	if len(params) > 0 {
		j, _ := json.Marshal(params)
		e, err := slEncrypt(j, secret)
		if err != nil {
			return nil, err
		}
		qEnc = e
		q.Set("encdata", e)
	}
	var rb io.Reader
	bEnc := ""
	if len(body) > 0 {
		j, _ := json.Marshal(body)
		e, err := slEncrypt(j, secret)
		if err != nil {
			return nil, err
		}
		bEnc = e
		jb, _ := json.Marshal(map[string]string{"encdata": e})
		rb = bytes.NewReader(jb)
	}
	t := fmt.Sprint(time.Now().UnixMilli())
	hdr := [][2]string{{"X-appKey", slClientID}, {"X-requestId", rid}, {"X-sid", ""}, {"X-time", t}, {"X-token", access}}
	var sb strings.Builder
	for _, h := range hdr {
		if h[1] != "" {
			sb.WriteString(h[0] + "=" + h[1] + "||")
		}
	}
	sign := strings.TrimSuffix(sb.String(), "||") + qEnc + bEnc
	u := endpoint + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequest(method, u, rb)
	if err != nil {
		return nil, err
	}
	for _, h := range hdr {
		req.Header.Set(h[0], h[1])
	}
	req.Header.Set("X-sign", slHmacHex(hashKey, sign))
	if rb != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := sl.httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("smart life: %s", resp.Status)
	}
	if ok, _ := out["success"].(bool); !ok {
		return out, fmt.Errorf("smart life: %v", out["msg"])
	}
	if enc, isStr := out["result"].(string); isStr && enc != "" {
		if plain, err := slDecrypt(enc, secret); err == nil {
			var v any
			if json.Unmarshal(plain, &v) == nil {
				out["result"] = v
			} else {
				out["result"] = string(plain)
			}
		}
	}
	return out, nil
}

func (sl *smartLife) refreshIfNeeded() {
	sl.mu.Lock()
	exp, rt := sl.auth.T+sl.auth.ExpireTime*1000, sl.auth.RefreshToken
	sl.mu.Unlock()
	if exp-60_000 > time.Now().UnixMilli() {
		return
	}
	out, err := sl.request("GET", "/v1.0/m/token/"+rt, nil, nil, true)
	if err != nil {
		log.Printf("smart life: обновление входа: %v", err)
		return
	}
	res, _ := out["result"].(map[string]any)
	if res == nil {
		return
	}
	sl.mu.Lock()
	sl.auth.T = int64(toFloat(out["t"]))
	sl.auth.ExpireTime = int64(toFloat(res["expireTime"]))
	if s, _ := res["accessToken"].(string); s != "" {
		sl.auth.AccessToken = s
	}
	if s, _ := res["refreshToken"].(string); s != "" {
		sl.auth.RefreshToken = s
	}
	sl.save()
	sl.mu.Unlock()
}

// devices — все устройства всех домов (как список облака: id, name, local_key, node_id, category, status…).
// Кэш maxAge, чтобы не дёргать облако на каждое обновление панели.
func (sl *smartLife) devices(maxAge time.Duration) ([]any, error) {
	sl.mu.Lock()
	if time.Since(sl.listAt) < maxAge && sl.list != nil {
		l := sl.list
		sl.mu.Unlock()
		return l, nil
	}
	homes := sl.homes
	sl.mu.Unlock()
	if len(homes) == 0 {
		out, err := sl.request("GET", "/v1.0/m/life/users/homes", nil, nil, false)
		if err != nil {
			return nil, err
		}
		arr, _ := out["result"].([]any)
		for _, h := range arr {
			if hm, ok := h.(map[string]any); ok {
				homes = append(homes, fmt.Sprint(int64(toFloat(hm["ownerId"]))))
			}
		}
	}
	var list []any
	for _, h := range homes {
		out, err := sl.request("GET", "/v1.0/m/life/ha/home/devices", map[string]any{"homeId": h}, nil, false)
		if err != nil {
			return nil, err
		}
		arr, _ := out["result"].([]any)
		for _, d := range arr {
			if dm, ok := d.(map[string]any); ok {
				dm["owner_id"] = h
				list = append(list, dm)
			}
		}
	}
	sl.mu.Lock()
	sl.homes, sl.list, sl.listAt = homes, list, time.Now()
	sl.mu.Unlock()
	return list, nil
}

// status — текущее состояние одного устройства (для флажка Маруси).
func (sl *smartLife) status(id string) (map[string]any, error) {
	out, err := sl.request("GET", "/v1.0/m/life/ha/devices/detail", map[string]any{"devIds": id}, nil, false)
	if err != nil {
		return nil, err
	}
	arr, _ := out["result"].([]any)
	st := map[string]any{}
	for _, d := range arr {
		dm, _ := d.(map[string]any)
		ss, _ := dm["status"].([]any)
		for _, s := range ss {
			if sm, ok := s.(map[string]any); ok {
				st[fmt.Sprint(sm["code"])] = sm["value"]
			}
		}
	}
	return st, nil
}

func (sl *smartLife) command(id string, cmds []deviceState) error {
	list := make([]map[string]any, 0, len(cmds))
	for _, c := range cmds {
		list = append(list, map[string]any{"code": c.Code, "value": c.Value})
	}
	_, err := sl.request("POST", "/v1.1/m/thing/"+id+"/commands", nil, map[string]any{"commands": list}, false)
	sl.mu.Lock()
	sl.listAt = time.Time{} // следующее обновление панели — свежий список
	sl.mu.Unlock()
	return err
}

// statusOf берёт состояние из элемента списка Smart Life.
func slStatusOf(dm map[string]any) []deviceState {
	ss, _ := dm["status"].([]any)
	var st []deviceState
	for _, s := range ss {
		if sm, ok := s.(map[string]any); ok {
			st = append(st, deviceState{Code: fmt.Sprint(sm["code"]), Value: sm["value"]})
		}
	}
	return st
}

// pcFlagLoop — флажок Маруси (виртуальная розетка): пишем его в /tmp/pc-flag для pc-remote,
// а команды pc-remote (/tmp/pc-flag-set) отправляем в облако. Квоту кабинета разработчика не тратит.
func (p *homePortal) pcFlagLoop() {
	if p.sl == nil || p.tuya == nil || p.tuya.device == "" {
		return
	}
	code := "switch_1"
	for {
		if b, err := os.ReadFile("/tmp/pc-flag-set"); err == nil {
			os.Remove("/tmp/pc-flag-set")
			v := strings.TrimSpace(string(b)) == "true"
			if err := p.sl.command(p.tuya.device, []deviceState{{Code: code, Value: v}}); err != nil {
				log.Printf("smart life: флажок ПК: %v", err)
			}
		}
		if st, err := p.sl.status(p.tuya.device); err == nil {
			if v, ok := st[code].(bool); ok {
				os.WriteFile("/tmp/pc-flag.tmp", []byte(fmt.Sprint(v)), 0o644)
				os.Rename("/tmp/pc-flag.tmp", "/tmp/pc-flag")
			}
		}
		time.Sleep(8 * time.Second)
	}
}
