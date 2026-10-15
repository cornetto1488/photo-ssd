package main

// ZALET Setup — утилита настройки нового компьютера (cmd/zalet). Роутер раздаёт её двумя способами:
//   /dl/zalet.exe, /dl/zalet-linux, /dl/zalet-linux-arm64      — без настроек, для команды в терминале;
//   /api/home/setup/download?os=windows|linux|linux-arm64      — из панели, с вшитыми адресом и ключом.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
)

var setupFiles = map[string][2]string{
	"windows":     {"portal/agent/zalet.exe", "ZALET-Setup.exe"},
	"linux":       {"portal/agent/zalet-linux", "zalet"},
	"linux-arm64": {"portal/agent/zalet-linux-arm64", "zalet"},
}

func setupPayload(osName string, cfg []byte) ([]byte, string, error) {
	f, ok := setupFiles[osName]
	if !ok {
		f = setupFiles["windows"]
	}
	b, err := portalFS.ReadFile(f[0])
	if err != nil {
		return nil, "", err
	}
	if cfg == nil {
		return b, f[1], nil
	}
	out := append(append(append([]byte{}, b...), []byte("\nZALETCFG")...), cfg...)
	return out, f[1], nil
}

func (p *homePortal) setupConfig() []byte {
	b, _ := json.Marshal(map[string]any{"router": "http://192.168.1.1", "token": p.s.token})
	return b
}

func sendBinary(w http.ResponseWriter, b []byte, name string) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Content-Length", fmt.Sprint(len(b)))
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}

// GET /api/home/setup/download?os=… — с вшитыми адресом роутера и ключом (файл — как пароль, не пересылать).
func (p *homePortal) handleSetupDownload(w http.ResponseWriter, r *http.Request) {
	osName := r.URL.Query().Get("os")
	b, name, err := setupPayload(osName, p.setupConfig())
	if err != nil {
		fail(w, http.StatusNotFound, "утилита для этой системы не собрана")
		return
	}
	log.Printf("панель: скачан ZALET Setup %s (%s)", osName, clientIP(r))
	sendBinary(w, b, name)
}

// GET /dl/<файл> — чистая утилита без ключа (ключ спросит сама: PIN панели или токен).
func handleSetupPublic(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/dl/")
	osName := map[string]string{"zalet.exe": "windows", "zalet-linux": "linux", "zalet-linux-arm64": "linux-arm64"}[name]
	if osName == "" {
		http.NotFound(w, r)
		return
	}
	b, _, err := setupPayload(osName, nil)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	file := name
	if osName != "windows" {
		file = "zalet"
	}
	sendBinary(w, b, file)
}
