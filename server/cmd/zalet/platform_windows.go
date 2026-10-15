//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const agentExe = `C:\ProgramData\ZALET\zalet-agent.exe`

// command запускает консольную программу без мигающего окна.
func command(name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return c
}

func tailscalePaths() []string {
	return []string{`C:\Program Files\Tailscale\tailscale.exe`, `C:\Program Files (x86)\Tailscale\tailscale.exe`}
}

func openBrowser(u string) { exec.Command("rundll32", "url.dll,FileProtocolHandler", u).Start() }

func localApp() string {
	if d := os.Getenv("LOCALAPPDATA"); d != "" {
		return d
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "AppData", "Local")
}

// knownFolder — путь к «Рабочему столу» и т.п. с учётом переноса в OneDrive.
func knownFolder(name string) string {
	out, err := command("powershell", "-NoProfile", "-Command",
		"[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('"+name+"')").Output()
	if p := strings.TrimSpace(string(out)); err == nil && p != "" {
		return p
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, name)
}

func regExists(key string) bool { return command("reg", "query", key).Run() == nil }

func regAdd(key, name, value string) error {
	args := []string{"add", key}
	if name == "" {
		args = append(args, "/ve")
	} else {
		args = append(args, "/v", name)
	}
	args = append(args, "/d", value, "/f")
	if out, err := command("reg", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("реестр %s: %v %s", key, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// runPS запускает скрипт PowerShell и пишет его вывод в журнал.
func runPS(script string, args ...string) error {
	q := "'" + strings.ReplaceAll(script, "'", "''") + "'"
	line := "[Console]::OutputEncoding=[Text.Encoding]::UTF8; & " + q
	for _, a := range args {
		line += " " + a
	}
	cmd := command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", line)
	cmd.Env = append(os.Environ(), "ZALET_NOPAUSE=1")
	return streamCmd(cmd)
}

func processRunning(image string) bool {
	out, _ := command("tasklist", "/FI", "IMAGENAME eq "+image, "/NH").Output()
	return strings.Contains(strings.ToLower(string(out)), strings.ToLower(image))
}

// ---------- Wallpaper Engine ----------

func weDir() string {
	var cands []string
	if out, err := command("reg", "query", `HKCU\Software\Valve\Steam`, "/v", "SteamPath").Output(); err == nil {
		if m := regexp.MustCompile(`SteamPath\s+REG_SZ\s+(.+)`).FindSubmatch(out); m != nil {
			steam := filepath.FromSlash(strings.TrimSpace(string(m[1])))
			cands = append(cands, steam)
			if b, err := os.ReadFile(filepath.Join(steam, "steamapps", "libraryfolders.vdf")); err == nil {
				for _, mm := range regexp.MustCompile(`"path"\s+"([^"]+)"`).FindAllSubmatch(b, -1) {
					cands = append(cands, strings.ReplaceAll(string(mm[1]), `\\`, `\`))
				}
			}
		}
	}
	cands = append(cands, `C:\Program Files (x86)\Steam`, `C:\Program Files\Steam`, `D:\Steam`, `D:\SteamLibrary`)
	for _, c := range cands {
		d := filepath.Join(c, "steamapps", "common", "wallpaper_engine")
		if fileExists(filepath.Join(d, "wallpaper64.exe")) {
			return d
		}
	}
	return ""
}

func weProject(we string) string {
	return filepath.Join(we, "projects", "myprojects", "ZALET-Kiosk")
}

// weDisableAutoColor выключает в Wallpaper Engine «подстройку цвета Windows под обои» — она перебивает тему.
func weDisableAutoColor() {
	we := weDir()
	if we == "" {
		return
	}
	p := filepath.Join(we, "config.json")
	b, err := os.ReadFile(p)
	if err != nil {
		return
	}
	re := regexp.MustCompile(`("adjustdwmcolormode"\s*:\s*)"([a-z]+)"`)
	m := re.FindSubmatch(b)
	if m == nil || string(m[2]) == "disabled" {
		return
	}
	running := processRunning("wallpaper64.exe")
	if running {
		command("taskkill", "/F", "/IM", "wallpaper64.exe").Run()
		command("taskkill", "/F", "/IM", "webwallpaper64.exe").Run()
		time.Sleep(3 * time.Second)
	}
	os.WriteFile(p+".bak-zalet", b, 0o644)
	os.WriteFile(p, re.ReplaceAll(b, []byte(`${1}"disabled"`)), 0o644)
	logf("  Wallpaper Engine больше не перекрашивает цвет Windows под обои")
	if running {
		exec.Command(filepath.Join(we, "wallpaper64.exe")).Start()
		time.Sleep(4 * time.Second)
	}
}

// ---------- компоненты ----------

func platformComponents(c Config) []Comp {
	host := routerHost(c.Router)
	share := `\\` + host + `\SSD`
	we := weDir()
	la := localApp()
	netuse, _ := command("net", "use").Output()
	comps := []Comp{
		{ID: "drive", Title: "Сетевой диск «Хранилище»", Desc: share + " — как диск в «Этом компьютере»", Supported: true, InAll: true, CanUndo: true,
			Installed: strings.Contains(strings.ToLower(string(netuse)), strings.ToLower(share))},
		{ID: "folders", Title: "Кнопки папок", Desc: "кнопки на обоях открывают папки и Хранилище в Проводнике", Supported: true, InAll: true, CanUndo: true,
			Installed: regExists(`HKCU\Software\Classes\zaletopen`) && portOpen(18765)},
		{ID: "wallpaper", Title: "Обои ZALET HOME", Desc: "панель дома прямо на рабочем столе (Wallpaper Engine)", Supported: we != "", InAll: true, NeedsKey: true,
			Installed: we != "" && fileExists(filepath.Join(weProject(we), "token.js"))},
		{ID: "agent", Title: "Агент ПК", Desc: "компьютер в панели: состояние, скриншот, сон и выключение, таймеры", Supported: true, InAll: true, CanUndo: true, NeedsKey: true,
			Installed: fileExists(agentExe)},
		{ID: "theme", Title: "Тема ZALET", Desc: "чёрный «Пуск» и панель задач, оранжевые акцент и выделение, свои иконки и курсоры", Supported: true, InAll: true, CanUndo: true,
			Installed: fileExists(filepath.Join(la, "ZALET", "theme", "zalet-theme-backup.json"))},
		{ID: "shortcut", Title: "Ярлык панели", Desc: "ZALET HOME на рабочем столе и в меню «Пуск»", Supported: true, InAll: true, CanUndo: true,
			Installed: fileExists(filepath.Join(knownFolder("Desktop"), "ZALET HOME.url"))},
		{ID: "windhawk", Title: "Глубокая кастомизация", Desc: "Windhawk: стиль меню «Пуск», панели задач, контекстного меню (ставится отдельно)", Supported: true,
			Installed: fileExists(`C:\Program Files\Windhawk\windhawk.exe`)},
	}
	for i := range comps {
		cp := &comps[i]
		switch {
		case !cp.Supported && cp.ID == "wallpaper":
			cp.Detail = "нужен Wallpaper Engine из Steam"
		case cp.Installed:
			cp.Detail = "установлено"
		default:
			cp.Detail = "не установлено"
		}
	}
	return comps
}

func runAction(id string, c Config) error {
	host := routerHost(c.Router)
	la := localApp()
	switch id {
	case "drive":
		share := `\\` + host + `\SSD`
		out, _ := command("net", "use").Output()
		if strings.Contains(strings.ToLower(string(out)), strings.ToLower(share)) {
			logf("  уже подключён")
			return nil
		}
		letter := ""
		for l := 'Z'; l >= 'M'; l-- {
			d := string(l) + ":"
			if !fileExists(d+`\`) && !strings.Contains(string(out), d) {
				letter = d
				break
			}
		}
		if letter == "" {
			return errors.New("нет свободной буквы диска")
		}
		if b, err := command("net", "use", letter, share, "/persistent:yes").CombinedOutput(); err != nil {
			return fmt.Errorf("не удалось подключить %s (роутер доступен? %v) %s", share, err, strings.TrimSpace(string(b)))
		}
		regAdd(`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\MountPoints2\##`+host+`#SSD`, "_LabelFromReg", "Хранилище")
		logf("  %s → диск %s «Хранилище»", share, letter)
	case "folders":
		dir := filepath.Join(la, "ZALET")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		if err := extract("tools", dir); err != nil {
			return err
		}
		os.WriteFile(filepath.Join(dir, "hosts.txt"), []byte(host+"\r\n"), 0o644)
		k := `HKCU\Software\Classes\zaletopen`
		for _, e := range []error{
			regAdd(k, "", "URL:ZALET Open"), regAdd(k, "URL Protocol", ""),
			regAdd(k+`\shell\open\command`, "", `wscript.exe "`+filepath.Join(dir, "open.vbs")+`" "%1"`),
			regAdd(`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "ZaletOpener", `wscript.exe "`+filepath.Join(dir, "listener.vbs")+`"`),
		} {
			if e != nil {
				return e
			}
		}
		// второй путь автозапуска — ярлык в «Автозагрузке» (на случай, если запись Run не сработает)
		lnk := `$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'ZALET Opener.lnk'));` +
			`$s.TargetPath=Join-Path $env:WINDIR 'System32\wscript.exe';$s.Arguments='"` + filepath.Join(dir, "listener.vbs") + `"';$s.WindowStyle=7;$s.Save()`
		command("powershell", "-NoProfile", "-Command", lnk).Run()
		if !portOpen(18765) {
			exec.Command("wscript.exe", filepath.Join(dir, "listener.vbs")).Start()
			time.Sleep(2 * time.Second)
		}
		if !portOpen(18765) {
			return errors.New("помощник папок не запустился")
		}
		logf("  помощник папок работает (только для этого компьютера, порт 18765)")
	case "wallpaper":
		we := weDir()
		if we == "" {
			return errors.New("Wallpaper Engine не найден — установите его в Steam и запустите один раз")
		}
		dst := weProject(we)
		if err := os.MkdirAll(dst, 0o755); err != nil {
			return err
		}
		if err := extract("wallpaper", dst); err != nil {
			return err
		}
		home, _ := os.UserHomeDir()
		folders := fmt.Sprintf(`Хранилище|\\%s\SSD;Фото|\\%s\SSD\Photos;Загрузки|%s;Документы|%s`, host, host,
			filepath.Join(home, "Downloads"), knownFolder("MyDocuments"))
		js := func(s string) string { b, _ := json.Marshal(s); return string(b) }
		tok := fmt.Sprintf("window.ZH_LOCAL_TOKEN = %s;\nwindow.ZH_LOCAL_HOME = %s;\nwindow.ZH_LOCAL_FOLDERS = %s;\n", js(c.Token), js(c.Router), js(folders))
		if err := os.WriteFile(filepath.Join(dst, "token.js"), []byte(tok), 0o600); err != nil {
			return err
		}
		weDisableAutoColor()
		if err := exec.Command(filepath.Join(we, "wallpaper64.exe"), "-control", "openWallpaper", "-file", filepath.Join(dst, "index.html"), "-monitor", "0").Start(); err != nil {
			return err
		}
		logf("  обои установлены: %s", dst)
		logf("  ярлыкам на рабочем столе отведена левая колонка (5 мест) — настраивается в свойствах обоев")
	case "agent":
		tmp := filepath.Join(os.TempDir(), "ZALET-Agent.exe")
		if err := download(c, "/api/home/pc/download?os=windows", tmp); err != nil {
			return err
		}
		if err := exec.Command(tmp).Start(); err != nil {
			return err
		}
		logf("  открылся установщик агента — подтвердите окно администратора")
	case "theme":
		dir := filepath.Join(la, "ZALET", "setup", "theme")
		if err := extract("theme", dir); err != nil {
			return err
		}
		weDisableAutoColor()
		logf("  Проводник перезапустится, экран моргнёт. Для иконки всех папок Windows спросит права администратора")
		return runPS(filepath.Join(dir, "zalet-theme.ps1"), "-Mode", "apply", "-AllFolders")
	case "shortcut":
		dir := filepath.Join(la, "ZALET")
		os.MkdirAll(dir, 0o755)
		ico := filepath.Join(dir, "zalet.ico")
		if b, err := assets.ReadFile("assets/theme/icons/zalet-home.ico"); err == nil {
			os.WriteFile(ico, b, 0o644)
		}
		body := "[InternetShortcut]\r\nURL=" + c.Router + "/\r\nIconFile=" + ico + "\r\nIconIndex=0\r\n"
		start := filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`)
		for _, d := range []string{knownFolder("Desktop"), start} {
			if err := os.WriteFile(filepath.Join(d, "ZALET HOME.url"), []byte(body), 0o644); err != nil {
				return err
			}
		}
		logf("  ярлык «ZALET HOME» на рабочем столе и в меню «Пуск»")
	case "windhawk":
		if fileExists(`C:\Program Files\Windhawk\windhawk.exe`) {
			exec.Command(`C:\Program Files\Windhawk\windhawk.exe`).Start()
		} else if _, err := exec.LookPath("winget"); err == nil {
			logf("  ставлю Windhawk через winget (официальный пакет RamenSoftware.Windhawk)…")
			if err := streamCmd(command("winget", "install", "-e", "--id", "RamenSoftware.Windhawk", "--accept-source-agreements", "--accept-package-agreements")); err != nil {
				return fmt.Errorf("winget: %v", err)
			}
		} else {
			openBrowser("https://windhawk.net/")
			return errors.New("winget не найден — открыл сайт Windhawk, установите вручную")
		}
		logf("  В Windhawk → «Найти моды» поставьте:")
		logf("   • Windows 11 Start Menu Styler — чёрное меню «Пуск»")
		logf("   • Windows 11 Taskbar Styler — стиль панели задач")
		logf("   • Windows 11 Notification Center Styler — центр уведомлений")
		logf("  У стайлеров в настройках есть готовые темы; цвет акцента берётся из темы ZALET (оранжевый)")
		openBrowser("https://windhawk.net/mods")
	default:
		return errors.New("неизвестное действие")
	}
	return nil
}

func undoAction(id string, c Config) error {
	host := routerHost(c.Router)
	la := localApp()
	switch id {
	case "drive":
		out, _ := command("net", "use").Output()
		m := regexp.MustCompile(`(?i)([A-Z]:)\s+` + regexp.QuoteMeta(`\\`+host+`\SSD`)).FindSubmatch(out)
		if m == nil {
			logf("  диск не подключён")
			return nil
		}
		if b, err := command("net", "use", string(m[1]), "/delete", "/y").CombinedOutput(); err != nil {
			return fmt.Errorf("%v %s", err, strings.TrimSpace(string(b)))
		}
	case "folders":
		command("powershell", "-NoProfile", "-Command",
			`Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*listener.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`).Run()
		command("reg", "delete", `HKCU\Software\Classes\zaletopen`, "/f").Run()
		command("reg", "delete", `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "/v", "ZaletOpener", "/f").Run()
		command("powershell", "-NoProfile", "-Command", `$p=Join-Path ([Environment]::GetFolderPath('Startup')) 'ZALET Opener.lnk'; if (Test-Path $p) { [IO.File]::Delete($p) }`).Run()
	case "agent":
		if !fileExists(agentExe) {
			return nil
		}
		return exec.Command(agentExe, "uninstall").Start()
	case "theme":
		dir := filepath.Join(la, "ZALET", "setup", "theme")
		if err := extract("theme", dir); err != nil {
			return err
		}
		return runPS(filepath.Join(dir, "zalet-theme.ps1"), "-Mode", "restore")
	case "shortcut":
		for _, d := range []string{knownFolder("Desktop"), filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`)} {
			os.Remove(filepath.Join(d, "ZALET HOME.url"))
		}
	default:
		return errors.New("для этого пункта отмены нет")
	}
	return nil
}

func installTailscale() error {
	if bin := tailscaleBin(); bin != "" {
		logf("  Tailscale уже установлен")
		exec.Command(bin, "up").Start()
		logf("  если не вошли — нажмите значок Tailscale в трее и войдите тем же аккаунтом, что и на роутере")
		return nil
	}
	if _, err := exec.LookPath("winget"); err == nil {
		logf("  ставлю Tailscale через winget (официальный пакет Tailscale.Tailscale)…")
		if err := streamCmd(command("winget", "install", "-e", "--id", "Tailscale.Tailscale", "--accept-source-agreements", "--accept-package-agreements")); err != nil {
			return fmt.Errorf("winget: %v", err)
		}
		logf("  готово — войдите в Tailscale (значок в трее) тем же аккаунтом, что и на роутере")
		return nil
	}
	openBrowser("https://tailscale.com/download/windows")
	return errors.New("winget не найден — открыл страницу загрузки Tailscale")
}
