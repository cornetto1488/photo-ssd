package main

import (
	_ "embed"
	"encoding/base64"
	"os"
	"os/exec"
	"sync"
	"time"
)

// Окно сообщения в фирменном стиле (WPF через PowerShell): поверх всех окон, без кражи фокуса,
// закрывается кликом или само. Текст передаётся через переменную окружения (без проблем с кавычками).
//
//go:embed toast.ps1
var toastScript string

var (
	toastMu   sync.Mutex
	toastProc *exec.Cmd
	toastGen  int
)

func showToast(text string) {
	toastMu.Lock()
	toastGen++
	gen := toastGen
	if toastProc != nil && toastProc.Process != nil {
		toastProc.Process.Kill() // новое сообщение заменяет предыдущее
	}
	toastMu.Unlock()

	f, err := os.CreateTemp("", "zalet-toast-*.ps1")
	if err != nil {
		msgBox(text, "ZALET HOME", 0x40|0x40000|0x10000)
		return
	}
	f.Write([]byte{0xEF, 0xBB, 0xBF}) // BOM: иначе Windows PowerShell читает кириллицу как ANSI
	f.WriteString(toastScript)
	f.Close()
	defer os.Remove(f.Name())

	cmd := hidden("powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", f.Name())
	cmd.Env = append(os.Environ(), "ZALET_MSG="+base64.StdEncoding.EncodeToString([]byte(text)))
	toastMu.Lock()
	toastProc = cmd
	toastMu.Unlock()
	start := time.Now()
	err = cmd.Run()
	toastMu.Lock()
	replaced := gen != toastGen
	toastMu.Unlock()
	if err != nil && !replaced && time.Since(start) < 6*time.Second {
		logf("окно сообщения: %v — показываю обычное", err)
		msgBox(text, "ZALET HOME", 0x40|0x40000|0x10000)
	}
}
