// Домофон «Модус»: открыть подъезд с сайта. Роутер повторяет запрос приложения «Модус» от аккаунта
// владельца (сессия из приложения хранится в /etc/zalet-modus.json, только для root).
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const modusFile = "/etc/zalet-modus.json"

type modusCfg struct {
	Cookie     string `json:"cookie"`     // сессия приложения
	Device     string `json:"device"`     // device_id домофона, напр. "194.186.196.248:25201"
	Name       string `json:"name"`       // как называть дверь на сайте
	AppDevice  string `json:"appDevice"`  // X-DeviceId телефона
	AppVersion string `json:"appVersion"` // X-AppVersion
	UA         string `json:"ua"`
}

var doorMu sync.Mutex
var doorLast time.Time

func loadModus() (modusCfg, bool) {
	var c modusCfg
	b, err := os.ReadFile(modusFile)
	if err != nil || json.Unmarshal(b, &c) != nil || c.Cookie == "" || c.Device == "" {
		return c, false
	}
	return c, true
}

func (p *homePortal) handleDoor(w http.ResponseWriter, r *http.Request) {
	c, ok := loadModus()
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusOK, map[string]any{"configured": ok, "name": c.Name})
		return
	}
	if !ok {
		fail(w, http.StatusBadRequest, "домофон не настроен")
		return
	}
	doorMu.Lock()
	if time.Since(doorLast) < 3*time.Second { // защита от двойного нажатия
		doorMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	doorLast = time.Now()
	doorMu.Unlock()

	body, _ := json.Marshal(map[string]string{"device_id": c.Device})
	req, _ := http.NewRequest("POST", "https://api.modus-omsk.ru/api/clients/controls/devices/domofon/open", bytes.NewReader(body))
	h := req.Header
	h.Set("Content-Type", "application/json")
	h.Set("Accept", "*/*")
	h.Set("Accept-Language", "ru-GB;q=1.0, en-GB;q=0.9")
	h.Set("X-Api-Version", "2")
	h.Set("X-AppVersion", firstNonEmpty(c.AppVersion, "3.1.3 (2)"))
	h.Set("X-OSInfo", "26.2")
	h.Set("X-DeviceInfo", "iPhone14,7")
	h.Set("X-DeviceId", c.AppDevice)
	h.Set("X-AppBuildDateTime", time.Now().Format("2006-01-02T15:04:05.000"))
	h.Set("User-Agent", firstNonEmpty(c.UA, "Modus-Intercom/3.1.3 (ru.modus.domophone; build:2; iOS 26.2.0) Alamofire/5.9.1"))
	h.Set("Cookie", c.Cookie)
	cl := &http.Client{Timeout: 10 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		fail(w, http.StatusBadGateway, "сервер «Модуса» не ответил")
		return
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	var out struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	json.Unmarshal(rb, &out)
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		log.Printf("домофон: сессия «Модуса» истекла (%d)", resp.StatusCode)
		fail(w, http.StatusUnauthorized, "сессия «Модуса» истекла — нужно заново подключить домофон")
		return
	}
	if resp.StatusCode != 200 || out.Code != 0 {
		msg := strings.TrimSpace(out.Message)
		if msg == "" {
			msg = fmt.Sprintf("ошибка %d", resp.StatusCode)
		}
		log.Printf("домофон: не открылся: %s", msg)
		fail(w, http.StatusBadGateway, "домофон не открылся: "+msg)
		return
	}
	log.Printf("домофон: подъезд открыт с сайта (%s)", clientIP(r))
	go p.event("system", "Открыт подъезд с сайта")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
