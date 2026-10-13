// Флешка ZALET HOME в один клик: сайт собирает архив со всем нужным (скрипты для Windows/Linux/Mac,
// установщики Tailscale с SSD, ключ подключения, агент ПК) и программу, которая записывает флешку.
package main

import (
	"archive/zip"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	usbKeyFile = "/etc/zalet-usb.key"
	usbPkgDir  = "/mnt/ssd/.router/usb" // установщики Tailscale (большие — не встраиваем в программу)
)

func (p *homePortal) handleUSB(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var req struct{ Key string }
		json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req)
		k := strings.TrimSpace(req.Key)
		if !strings.HasPrefix(k, "tskey-") {
			fail(w, http.StatusBadRequest, "ключ Tailscale начинается с tskey-")
			return
		}
		if err := os.WriteFile(usbKeyFile, []byte(k+"\n"), 0o600); err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		log.Printf("панель: ключ для флешек обновлён (%s)", clientIP(r))
	}
	key := strings.TrimSpace(readFile(usbKeyFile))
	pkgs := []map[string]any{}
	ents, _ := os.ReadDir(usbPkgDir)
	for _, e := range ents {
		if info, err := e.Info(); err == nil && !e.IsDir() {
			pkgs = append(pkgs, map[string]any{"name": e.Name(), "size": info.Size()})
		}
	}
	kind := ""
	switch {
	case strings.HasPrefix(key, "tskey-client-"):
		kind = "постоянный (OAuth)"
	case key != "":
		kind = "обычный (до 90 дней)"
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": key != "", "keyKind": kind, "keyTail": tail(key, 6), "packages": pkgs})
}

func tail(s string, n int) string {
	if len(s) <= n {
		return ""
	}
	return s[len(s)-n:]
}

// GET /api/home/usb/kit.zip — архив «Сделать флешку ZALET».
func (p *homePortal) handleUSBKit(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(readFile(usbKeyFile))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="ZALET-flashka.zip"`)
	z := zip.NewWriter(w)
	defer z.Close()
	add := func(name string, mode os.FileMode, src io.Reader) {
		h := &zip.FileHeader{Name: name, Modified: time.Now(), Method: zip.Store}
		if strings.HasSuffix(name, ".ps1") || strings.HasSuffix(name, ".txt") || strings.HasSuffix(name, ".cmd") || strings.HasSuffix(name, ".sh") || strings.HasSuffix(name, ".command") {
			h.Method = zip.Deflate
		}
		h.SetMode(mode)
		f, err := z.CreateHeader(h)
		if err == nil {
			io.Copy(f, src)
		}
	}
	// скрипты из панели
	fs.WalkDir(portalFS, "portal/usb", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := filepath.Base(path)
		b, _ := portalFS.ReadFile(path)
		mode := os.FileMode(0o644)
		if strings.HasSuffix(name, ".sh") || strings.HasSuffix(name, ".command") {
			mode = 0o755
		}
		dst := "флешка/" + name
		switch name {
		case "make-flash.ps1":
			dst = ".maker/make-flash.ps1"
		case "Сделать флешку ZALET.cmd":
			dst = name
		case "start.ps1", "stop.ps1", "zalet.ico":
			dst = "флешка/.zalet/" + name
		}
		add(dst, mode, strings.NewReader(string(b)))
		return nil
	})
	add("флешка/.zalet/key.txt", 0o600, strings.NewReader(key))
	// установщики Tailscale с SSD
	ents, _ := os.ReadDir(usbPkgDir)
	for _, e := range ents {
		if f, err := os.Open(filepath.Join(usbPkgDir, e.Name())); err == nil {
			add("флешка/.zalet/"+e.Name(), 0o644, f)
			f.Close()
		}
	}
	// агент ПК (без голосового выключения — это для главного ПК)
	cfg, _ := json.Marshal(map[string]any{"router": "http://192.168.1.1", "key": agent.loadKey(), "voice": false})
	for _, a := range [][3]string{{"portal/agent/zalet-agent.exe", "ZALET-Agent.exe", "644"}, {"portal/agent/zalet-agent-linux", "zalet-agent", "755"}} {
		if b, err := portalFS.ReadFile(a[0]); err == nil {
			mode := os.FileMode(0o644)
			if a[2] == "755" {
				mode = 0o755
			}
			add("флешка/ZALET Agent/"+a[1], mode, io.MultiReader(strings.NewReader(string(b)), strings.NewReader("\nZALETCFG"+string(cfg))))
		}
	}
	log.Printf("панель: скачан комплект флешки (%s)", clientIP(r))
}
