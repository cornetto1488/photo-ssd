//go:build windows

// ZALET Agent — один файл для ПК: голосовое выключение (как прежний PC-Remote) и состояние ПК для панели.
//
//	zalet-agent.exe          — установка (двойной клик) или окно состояния, если уже установлен
//	zalet-agent.exe system   — фоновая часть от имени системы: выключение, сон, таймеры, состояние
//	zalet-agent.exe user     — часть в сеансе пользователя: скриншот, блокировка, сообщения, громкость
//	zalet-agent.exe uninstall
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const version = "2.0"

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	powrprof = syscall.NewLazyDLL("powrprof.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	advapi32 = syscall.NewLazyDLL("advapi32.dll")
	ntdll    = syscall.NewLazyDLL("ntdll.dll")

	pMessageBox      = user32.NewProc("MessageBoxW")
	pLockWorkStation = user32.NewProc("LockWorkStation")
	pGetDC           = user32.NewProc("GetDC")
	pReleaseDC       = user32.NewProc("ReleaseDC")
	pGetSysMetrics   = user32.NewProc("GetSystemMetrics")
	pSetDPIAware     = user32.NewProc("SetProcessDPIAware")
	pGetForeground   = user32.NewProc("GetForegroundWindow")
	pGetWindowText   = user32.NewProc("GetWindowTextW")
	pGetLastInput    = user32.NewProc("GetLastInputInfo")
	pKeybdEvent      = user32.NewProc("keybd_event")
	pCreateCompatDC  = gdi32.NewProc("CreateCompatibleDC")
	pCreateCompatBmp = gdi32.NewProc("CreateCompatibleBitmap")
	pSelectObject    = gdi32.NewProc("SelectObject")
	pBitBlt          = gdi32.NewProc("BitBlt")
	pGetDIBits       = gdi32.NewProc("GetDIBits")
	pDeleteObject    = gdi32.NewProc("DeleteObject")
	pDeleteDC        = gdi32.NewProc("DeleteDC")
	pGetSystemTimes  = kernel32.NewProc("GetSystemTimes")
	pGlobalMemStatus = kernel32.NewProc("GlobalMemoryStatusEx")
	pGetTickCount64  = kernel32.NewProc("GetTickCount64")
	pGetLogicalDrvs  = kernel32.NewProc("GetLogicalDrives")
	pGetDriveType    = kernel32.NewProc("GetDriveTypeW")
	pGetDiskFree     = kernel32.NewProc("GetDiskFreeSpaceExW")
	pGetVolumeInfo   = kernel32.NewProc("GetVolumeInformationW")
	pCreateMutex     = kernel32.NewProc("CreateMutexW")
	pSetSuspendState = powrprof.NewProc("SetSuspendState")
	pPowerRegSuspend = powrprof.NewProc("PowerRegisterSuspendResumeNotification")
	pIsUserAnAdmin   = shell32.NewProc("IsUserAnAdmin")
	pShellExecute    = shell32.NewProc("ShellExecuteW")
	pRegOpenKeyEx    = advapi32.NewProc("RegOpenKeyExW")
	pRegQueryValueEx = advapi32.NewProc("RegQueryValueExW")
	pRegCloseKey     = advapi32.NewProc("RegCloseKey")
	pRtlGetVersion   = ntdll.NewProc("RtlGetVersion")
)

type config struct {
	Router string `json:"router"`
	Key    string `json:"key"`
	Voice  bool   `json:"voice"` // главный ПК: выключение голосом через Марусю
}

var (
	cfg    config
	client = &http.Client{Timeout: 10 * time.Second}
	logMu  sync.Mutex
)

const installDir = `C:\ProgramData\ZALET`

func u16(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

func msgBox(text, title string, flags uintptr) int {
	r, _, _ := pMessageBox.Call(0, uintptr(unsafe.Pointer(u16(text))), uintptr(unsafe.Pointer(u16(title))), flags)
	return int(r)
}

func logf(format string, a ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	f, err := os.OpenFile(filepath.Join(installDir, "agent.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	if st, _ := f.Stat(); st != nil && st.Size() > 1<<20 {
		f.Truncate(0)
	}
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, a...))
}

// Настройки вшиты в конец exe при скачивании с сайта: "\nZALETCFG" + JSON.
func loadConfig() {
	self, _ := os.Executable()
	if b, err := os.ReadFile(self); err == nil {
		if i := bytes.LastIndex(b, []byte("\nZALETCFG")); i >= 0 {
			json.Unmarshal(bytes.TrimSpace(b[i+9:]), &cfg)
		}
	}
	if cfg.Router == "" {
		if b, err := os.ReadFile(filepath.Join(filepath.Dir(self), "config.json")); err == nil {
			json.Unmarshal(b, &cfg)
		}
	}
	if cfg.Router == "" {
		cfg.Router = "http://192.168.1.1"
	}
	cfg.Router = strings.TrimRight(cfg.Router, "/")
}

func single(name string) bool {
	pCreateMutex.Call(0, 0, uintptr(unsafe.Pointer(u16(name))))
	return syscall.GetLastError() != syscall.ERROR_ALREADY_EXISTS
}

func hidden(name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return c
}

func main() {
	loadConfig()
	mode := ""
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	switch mode {
	case "system":
		if single(`Global\ZALETAgentSystem`) {
			runSystem()
		}
	case "user":
		if single(`Local\ZALETAgentUser`) {
			pSetDPIAware.Call()
			runUser()
		}
	case "uninstall":
		uninstall(true)
	case "install":
		install()
	default:
		self, _ := os.Executable()
		if strings.EqualFold(filepath.Dir(self), installDir) {
			if msgBox("ZALET Agent работает.\n\nПК виден в панели ZALET HOME (вкладка «ПК»), голосовое выключение через Марусю работает.\n\nУдалить агент с компьютера?", "ZALET Agent "+version, 0x4|0x40) == 6 {
				elevate("uninstall")
			}
			return
		}
		elevate("install")
	}
}

func isAdmin() bool { r, _, _ := pIsUserAnAdmin.Call(); return r != 0 }

// elevate перезапускает себя с правами администратора (окно UAC).
func elevate(arg string) {
	if isAdmin() {
		if arg == "install" {
			install()
		} else {
			uninstall(true)
		}
		return
	}
	self, _ := os.Executable()
	pShellExecute.Call(0, uintptr(unsafe.Pointer(u16("runas"))), uintptr(unsafe.Pointer(u16(self))), uintptr(unsafe.Pointer(u16(arg))), 0, 1)
}

func ps(script string) error {
	return hidden("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script).Run()
}

func stopOld() {
	// прежний PC-Remote (poll.ps1) и прежние копии агента
	ps(`Unregister-ScheduledTask -TaskName 'PC-Remote' -Confirm:$false -ErrorAction SilentlyContinue;` +
		`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*poll.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`)
	hidden("schtasks", "/end", "/tn", "ZALET Agent").Run()
	hidden("schtasks", "/end", "/tn", "ZALET Agent (экран)").Run()
	hidden("taskkill", "/f", "/im", "zalet-agent.exe", "/fi", fmt.Sprintf("PID ne %d", os.Getpid())).Run()
}

func install() {
	self, _ := os.Executable()
	dst := filepath.Join(installDir, "zalet-agent.exe")
	stopOld()
	time.Sleep(800 * time.Millisecond)
	os.MkdirAll(installDir, 0o755)
	b, err := os.ReadFile(self)
	if err == nil {
		err = os.WriteFile(dst+".new", b, 0o755)
	}
	if err == nil {
		os.Remove(dst)
		err = os.Rename(dst+".new", dst)
	}
	if err != nil {
		msgBox("Не удалось установить: "+err.Error(), "ZALET Agent", 0x10)
		return
	}
	q := strings.ReplaceAll(dst, "'", "''")
	script := `$ErrorActionPreference='Stop';` +
		// фоновая часть: от имени системы, с загрузки Windows (работает и до входа в систему)
		`$a=New-ScheduledTaskAction -Execute '` + q + `' -Argument 'system';` +
		`$t=New-ScheduledTaskTrigger -AtStartup;` +
		`$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable;` +
		`$p=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;` +
		`Register-ScheduledTask -TaskName 'ZALET Agent' -Action $a -Trigger $t -Settings $s -Principal $p -Description 'ZALET HOME: выключение голосом и состояние ПК' -Force | Out-Null;` +
		// часть в сеансе: при входе любого пользователя
		`$a2=New-ScheduledTaskAction -Execute '` + q + `' -Argument 'user';` +
		`$t2=New-ScheduledTaskTrigger -AtLogOn;` +
		`$p2=New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited;` +
		`Register-ScheduledTask -TaskName 'ZALET Agent (экран)' -Action $a2 -Trigger $t2 -Settings $s -Principal $p2 -Description 'ZALET HOME: скриншот, блокировка, сообщения' -Force | Out-Null;` +
		`Start-ScheduledTask -TaskName 'ZALET Agent'; Start-ScheduledTask -TaskName 'ZALET Agent (экран)'`
	if err := ps(script); err != nil {
		msgBox("Файл скопирован, но не удалось создать задания Windows: "+err.Error(), "ZALET Agent", 0x10)
		return
	}
	logf("установлен %s, роутер %s", version, cfg.Router)
	voice := ""
	if cfg.Voice {
		voice = "• Маруся по-прежнему выключает ПК, в том числе из сна.\n"
	}
	msgBox("Готово! ZALET Agent установлен и запущен.\n\n"+voice+"• В панели ZALET HOME на вкладке «ПК» появится состояние компьютера, скриншот и таймеры.\n\nПрежний PC-Remote заменён.", "ZALET Agent "+version, 0x40)
}

func uninstall(ask bool) {
	stopOld()
	hidden("schtasks", "/delete", "/tn", "ZALET Agent", "/f").Run()
	hidden("schtasks", "/delete", "/tn", "ZALET Agent (экран)", "/f").Run()
	// exe нельзя удалить, пока он запущен — удалим после выхода
	hidden("cmd", "/c", "ping -n 3 127.0.0.1 >nul & del /f /q \""+filepath.Join(installDir, "zalet-agent.exe")+"\"").Start()
	if ask {
		msgBox("ZALET Agent удалён.\nГолосовое выключение ПК через Марусю работать не будет, пока агент не установлен снова.", "ZALET Agent", 0x40)
	}
}

// ---------- обмен с роутером ----------

type command struct {
	ID      string `json:"id"`
	Action  string `json:"action"`
	Minutes int    `json:"minutes"`
	Mode    string `json:"mode"`
	Text    string `json:"text"`
}

func report(role string, stats map[string]any) []command {
	body, _ := json.Marshal(stats)
	req, _ := http.NewRequest("POST", cfg.Router+"/pcagent/report?role="+role, bytes.NewReader(body))
	req.Header.Set("X-Agent-Key", cfg.Key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var r struct {
		Commands []command `json:"commands"`
	}
	json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&r)
	return r.Commands
}

func getQuick(url string) string {
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	return strings.TrimSpace(string(b))
}

// ---------- фоновая часть (SYSTEM) ----------

// voiceCmd — голосовая команда Маруси; её слушает только главный ПК.
func voiceCmd() string {
	if !cfg.Voice {
		return ""
	}
	return getQuick(cfg.Router + "/pc/cmd")
}

var (
	timerMu   sync.Mutex
	timerMode string
	timerAt   time.Time
)

func suspend(hibernate bool) {
	h := uintptr(0)
	if hibernate {
		h = 1
	}
	pSetSuspendState.Call(h, 0, 0)
}

func runSystem() {
	logf("фоновая часть запущена %s", version)
	registerPower()
	cpu := newCPU()
	for {
		// 1) голосовая команда выключения (как прежний PC-Remote): "shutdown <unix>" не старше 60 с
		if parts := strings.Fields(voiceCmd()); len(parts) >= 2 && parts[0] == "shutdown" {
			if t, err := strconv.ParseInt(parts[1], 10, 64); err == nil {
				if age := time.Now().Unix() - t; age >= 0 && age <= 60 {
					logf("голосовое выключение")
					hidden("shutdown", "/s", "/t", "5", "/c", "Shutdown by voice command").Run()
					time.Sleep(30 * time.Second)
				}
			}
		}
		// 2) состояние для панели и команды
		for _, c := range report("system", systemStats(cpu)) {
			runSystemCmd(c)
		}
		// 3) таймер
		timerMu.Lock()
		mode, at := timerMode, timerAt
		timerMu.Unlock()
		if mode != "" && time.Now().After(at) {
			timerMu.Lock()
			timerMode = ""
			timerMu.Unlock()
			logf("таймер: %s", mode)
			if mode == "sleep" {
				suspend(false)
			} else {
				hidden("shutdown", "/s", "/t", "30", "/c", "ZALET HOME: выключение по таймеру").Run()
			}
		}
		time.Sleep(3 * time.Second)
	}
}

func runSystemCmd(c command) {
	logf("команда %s %d", c.Action, c.Minutes)
	switch c.Action {
	case "sleep":
		go func() { time.Sleep(time.Second); suspend(false) }()
	case "hibernate":
		go func() { time.Sleep(time.Second); suspend(true) }()
	case "shutdown":
		hidden("shutdown", "/s", "/t", "10", "/c", "ZALET HOME: выключение из панели").Run()
	case "restart":
		hidden("shutdown", "/r", "/t", "10", "/c", "ZALET HOME: перезагрузка из панели").Run()
	case "cancel":
		hidden("shutdown", "/a").Run()
		timerMu.Lock()
		timerMode = ""
		timerMu.Unlock()
	case "timer":
		if c.Minutes > 0 {
			timerMu.Lock()
			timerMode = "shutdown"
			if c.Mode == "sleep" {
				timerMode = "sleep"
			}
			timerAt = time.Now().Add(time.Duration(c.Minutes) * time.Minute)
			timerMu.Unlock()
		}
	}
}

// Сон и пробуждение: сообщаем роутеру, чтобы «выключи» во сне будило и выключало ПК.
var powerCB = syscall.NewCallback(func(ctx, typ, setting uintptr) uintptr {
	switch typ {
	case 4: // PBT_APMSUSPEND
		if cfg.Voice {
			getQuick(cfg.Router + "/cgi-bin/pc-state?s=sleep")
		}
		logf("уход в сон")
	case 7, 18: // PBT_APMRESUMESUSPEND / PBT_APMRESUMEAUTOMATIC
		if cfg.Voice {
			go func() { time.Sleep(5 * time.Second); getQuick(cfg.Router + "/cgi-bin/pc-state?s=awake"); logf("пробуждение") }()
		}
	}
	return 0
})

type notifyParams struct{ callback, context uintptr }

var powerParams notifyParams
var powerHandle uintptr

func registerPower() {
	powerParams = notifyParams{callback: powerCB}
	pPowerRegSuspend.Call(2, uintptr(unsafe.Pointer(&powerParams)), uintptr(unsafe.Pointer(&powerHandle)))
}

// ---------- состояние ----------

type cpuMeter struct{ idle, total uint64 }

func filetime(f [2]uint32) uint64 { return uint64(f[1])<<32 | uint64(f[0]) }

func newCPU() *cpuMeter { m := &cpuMeter{}; m.sample(); return m }

func (m *cpuMeter) sample() float64 {
	var idle, kern, usr [2]uint32
	pGetSystemTimes.Call(uintptr(unsafe.Pointer(&idle)), uintptr(unsafe.Pointer(&kern)), uintptr(unsafe.Pointer(&usr)))
	i, t := filetime(idle), filetime(kern)+filetime(usr)
	di, dt := i-m.idle, t-m.total
	m.idle, m.total = i, t
	if dt == 0 {
		return 0
	}
	v := 100 * (1 - float64(di)/float64(dt))
	if v < 0 {
		v = 0
	}
	return float64(int(v*10)) / 10
}

type memStatus struct {
	length, load                       uint32
	total, avail, pageT, pageA, vT, vA uint64
	extA                               uint64
}

func regString(path, name string) string {
	var h syscall.Handle
	if r, _, _ := pRegOpenKeyEx.Call(uintptr(0x80000002), uintptr(unsafe.Pointer(u16(path))), 0, 0x20019, uintptr(unsafe.Pointer(&h))); r != 0 {
		return ""
	}
	defer pRegCloseKey.Call(uintptr(h))
	buf := make([]uint16, 256)
	n := uint32(len(buf) * 2)
	if r, _, _ := pRegQueryValueEx.Call(uintptr(h), uintptr(unsafe.Pointer(u16(name))), 0, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); r != 0 {
		return ""
	}
	return strings.TrimSpace(syscall.UTF16ToString(buf))
}

func osName() string {
	type osv struct {
		size, major, minor, build, platform uint32
		csd                                 [128]uint16
	}
	v := osv{size: uint32(unsafe.Sizeof(osv{}))}
	pRtlGetVersion.Call(uintptr(unsafe.Pointer(&v)))
	name := "Windows 10"
	if v.build >= 22000 {
		name = "Windows 11"
	}
	if ed := regString(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "DisplayVersion"); ed != "" {
		name += " " + ed
	}
	return fmt.Sprintf("%s (сборка %d)", name, v.build)
}

var (
	staticOnce sync.Once
	cpuName    string
	osTitle    string
	nvsmi      string
)

func systemStats(cpu *cpuMeter) map[string]any {
	staticOnce.Do(func() {
		cpuName = regString(`HARDWARE\DESCRIPTION\System\CentralProcessor\0`, "ProcessorNameString")
		osTitle = osName()
		for _, p := range []string{os.Getenv("ProgramFiles") + `\NVIDIA Corporation\NVSMI\nvidia-smi.exe`, os.Getenv("SystemRoot") + `\System32\nvidia-smi.exe`} {
			if _, err := os.Stat(p); err == nil {
				nvsmi = p
			}
		}
	})
	ms := memStatus{length: uint32(unsafe.Sizeof(memStatus{}))}
	pGlobalMemStatus.Call(uintptr(unsafe.Pointer(&ms)))
	up, _, _ := pGetTickCount64.Call()
	host, _ := os.Hostname()
	res := map[string]any{
		"host": host, "os": osTitle, "cpuName": cpuName, "cpu": cpu.sample(),
		"ramTotal": ms.total, "ramUsed": ms.total - ms.avail, "ramPct": ms.load,
		"uptime": uint64(up) / 1000, "disks": disks(), "version": version,
	}
	if nvsmi != "" {
		if out, err := hidden(nvsmi, "--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw", "--format=csv,noheader,nounits").Output(); err == nil {
			f := strings.Split(strings.Split(strings.TrimSpace(string(out)), "\n")[0], ",")
			if len(f) >= 6 {
				num := func(s string) float64 { v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64); return v }
				res["gpuName"] = strings.TrimSpace(f[0])
				res["gpuTemp"] = num(f[1])
				res["gpu"] = map[string]any{"load": num(f[2]), "memUsed": num(f[3]) * 1048576, "memTotal": num(f[4]) * 1048576, "power": num(f[5])}
			}
		}
	}
	timerMu.Lock()
	if timerMode != "" {
		res["timer"] = map[string]any{"mode": timerMode, "at": timerAt.Unix()}
	}
	timerMu.Unlock()
	return res
}

func disks() []map[string]any {
	var out []map[string]any
	mask, _, _ := pGetLogicalDrvs.Call()
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		if t, _, _ := pGetDriveType.Call(uintptr(unsafe.Pointer(u16(root)))); t != 3 {
			continue
		}
		var free, total, tfree uint64
		pGetDiskFree.Call(uintptr(unsafe.Pointer(u16(root))), uintptr(unsafe.Pointer(&free)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&tfree)))
		label := make([]uint16, 64)
		pGetVolumeInfo.Call(uintptr(unsafe.Pointer(u16(root))), uintptr(unsafe.Pointer(&label[0])), 64, 0, 0, 0, 0, 0)
		out = append(out, map[string]any{"name": root[:2], "size": total, "free": free, "label": syscall.UTF16ToString(label)})
	}
	return out
}

// ---------- часть в сеансе пользователя ----------

func runUser() {
	logf("часть в сеансе запущена (%s)", os.Getenv("USERNAME"))
	for {
		host, _ := os.Hostname()
		st := map[string]any{"host": host, "user": os.Getenv("USERNAME"), "window": foregroundTitle(), "idle": idleSeconds()}
		for _, c := range report("user", st) {
			runUserCmd(c)
		}
		time.Sleep(3 * time.Second)
	}
}

func runUserCmd(c command) {
	switch c.Action {
	case "shot":
		if b, err := screenshot(); err == nil {
			host, _ := os.Hostname()
			req, _ := http.NewRequest("POST", cfg.Router+"/pcagent/shot?host="+url.QueryEscape(host), bytes.NewReader(b))
			req.Header.Set("X-Agent-Key", cfg.Key)
			req.Header.Set("Content-Type", "image/jpeg")
			if resp, err := client.Do(req); err == nil {
				resp.Body.Close()
			}
		} else {
			logf("скриншот: %v", err)
		}
	case "lock":
		pLockWorkStation.Call()
	case "message":
		go msgBox(c.Text, "ZALET HOME", 0x40|0x40000) // MB_ICONINFORMATION | MB_TOPMOST
	case "mute":
		key(0xAD)
	case "volume":
		vk := byte(0xAF)
		n := c.Minutes
		if n < 0 {
			vk, n = 0xAE, -n
		}
		for i := 0; i < n && i < 25; i++ {
			key(vk)
		}
	}
}

func key(vk byte) {
	pKeybdEvent.Call(uintptr(vk), 0, 0, 0)
	pKeybdEvent.Call(uintptr(vk), 0, 2, 0)
}

func foregroundTitle() string {
	h, _, _ := pGetForeground.Call()
	buf := make([]uint16, 256)
	pGetWindowText.Call(h, uintptr(unsafe.Pointer(&buf[0])), 256)
	return syscall.UTF16ToString(buf)
}

func idleSeconds() uint32 {
	type lii struct{ size, time uint32 }
	l := lii{size: 8}
	pGetLastInput.Call(uintptr(unsafe.Pointer(&l)))
	now, _, _ := pGetTickCount64.Call()
	return (uint32(now) - l.time) / 1000
}

func screenshot() ([]byte, error) {
	sm := func(i int) int { r, _, _ := pGetSysMetrics.Call(uintptr(i)); return int(int32(r)) }
	x, y, w, h := sm(76), sm(77), sm(78), sm(79)
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("нет экрана")
	}
	screen, _, _ := pGetDC.Call(0)
	defer pReleaseDC.Call(0, screen)
	mem, _, _ := pCreateCompatDC.Call(screen)
	defer pDeleteDC.Call(mem)
	bmp, _, _ := pCreateCompatBmp.Call(screen, uintptr(w), uintptr(h))
	defer pDeleteObject.Call(bmp)
	pSelectObject.Call(mem, bmp)
	pBitBlt.Call(mem, 0, 0, uintptr(w), uintptr(h), screen, uintptr(x), uintptr(y), 0x00CC0020|0x40000000)
	type bmi struct {
		size                  uint32
		width, height         int32
		planes, bits          uint16
		compression, sizeImg  uint32
		xppm, yppm, used, imp int32
		colors                [4]byte
	}
	info := bmi{size: 40, width: int32(w), height: -int32(h), planes: 1, bits: 32}
	buf := make([]byte, w*h*4)
	if r, _, _ := pGetDIBits.Call(mem, bmp, 0, uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&info)), 0); r == 0 {
		return nil, fmt.Errorf("GetDIBits")
	}
	// уменьшаем до 1600 пикселей по ширине
	ow := w
	if ow > 1600 {
		ow = 1600
	}
	oh := h * ow / w
	img := image.NewRGBA(image.Rect(0, 0, ow, oh))
	for yy := 0; yy < oh; yy++ {
		sy := yy * h / oh
		for xx := 0; xx < ow; xx++ {
			sx := xx * w / ow
			si := (sy*w + sx) * 4
			di := img.PixOffset(xx, yy)
			img.Pix[di], img.Pix[di+1], img.Pix[di+2], img.Pix[di+3] = buf[si+2], buf[si+1], buf[si], 255
		}
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: 72}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
