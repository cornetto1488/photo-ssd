//go:build linux

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func command(name string, args ...string) *exec.Cmd { return exec.Command(name, args...) }

func tailscalePaths() []string {
	return []string{"/usr/bin/tailscale", "/usr/sbin/tailscale", "/usr/local/bin/tailscale"}
}

func openBrowser(u string) {
	if err := exec.Command("xdg-open", u).Start(); err != nil {
		logf("Откройте в браузере: %s", u)
	}
}

func home() string { h, _ := os.UserHomeDir(); return h }

func bookmarksFile() string { return filepath.Join(home(), ".config", "gtk-3.0", "bookmarks") }

func desktopFile() string {
	return filepath.Join(home(), ".local", "share", "applications", "zalet-home.desktop")
}

func has(bin string) bool { _, err := exec.LookPath(bin); return err == nil }

// asRoot запускает команду с правами администратора: напрямую, через pkexec или подсказывает sudo.
func asRoot(name string, args ...string) error {
	if os.Geteuid() == 0 {
		return streamCmd(exec.Command(name, args...))
	}
	if has("pkexec") && (os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "") {
		return streamCmd(exec.Command("pkexec", append([]string{name}, args...)...))
	}
	if has("sudo") {
		cmd := exec.Command("sudo", append([]string{name}, args...)...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		return cmd.Run()
	}
	return errors.New("нужны права администратора: запустите от root")
}

func platformComponents(c Config) []Comp {
	host := routerHost(c.Router)
	bm, _ := os.ReadFile(bookmarksFile())
	gnome := has("gsettings")
	scheme := ""
	if gnome {
		out, _ := exec.Command("gsettings", "get", "org.gnome.desktop.interface", "color-scheme").Output()
		scheme = strings.TrimSpace(string(out))
	}
	comps := []Comp{
		{ID: "drive", Title: "Сетевой диск «Хранилище»", Desc: "smb://" + host + "/SSD в файловом менеджере", Supported: true, InAll: true, CanUndo: true,
			Installed: strings.Contains(string(bm), "smb://"+host+"/SSD")},
		{ID: "agent", Title: "Агент ПК", Desc: "компьютер в панели: состояние, скриншот, сон и выключение", Supported: true, InAll: true, CanUndo: true, NeedsKey: true,
			Installed: fileExists("/opt/zalet/zalet-agent")},
		{ID: "shortcut", Title: "Ярлык панели", Desc: "ZALET HOME в меню приложений", Supported: true, InAll: true, CanUndo: true,
			Installed: fileExists(desktopFile())},
		{ID: "theme", Title: "Тема ZALET", Desc: "тёмная тема и оранжевый акцент (GNOME)", Supported: gnome, InAll: true, CanUndo: true,
			Installed: scheme == "'prefer-dark'"},
		{ID: "wallpaper", Title: "Обои ZALET HOME", Desc: "панель на рабочем столе", Supported: false},
		{ID: "folders", Title: "Кнопки папок", Desc: "кнопки обоев открывают папки", Supported: false},
	}
	for i := range comps {
		cp := &comps[i]
		switch {
		case !cp.Supported && cp.ID == "theme":
			cp.Detail = "нужен GNOME (gsettings)"
		case !cp.Supported:
			cp.Detail = "только для Windows"
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
	switch id {
	case "drive":
		line := "smb://" + host + "/SSD Хранилище"
		b, _ := os.ReadFile(bookmarksFile())
		if !strings.Contains(string(b), "smb://"+host+"/SSD") {
			os.MkdirAll(filepath.Dir(bookmarksFile()), 0o755)
			f, err := os.OpenFile(bookmarksFile(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
			if err != nil {
				return err
			}
			if len(b) > 0 && !strings.HasSuffix(string(b), "\n") {
				f.WriteString("\n")
			}
			f.WriteString(line + "\n")
			f.Close()
			logf("  закладка «Хранилище» добавлена в файловый менеджер")
		}
		if has("gio") {
			if out, err := exec.Command("gio", "mount", "-a", "smb://"+host+"/SSD").CombinedOutput(); err != nil {
				logf("  подключить сразу не вышло (%s) — откройте «Хранилище» в файловом менеджере", strings.TrimSpace(string(out)))
			} else {
				logf("  Хранилище подключено")
			}
		}
	case "agent":
		tmp := filepath.Join(os.TempDir(), "zalet-agent")
		if err := download(c, "/api/home/pc/download?os=linux", tmp); err != nil {
			return err
		}
		os.Chmod(tmp, 0o755)
		logf("  установка агента (нужны права администратора)")
		return asRoot(tmp)
	case "shortcut":
		dir := filepath.Join(home(), ".local", "share", "icons")
		os.MkdirAll(dir, 0o755)
		icon := filepath.Join(dir, "zalet-home.png")
		if b, err := assets.ReadFile("assets/theme/icons/zalet.ico"); err == nil {
			if png := icoPNG(b); png != nil {
				os.WriteFile(icon, png, 0o644)
			}
		}
		os.MkdirAll(filepath.Dir(desktopFile()), 0o755)
		body := "[Desktop Entry]\nType=Application\nName=ZALET HOME\nComment=Панель умного дома\nExec=xdg-open " + c.Router + "/\nIcon=" + icon + "\nTerminal=false\nCategories=Network;\n"
		if err := os.WriteFile(desktopFile(), []byte(body), 0o755); err != nil {
			return err
		}
		logf("  ярлык «ZALET HOME» в меню приложений")
	case "theme":
		exec.Command("gsettings", "set", "org.gnome.desktop.interface", "color-scheme", "prefer-dark").Run()
		exec.Command("gsettings", "set", "org.gnome.desktop.interface", "gtk-theme", "Adwaita-dark").Run()
		if err := exec.Command("gsettings", "set", "org.gnome.desktop.interface", "accent-color", "orange").Run(); err != nil {
			logf("  оранжевый акцент поддерживается с GNOME 47 — здесь только тёмная тема")
		}
	default:
		return errors.New("недоступно на Linux")
	}
	return nil
}

func undoAction(id string, c Config) error {
	host := routerHost(c.Router)
	switch id {
	case "drive":
		b, err := os.ReadFile(bookmarksFile())
		if err == nil {
			var keep []string
			for _, l := range strings.Split(string(b), "\n") {
				if !strings.HasPrefix(l, "smb://"+host+"/SSD") {
					keep = append(keep, l)
				}
			}
			os.WriteFile(bookmarksFile(), []byte(strings.Join(keep, "\n")), 0o644)
		}
		if has("gio") {
			exec.Command("gio", "mount", "-u", "smb://"+host+"/SSD").Run()
		}
	case "agent":
		if !fileExists("/opt/zalet/zalet-agent") {
			return nil
		}
		return asRoot("/opt/zalet/zalet-agent", "uninstall")
	case "shortcut":
		os.Remove(desktopFile())
	case "theme":
		for _, k := range []string{"color-scheme", "gtk-theme", "accent-color"} {
			exec.Command("gsettings", "reset", "org.gnome.desktop.interface", k).Run()
		}
	default:
		return errors.New("для этого пункта отмены нет")
	}
	return nil
}

func installTailscale() error {
	if bin := tailscaleBin(); bin != "" {
		logf("  Tailscale уже установлен — подключаю (откроется ссылка для входа)")
		return asRoot(bin, "up")
	}
	if !has("curl") {
		return errors.New("нужен curl: установите его и повторите")
	}
	logf("  ставлю Tailscale официальным установщиком tailscale.com/install.sh…")
	if err := asRoot("sh", "-c", "curl -fsSL https://tailscale.com/install.sh | sh"); err != nil {
		return err
	}
	logf("  готово — подключаю (откроется ссылка для входа тем же аккаунтом, что и на роутере)")
	if bin := tailscaleBin(); bin != "" {
		return asRoot(bin, "up")
	}
	return nil
}
