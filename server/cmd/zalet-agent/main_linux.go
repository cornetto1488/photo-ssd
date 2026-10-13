//go:build linux

// ZALET Agent для Linux — тот же агент, что и для Windows: состояние компьютера и команды из панели.
//
//	sudo ./zalet-agent          — установка (служба systemd + автозапуск в сеансе пользователя)
//	zalet-agent system           — фоновая часть (root): выключение, сон, таймеры, состояние
//	zalet-agent user             — часть в сеансе: скриншот, блокировка, сообщения, громкость
//	sudo zalet-agent uninstall
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
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
)

const (
	version    = "2.0"
	installDir = "/opt/zalet"
	unitFile   = "/etc/systemd/system/zalet-agent.service"
)

type config struct {
	Router string `json:"router"`
	Key    string `json:"key"`
	Voice  bool   `json:"voice"`
}

var (
	cfg    config
	client = &http.Client{Timeout: 10 * time.Second}
)

func loadConfig() {
	self, _ := os.Executable()
	if b, err := os.ReadFile(self); err == nil {
		if i := bytes.LastIndex(b, []byte("\nZALETCFG")); i >= 0 {
			json.Unmarshal(bytes.TrimSpace(b[i+9:]), &cfg)
		}
	}
	if cfg.Router == "" {
		cfg.Router = "http://192.168.1.1"
	}
	cfg.Router = strings.TrimRight(cfg.Router, "/")
}

func main() {
	loadConfig()
	mode := ""
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	switch mode {
	case "system":
		runSystem()
	case "user":
		runUser()
	case "uninstall":
		needRoot()
		uninstall()
	default:
		needRoot()
		install()
	}
}

func needRoot() {
	if os.Geteuid() == 0 {
		return
	}
	self, _ := os.Executable()
	args := append([]string{self}, os.Args[1:]...)
	for _, el := range []string{"sudo", "pkexec"} {
		if p, err := exec.LookPath(el); err == nil {
			c := exec.Command(p, args...)
			c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
			if c.Run() == nil {
				os.Exit(0)
			}
		}
	}
	fmt.Println("Нужны права администратора: запустите через sudo")
	os.Exit(1)
}

func realUser() (name, home string) {
	name = os.Getenv("SUDO_USER")
	if name == "" {
		name = os.Getenv("PKEXEC_UID")
		if name != "" {
			if out, err := exec.Command("id", "-nu", name).Output(); err == nil {
				name = strings.TrimSpace(string(out))
			}
		}
	}
	if name == "" || name == "root" {
		return "", ""
	}
	if out, err := exec.Command("getent", "passwd", name).Output(); err == nil {
		if f := strings.Split(strings.TrimSpace(string(out)), ":"); len(f) >= 6 {
			home = f[5]
		}
	}
	return
}

func install() {
	fmt.Println("\n  ZALET Agent " + version + " — установка")
	self, _ := os.Executable()
	b, err := os.ReadFile(self)
	if err != nil {
		fmt.Println("  ✕", err)
		os.Exit(1)
	}
	os.MkdirAll(installDir, 0o755)
	dst := filepath.Join(installDir, "zalet-agent")
	exec.Command("systemctl", "stop", "zalet-agent").Run()
	os.WriteFile(dst+".new", b, 0o755)
	os.Rename(dst+".new", dst)
	unit := "[Unit]\nDescription=ZALET HOME agent\nAfter=network-online.target\nWants=network-online.target\n\n" +
		"[Service]\nExecStart=" + dst + " system\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=multi-user.target\n"
	os.WriteFile(unitFile, []byte(unit), 0o644)
	exec.Command("systemctl", "daemon-reload").Run()
	if err := exec.Command("systemctl", "enable", "--now", "zalet-agent").Run(); err != nil {
		fmt.Println("  ! systemd недоступен — фоновая часть не запущена:", err)
	}
	if name, home := realUser(); home != "" {
		dir := filepath.Join(home, ".config", "autostart")
		os.MkdirAll(dir, 0o755)
		desk := "[Desktop Entry]\nType=Application\nName=ZALET Agent\nComment=ZALET HOME: скриншот, сообщения\nExec=" + dst + " user\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n"
		f := filepath.Join(dir, "zalet-agent.desktop")
		os.WriteFile(f, []byte(desk), 0o644)
		exec.Command("chown", "-R", name+":", filepath.Join(home, ".config", "autostart")).Run()
		// запустить сразу в сеансе пользователя
		if out, err := exec.Command("id", "-u", name).Output(); err == nil {
			uid := strings.TrimSpace(string(out))
			c := exec.Command("sudo", "-u", name, "env", "XDG_RUNTIME_DIR=/run/user/"+uid, "DISPLAY="+envOr("DISPLAY", ":0"), "WAYLAND_DISPLAY="+os.Getenv("WAYLAND_DISPLAY"), "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"+uid+"/bus", dst, "user")
			c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			c.Start()
		}
	}
	fmt.Println("  ✓ Установлено. Компьютер появится в панели ZALET HOME на вкладке «ПК».")
	fmt.Println("  Удалить: sudo " + dst + " uninstall\n")
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func uninstall() {
	exec.Command("systemctl", "disable", "--now", "zalet-agent").Run()
	os.Remove(unitFile)
	exec.Command("systemctl", "daemon-reload").Run()
	exec.Command("pkill", "-f", installDir+"/zalet-agent user").Run()
	if _, home := realUser(); home != "" {
		os.Remove(filepath.Join(home, ".config", "autostart", "zalet-agent.desktop"))
	}
	os.RemoveAll(installDir)
	fmt.Println("  ✓ ZALET Agent удалён")
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

func getQuick(u string) string {
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get(u)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	return strings.TrimSpace(string(b))
}

// ---------- фоновая часть (root) ----------

var (
	timerMu   sync.Mutex
	timerMode string
	timerAt   time.Time
)

func run(name string, args ...string) { exec.Command(name, args...).Run() }

func runSystem() {
	var prevIdle, prevTotal uint64
	cpuNow := func() float64 {
		idle, total := cpuTimes()
		di, dt := idle-prevIdle, total-prevTotal
		prevIdle, prevTotal = idle, total
		if dt == 0 {
			return 0
		}
		return float64(int(1000*(1-float64(di)/float64(dt)))) / 10
	}
	cpuNow()
	for {
		if cfg.Voice {
			if parts := strings.Fields(getQuick(cfg.Router + "/pc/cmd")); len(parts) >= 2 && parts[0] == "shutdown" {
				if t, err := strconv.ParseInt(parts[1], 10, 64); err == nil {
					if age := time.Now().Unix() - t; age >= 0 && age <= 60 {
						run("shutdown", "-h", "+0")
						time.Sleep(30 * time.Second)
					}
				}
			}
		}
		for _, c := range report("system", systemStats(cpuNow())) {
			switch c.Action {
			case "sleep":
				go func() { time.Sleep(time.Second); run("systemctl", "suspend") }()
			case "hibernate":
				go func() { time.Sleep(time.Second); run("systemctl", "hibernate") }()
			case "shutdown":
				go func() { time.Sleep(10 * time.Second); run("systemctl", "poweroff") }()
			case "restart":
				go func() { time.Sleep(10 * time.Second); run("systemctl", "reboot") }()
			case "cancel":
				run("shutdown", "-c")
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
		timerMu.Lock()
		mode, at := timerMode, timerAt
		if mode != "" && time.Now().After(at) {
			timerMode = ""
		}
		timerMu.Unlock()
		if mode != "" && time.Now().After(at) {
			if mode == "sleep" {
				run("systemctl", "suspend")
			} else {
				run("systemctl", "poweroff")
			}
		}
		time.Sleep(3 * time.Second)
	}
}

func cpuTimes() (idle, total uint64) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if sc.Scan() {
		fs := strings.Fields(sc.Text())
		for i, v := range fs[1:] {
			n, _ := strconv.ParseUint(v, 10, 64)
			total += n
			if i == 3 || i == 4 {
				idle += n
			}
		}
	}
	return
}

func readKV(path string) map[string]string {
	m := map[string]string{}
	b, _ := os.ReadFile(path)
	for _, l := range strings.Split(string(b), "\n") {
		if k, v, ok := strings.Cut(l, ":"); ok {
			m[strings.TrimSpace(k)] = strings.TrimSpace(v)
		} else if k, v, ok := strings.Cut(l, "="); ok {
			m[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"`)
		}
	}
	return m
}

func kb(s string) uint64 { n, _ := strconv.ParseUint(strings.Fields(s + " 0")[0], 10, 64); return n * 1024 }

var (
	once            sync.Once
	cpuName, osName string
)

func systemStats(cpu float64) map[string]any {
	once.Do(func() {
		cpuName = readKV("/proc/cpuinfo")["model name"]
		osName = readKV("/etc/os-release")["PRETTY_NAME"]
	})
	mem := readKV("/proc/meminfo")
	total, avail := kb(mem["MemTotal"]), kb(mem["MemAvailable"])
	upb, _ := os.ReadFile("/proc/uptime")
	up, _ := strconv.ParseFloat(strings.Fields(string(upb) + " 0")[0], 64)
	host, _ := os.Hostname()
	pct := 0.0
	if total > 0 {
		pct = float64(int(1000*float64(total-avail)/float64(total))) / 10
	}
	res := map[string]any{"host": host, "os": osName, "cpuName": cpuName, "cpu": cpu, "ramTotal": total, "ramUsed": total - avail,
		"ramPct": pct, "uptime": uint64(up), "disks": disks(), "version": version + " linux"}
	if t := cpuTemp(); t > 0 {
		res["cpuTemp"] = t
	}
	if out, err := exec.Command("nvidia-smi", "--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw", "--format=csv,noheader,nounits").Output(); err == nil {
		f := strings.Split(strings.Split(strings.TrimSpace(string(out)), "\n")[0], ",")
		if len(f) >= 6 {
			num := func(s string) float64 { v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64); return v }
			res["gpuName"], res["gpuTemp"] = strings.TrimSpace(f[0]), num(f[1])
			res["gpu"] = map[string]any{"load": num(f[2]), "memUsed": num(f[3]) * 1048576, "memTotal": num(f[4]) * 1048576, "power": num(f[5])}
		}
	}
	timerMu.Lock()
	if timerMode != "" {
		res["timer"] = map[string]any{"mode": timerMode, "at": timerAt.Unix()}
	}
	timerMu.Unlock()
	return res
}

func cpuTemp() float64 {
	best := 0.0
	files, _ := filepath.Glob("/sys/class/hwmon/hwmon*/temp*_input")
	for _, f := range files {
		name, _ := os.ReadFile(filepath.Join(filepath.Dir(f), "name"))
		n := strings.TrimSpace(string(name))
		if n != "coretemp" && n != "k10temp" && n != "zenpower" && n != "cpu_thermal" && n != "acpitz" {
			continue
		}
		b, _ := os.ReadFile(f)
		v, _ := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
		if v/1000 > best {
			best = v / 1000
		}
	}
	return best
}

func disks() []map[string]any {
	var out []map[string]any
	seen := map[string]bool{}
	b, _ := os.ReadFile("/proc/mounts")
	for _, l := range strings.Split(string(b), "\n") {
		f := strings.Fields(l)
		if len(f) < 3 || !strings.HasPrefix(f[0], "/dev/") || seen[f[0]] {
			continue
		}
		switch f[2] {
		case "ext4", "xfs", "btrfs", "ext3", "f2fs", "ntfs", "ntfs3", "exfat", "vfat":
		default:
			continue
		}
		if strings.HasPrefix(f[1], "/boot") || strings.HasPrefix(f[1], "/snap") {
			continue
		}
		var st syscall.Statfs_t
		if syscall.Statfs(f[1], &st) != nil || st.Blocks == 0 {
			continue
		}
		seen[f[0]] = true
		out = append(out, map[string]any{"name": f[1], "size": st.Blocks * uint64(st.Bsize), "free": st.Bavail * uint64(st.Bsize), "label": filepath.Base(f[0])})
	}
	return out
}

// ---------- часть в сеансе пользователя ----------

func runUser() {
	host, _ := os.Hostname()
	for {
		st := map[string]any{"host": host, "user": os.Getenv("USER"), "window": activeWindow()}
		for _, c := range report("user", st) {
			switch c.Action {
			case "shot":
				if b, err := screenshot(); err == nil {
					req, _ := http.NewRequest("POST", cfg.Router+"/pcagent/shot?host="+url.QueryEscape(host), bytes.NewReader(b))
					req.Header.Set("X-Agent-Key", cfg.Key)
					if resp, err := client.Do(req); err == nil {
						resp.Body.Close()
					}
				}
			case "lock":
				if exec.Command("loginctl", "lock-session").Run() != nil {
					run("xdg-screensaver", "lock")
				}
			case "message":
				if exec.Command("notify-send", "-u", "critical", "ZALET HOME", c.Text).Run() != nil {
					exec.Command("zenity", "--info", "--title=ZALET HOME", "--text="+c.Text).Start()
				}
			case "mute":
				run("pactl", "set-sink-mute", "@DEFAULT_SINK@", "toggle")
			case "volume":
				d := fmt.Sprintf("+%d%%", c.Minutes*2)
				if c.Minutes < 0 {
					d = fmt.Sprintf("-%d%%", -c.Minutes*2)
				}
				run("pactl", "set-sink-volume", "@DEFAULT_SINK@", d)
			}
		}
		time.Sleep(3 * time.Second)
	}
}

func activeWindow() string {
	out, err := exec.Command("xdotool", "getactivewindow", "getwindowname").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// screenshot — через то, что есть в системе (Wayland и X11), результат → JPEG.
func screenshot() ([]byte, error) {
	tmp := filepath.Join(os.TempDir(), fmt.Sprintf("zalet-shot-%d.png", os.Getpid()))
	defer os.Remove(tmp)
	tries := [][]string{
		{"grim", tmp}, {"gnome-screenshot", "-f", tmp}, {"spectacle", "-b", "-n", "-f", "-o", tmp},
		{"xfce4-screenshooter", "-f", "-s", tmp}, {"scrot", "-o", tmp}, {"maim", tmp}, {"import", "-window", "root", tmp},
	}
	for _, t := range tries {
		if _, err := exec.LookPath(t[0]); err != nil {
			continue
		}
		os.Remove(tmp)
		if exec.Command(t[0], t[1:]...).Run() == nil {
			if f, err := os.Open(tmp); err == nil {
				img, _, err := image.Decode(f)
				f.Close()
				if err == nil {
					var out bytes.Buffer
					jpeg.Encode(&out, img, &jpeg.Options{Quality: 72})
					return out.Bytes(), nil
				}
			}
		}
	}
	return nil, fmt.Errorf("нет программы для скриншота (grim, gnome-screenshot, scrot…)")
}
