// ZALET Setup — одна программа для нового компьютера (Windows и Linux): подключение к роутеру ZALET HOME,
// проверка Tailscale, сетевой диск, обои, кнопки папок, агент ПК, тема оформления, ярлык панели.
//
//	zalet          — окно настройки (открывается в браузере, доступно только с этого компьютера)
//	zalet -cli     — то же самое в терминале (для Linux без рабочего стола)
//
// Настройки хранятся в профиле пользователя: Windows — %APPDATA%\zalet\config.json, Linux — ~/.config/zalet/config.json.
// Если программу скачать из панели роутера, адрес и ключ уже вшиты в файл — вводить ничего не нужно.
package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const version = "1.0"

//go:embed ui.html
var uiHTML []byte

//go:embed all:assets
var assets embed.FS

// ---------- настройки ----------

type Config struct {
	Router string `json:"router"`
	Token  string `json:"token"`
}

var (
	cfgMu sync.Mutex
	cfg   Config
)

func cfgPath() string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = "."
	}
	return filepath.Join(d, "zalet", "config.json")
}

func loadConfig() {
	if b, err := os.ReadFile(cfgPath()); err == nil {
		json.Unmarshal(b, &cfg)
	}
	if cfg.Token == "" {
		// настройки, вшитые при скачивании из панели роутера (хвост файла после метки ZALETCFG)
		if exe, err := os.Executable(); err == nil {
			if b, err := os.ReadFile(exe); err == nil {
				if i := bytes.LastIndex(b, []byte("\nZALETCFG")); i >= 0 {
					var e Config
					if json.Unmarshal(b[i+9:], &e) == nil && e.Token != "" {
						cfg = e
					}
				}
			}
		}
	}
	if cfg.Router == "" {
		cfg.Router = "http://192.168.1.1"
	}
}

func saveConfig(c Config) error {
	p := cfgPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(p, b, 0o600)
}

func current() Config {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	return cfg
}

// ---------- журнал ----------

var (
	logMu   sync.Mutex
	logBuf  []string
	cliMode bool
)

func logf(format string, a ...any) {
	s := fmt.Sprintf(format, a...)
	logMu.Lock()
	logBuf = append(logBuf, s)
	logMu.Unlock()
	if cliMode {
		fmt.Println(s)
	}
}

// ---------- роутер ----------

var hc = &http.Client{Timeout: 15 * time.Second}

func normRouter(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	return strings.TrimRight(s, "/")
}

func routerHost(base string) string {
	u, err := url.Parse(base)
	if err != nil || u.Hostname() == "" {
		return "192.168.1.1"
	}
	return u.Hostname()
}

func reachable(base string) bool {
	if base == "" {
		return false
	}
	c := &http.Client{Timeout: 3 * time.Second}
	r, err := c.Get(base + "/api/home/pin-info")
	if err != nil {
		return false
	}
	r.Body.Close()
	return r.StatusCode < 500
}

func tokenOK(base, tok string) bool {
	if base == "" || tok == "" {
		return false
	}
	req, _ := http.NewRequest("GET", base+"/api/home/status", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	c := &http.Client{Timeout: 6 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

var pinRe = regexp.MustCompile(`^\d{4,8}$`)

// loginPIN входит по PIN панели и получает постоянный ключ роутера; сессию PIN сразу закрывает.
func loginPIN(base, pin string) (string, error) {
	b, _ := json.Marshal(map[string]string{"pin": pin})
	resp, err := hc.Post(base+"/api/home/login", "application/json", bytes.NewReader(b))
	if err != nil {
		return "", errors.New("роутер не отвечает")
	}
	defer resp.Body.Close()
	var r struct {
		Error  string `json:"error"`
		Locked int    `json:"locked"`
	}
	json.NewDecoder(resp.Body).Decode(&r)
	if resp.StatusCode != http.StatusOK {
		if r.Locked > 0 {
			return "", fmt.Errorf("слишком много попыток, подождите %d с", r.Locked)
		}
		if r.Error != "" {
			return "", errors.New(r.Error)
		}
		return "", fmt.Errorf("вход не удался (HTTP %d)", resp.StatusCode)
	}
	sess := ""
	for _, c := range resp.Cookies() {
		if c.Name == "zh" {
			sess = c.Value
		}
	}
	if sess == "" {
		return "", errors.New("роутер не выдал сессию")
	}
	req, _ := http.NewRequest("GET", base+"/api/home/token", nil)
	req.AddCookie(&http.Cookie{Name: "zh", Value: sess})
	resp2, err := hc.Do(req)
	if err != nil {
		return "", errors.New("роутер не отвечает")
	}
	defer resp2.Body.Close()
	var t struct {
		Token string `json:"token"`
	}
	json.NewDecoder(resp2.Body).Decode(&t)
	out, _ := http.NewRequest("POST", base+"/api/home/logout", nil)
	out.AddCookie(&http.Cookie{Name: "zh", Value: sess})
	if r3, err := hc.Do(out); err == nil {
		r3.Body.Close()
	}
	if t.Token == "" {
		return "", errors.New("роутер не выдал ключ")
	}
	return t.Token, nil
}

// autoRouter: сначала домашняя сеть, потом роутер в Tailscale.
func autoRouter() string {
	if reachable("http://192.168.1.1") {
		return "http://192.168.1.1"
	}
	if ts := tailscaleState(); ts.RouterIP != "" && reachable("http://"+ts.RouterIP) {
		return "http://" + ts.RouterIP
	}
	return ""
}

func connect(router, secret string) error {
	base := normRouter(router)
	if base == "" {
		base = autoRouter()
		if base == "" {
			return errors.New("роутер не найден: ни в домашней сети (192.168.1.1), ни через Tailscale")
		}
	}
	if !reachable(base) {
		return fmt.Errorf("роутер не отвечает по адресу %s", base)
	}
	secret = strings.TrimSpace(secret)
	tok := secret
	if secret == "" {
		tok = current().Token
	}
	if pinRe.MatchString(secret) {
		t, err := loginPIN(base, secret)
		if err != nil {
			return err
		}
		tok = t
	}
	if !tokenOK(base, tok) {
		return errors.New("ключ не подошёл — проверьте PIN или токен (панель → Роутер → Токен)")
	}
	cfgMu.Lock()
	cfg.Router, cfg.Token = base, tok
	c := cfg
	cfgMu.Unlock()
	if err := saveConfig(c); err != nil {
		return err
	}
	logf("✓ Подключено к роутеру %s", base)
	return nil
}

// download скачивает файл с роутера по ключу.
func download(c Config, path, dst string) error {
	req, _ := http.NewRequest("GET", c.Router+path, nil)
	req.Header.Set("Authorization", "Bearer "+c.Token)
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("роутер не отвечает")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("роутер ответил HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// ---------- Tailscale ----------

type TSState struct {
	Installed    bool   `json:"installed"`
	Running      bool   `json:"running"`
	State        string `json:"state"`
	Self         string `json:"self"`
	RouterIP     string `json:"routerIP"`
	RouterOnline bool   `json:"routerOnline"`
}

func tailscaleBin() string {
	if p, err := exec.LookPath("tailscale"); err == nil {
		return p
	}
	for _, p := range tailscalePaths() {
		if fileExists(p) {
			return p
		}
	}
	return ""
}

func tailscaleState() TSState {
	var s TSState
	bin := tailscaleBin()
	if bin == "" {
		return s
	}
	s.Installed = true
	out, _ := command(bin, "status", "--json").Output()
	var j struct {
		BackendState string
		Self         struct{ TailscaleIPs []string }
		Peer         map[string]struct {
			HostName     string
			DNSName      string
			TailscaleIPs []string
			Online       bool
		}
	}
	if json.Unmarshal(out, &j) != nil {
		s.State = "служба не запущена"
		return s
	}
	s.State = j.BackendState
	s.Running = j.BackendState == "Running"
	if len(j.Self.TailscaleIPs) > 0 {
		s.Self = j.Self.TailscaleIPs[0]
	}
	for _, p := range j.Peer {
		if strings.EqualFold(p.HostName, "router") || strings.HasPrefix(strings.ToLower(p.DNSName), "router.") {
			for _, ip := range p.TailscaleIPs {
				if !strings.Contains(ip, ":") {
					s.RouterIP = ip
				}
			}
			s.RouterOnline = p.Online
		}
	}
	return s
}

// ---------- компоненты и задания ----------

type Comp struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Desc      string `json:"desc"`
	Supported bool   `json:"supported"`
	Installed bool   `json:"installed"`
	Detail    string `json:"detail"`
	CanUndo   bool   `json:"canUndo"`
	InAll     bool   `json:"inAll"`
	NeedsKey  bool   `json:"needsKey"`
}

var (
	busyMu sync.Mutex
	busy   string
)

func startJob(id string, undo bool) error {
	busyMu.Lock()
	if busy != "" {
		busyMu.Unlock()
		return errors.New("подождите, идёт: " + busy)
	}
	busy = id
	busyMu.Unlock()
	go func() {
		defer func() {
			busyMu.Lock()
			busy = ""
			busyMu.Unlock()
		}()
		doJob(id, undo)
	}()
	return nil
}

func doJob(id string, undo bool) {
	defer func() {
		if r := recover(); r != nil {
			logf("✗ сбой: %v", r)
		}
	}()
	c := current()
	switch id {
	case "tailscale":
		logf("— Tailscale")
		if err := installTailscale(); err != nil {
			logf("✗ Tailscale: %v", err)
		}
	case "all":
		connected := tokenOK(c.Router, c.Token)
		for _, cp := range platformComponents(c) {
			if !cp.Supported || !cp.InAll || cp.Installed {
				continue
			}
			if cp.NeedsKey && !connected {
				logf("— %s: пропуск — сначала подключитесь к роутеру", cp.Title)
				continue
			}
			runOne(cp, false, c)
		}
		logf("Готово. Проверьте список — всё отмеченное установлено.")
	default:
		for _, cp := range platformComponents(c) {
			if cp.ID == id {
				runOne(cp, undo, c)
				return
			}
		}
		logf("✗ неизвестное действие: %s", id)
	}
}

func runOne(cp Comp, undo bool, c Config) {
	if !cp.Supported {
		logf("— %s: недоступно на этой системе", cp.Title)
		return
	}
	if undo {
		logf("— %s: отмена", cp.Title)
		if err := undoAction(cp.ID, c); err != nil {
			logf("✗ %s: %v", cp.Title, err)
			return
		}
		logf("✓ %s — отменено", cp.Title)
		return
	}
	logf("— %s", cp.Title)
	if cp.NeedsKey && !tokenOK(c.Router, c.Token) {
		logf("✗ %s: сначала подключитесь к роутеру", cp.Title)
		return
	}
	if err := runAction(cp.ID, c); err != nil {
		logf("✗ %s: %v", cp.Title, err)
		return
	}
	logf("✓ %s — готово", cp.Title)
}

// ---------- общее ----------

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func portOpen(port int) bool {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 400*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// extract раскладывает встроенные файлы assets/<sub> в папку dst.
func extract(sub, dst string) error {
	root := "assets/" + sub
	return fs.WalkDir(assets, root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(p, root), "/")
		target := filepath.Join(dst, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := assets.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
}

// icoPNG достаёт самый крупный кадр PNG из .ico (для ярлыков Linux).
func icoPNG(b []byte) []byte {
	if len(b) < 6 {
		return nil
	}
	n := int(b[4]) | int(b[5])<<8
	for i := 0; i < n && 6+16*i+16 <= len(b); i++ {
		e := b[6+16*i:]
		size := int(e[8]) | int(e[9])<<8 | int(e[10])<<16 | int(e[11])<<24
		off := int(e[12]) | int(e[13])<<8 | int(e[14])<<16 | int(e[15])<<24
		if off+size <= len(b) && size > 8 && bytes.HasPrefix(b[off:], []byte("\x89PNG")) {
			return b[off : off+size]
		}
	}
	return nil
}

// streamCmd выполняет команду и построчно пишет её вывод в журнал.
func streamCmd(cmd *exec.Cmd) error {
	r, w := io.Pipe()
	cmd.Stdout, cmd.Stderr = w, w
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			if t := strings.TrimSpace(sc.Text()); t != "" {
				logf("  %s", t)
			}
		}
		close(done)
	}()
	err := cmd.Wait()
	w.Close()
	<-done
	return err
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func stateJSON() map[string]any {
	c := current()
	reach := reachable(c.Router)
	busyMu.Lock()
	b := busy
	busyMu.Unlock()
	host, _ := os.Hostname()
	return map[string]any{
		"version": version, "os": runtime.GOOS, "host": host, "router": c.Router, "hasKey": c.Token != "",
		"reachable": reach, "connected": reach && tokenOK(c.Router, c.Token), "tailscale": tailscaleState(),
		"components": platformComponents(c), "busy": b,
	}
}

// ---------- окно настройки (локальная страница в браузере) ----------

func runUI() {
	key := randHex(16)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Println("Не удалось открыть окно настройки:", err)
		runCLI()
		return
	}
	origin := "http://" + ln.Addr().String()
	var hitMu sync.Mutex
	lastHit := time.Now()
	authed := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			ck, err := r.Cookie("zk")
			if err != nil || ck.Value != key {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if o := r.Header.Get("Origin"); o != "" && o != origin {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if r.URL.Path != "/api/state" && r.URL.Path != "/api/log" && r.Method != http.MethodPost {
				http.Error(w, "POST only", http.StatusMethodNotAllowed)
				return
			}
			hitMu.Lock()
			lastHit = time.Now()
			hitMu.Unlock()
			h(w, r)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("k") == key {
			http.SetCookie(w, &http.Cookie{Name: "zk", Value: key, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		if ck, err := r.Cookie("zk"); err != nil || ck.Value != key {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, "Откройте ссылку из окна программы ZALET Setup.")
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(uiHTML)
	})
	mux.HandleFunc("/api/state", authed(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, stateJSON()) }))
	mux.HandleFunc("/api/log", authed(func(w http.ResponseWriter, r *http.Request) {
		since, _ := strconv.Atoi(r.URL.Query().Get("since"))
		logMu.Lock()
		var lines []string
		if since >= 0 && since < len(logBuf) {
			lines = append(lines, logBuf[since:]...)
		}
		n := len(logBuf)
		logMu.Unlock()
		busyMu.Lock()
		b := busy
		busyMu.Unlock()
		writeJSON(w, map[string]any{"lines": lines, "next": n, "busy": b})
	}))
	mux.HandleFunc("/api/connect", authed(func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Router, Secret string }
		json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&q)
		if err := connect(q.Router, q.Secret); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}))
	mux.HandleFunc("/api/run", authed(func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			ID   string
			Undo bool
		}
		json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&q)
		if err := startJob(q.ID, q.Undo); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}))
	mux.HandleFunc("/api/forget", authed(func(w http.ResponseWriter, r *http.Request) {
		cfgMu.Lock()
		cfg.Token = ""
		c := cfg
		cfgMu.Unlock()
		saveConfig(c)
		logf("Ключ забыт на этом компьютере")
		writeJSON(w, map[string]any{"ok": true})
	}))
	mux.HandleFunc("/api/open", authed(func(w http.ResponseWriter, r *http.Request) {
		openBrowser(current().Router + "/")
		writeJSON(w, map[string]any{"ok": true})
	}))
	mux.HandleFunc("/api/quit", authed(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		go func() { time.Sleep(300 * time.Millisecond); os.Exit(0) }()
	}))
	u := origin + "/?k=" + key
	fmt.Println("ZALET Setup " + version)
	fmt.Println("Окно настройки открывается в браузере. Если не открылось — откройте адрес:")
	fmt.Println("  " + u)
	fmt.Println("Не закрывайте это окно, пока идёт настройка. Режим без окна: zalet -cli")
	openBrowser(u)
	go func() { // окно браузера закрыто давно — выходим
		for range time.Tick(time.Minute) {
			hitMu.Lock()
			idle := time.Since(lastHit)
			hitMu.Unlock()
			busyMu.Lock()
			b := busy
			busyMu.Unlock()
			if idle > 30*time.Minute && b == "" {
				os.Exit(0)
			}
		}
	}()
	http.Serve(ln, mux)
}

// ---------- режим терминала ----------

func runCLI() {
	cliMode = true
	in := bufio.NewReader(os.Stdin)
	read := func(prompt string) string {
		fmt.Print(prompt)
		s, _ := in.ReadString('\n')
		return strings.TrimSpace(s)
	}
	printTS := func(ts TSState) {
		switch {
		case !ts.Installed:
			fmt.Println("Tailscale: не установлен (нужен, чтобы подключаться к дому не из дома)")
		case !ts.Running:
			fmt.Println("Tailscale: установлен, но не подключён — войдите в аккаунт")
		case ts.RouterIP != "":
			on := "в сети"
			if !ts.RouterOnline {
				on = "не в сети"
			}
			fmt.Printf("Tailscale: подключён (%s), роутер %s — %s\n", ts.Self, ts.RouterIP, on)
		default:
			fmt.Printf("Tailscale: подключён (%s), роутер в вашей сети Tailscale не найден\n", ts.Self)
		}
	}
	fmt.Printf("ZALET Setup %s — %s\n\n", version, runtime.GOOS)
	for {
		c := current()
		if reachable(c.Router) && tokenOK(c.Router, c.Token) {
			fmt.Println("✓ Роутер:", c.Router)
			break
		}
		printTS(tailscaleState())
		r := read("Адрес роутера [Enter — найти самому]: ")
		s := read("PIN панели или ключ (токен): ")
		if err := connect(r, s); err != nil {
			fmt.Println("✗", err)
			if a := strings.ToLower(read("Повторить? [Д/н]: ")); a == "н" || a == "n" {
				break
			}
		}
	}
	for {
		c := current()
		fmt.Println()
		printTS(tailscaleState())
		comps := platformComponents(c)
		fmt.Println("\nЧто сделать:")
		for i, cp := range comps {
			mark := "[ ]"
			if cp.Installed {
				mark = "[✓]"
			}
			if !cp.Supported {
				mark = "[—]"
			}
			fmt.Printf("  %d. %s %s — %s\n", i+1, mark, cp.Title, cp.Detail)
		}
		fmt.Println("  a — установить всё   t — Tailscale   u<номер> — отменить (например u3)   q — выход")
		ch := strings.ToLower(read("> "))
		switch {
		case ch == "q" || ch == "й" || ch == "":
			return
		case ch == "a" || ch == "ф":
			doJob("all", false)
		case ch == "t" || ch == "е":
			doJob("tailscale", false)
		case strings.HasPrefix(ch, "u"):
			if n, err := strconv.Atoi(ch[1:]); err == nil && n >= 1 && n <= len(comps) {
				runOne(comps[n-1], true, c)
			}
		default:
			if n, err := strconv.Atoi(ch); err == nil && n >= 1 && n <= len(comps) {
				runOne(comps[n-1], false, c)
			}
		}
	}
}

func main() {
	cli := flag.Bool("cli", false, "работа в терминале, без окна")
	flag.Parse()
	loadConfig()
	headless := runtime.GOOS == "linux" && os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == ""
	if *cli || headless {
		runCLI()
		return
	}
	runUI()
}
