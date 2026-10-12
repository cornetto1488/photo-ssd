// SSH-ключи роутера, хранилище ключей, токен ZALET и имена устройств сети — всё для панели.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const authKeysFile = "/etc/dropbear/authorized_keys"

type sshKey struct {
	Index       int    `json:"index"`
	Type        string `json:"type"`
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
	Short       string `json:"short"`
	Line        string `json:"line,omitempty"`
}

func parseKeyLine(line string) (typ, b64, comment string, ok bool) {
	f := strings.Fields(line)
	for i, x := range f { // пропускаем опции в начале строки
		if strings.HasPrefix(x, "ssh-") || strings.HasPrefix(x, "ecdsa-") || strings.HasPrefix(x, "sk-") {
			if i+1 < len(f) {
				return x, f[i+1], strings.Join(f[i+2:], " "), true
			}
		}
	}
	return "", "", "", false
}

func fingerprint(b64 string) string {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return ""
	}
	h := sha256.Sum256(raw)
	return "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(h[:]), "=")
}

var keysMu sync.Mutex

func readAuthKeys() ([]string, error) {
	b, err := os.ReadFile(authKeysFile)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	var lines []string
	for _, l := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, strings.TrimSpace(l))
		}
	}
	return lines, nil
}

func writeAuthKeys(lines []string) error {
	os.MkdirAll("/etc/dropbear", 0o700)
	return os.WriteFile(authKeysFile, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
}

func (p *homePortal) handleSSHKeys(w http.ResponseWriter, r *http.Request) {
	keysMu.Lock()
	defer keysMu.Unlock()
	lines, err := readAuthKeys()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	switch r.Method {
	case http.MethodGet:
		out := []sshKey{}
		for i, l := range lines {
			typ, b64, comment, ok := parseKeyLine(l)
			if !ok {
				continue
			}
			short := b64
			if len(short) > 24 {
				short = short[:12] + "…" + short[len(short)-10:]
			}
			out = append(out, sshKey{Index: i, Type: typ, Name: comment, Fingerprint: fingerprint(b64), Short: short, Line: typ + " " + b64})
		}
		writeJSON(w, http.StatusOK, map[string]any{"keys": out})
	case http.MethodPost:
		var req struct {
			Action string `json:"action"` // add, rename, delete
			Index  int    `json:"index"`
			Name   string `json:"name"`
			Key    string `json:"key"`
		}
		json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req)
		name := strings.Join(strings.Fields(req.Name), "-")
		switch req.Action {
		case "add":
			typ, b64, comment, ok := parseKeyLine(req.Key)
			if !ok || fingerprint(b64) == "" {
				fail(w, http.StatusBadRequest, "это не похоже на публичный SSH-ключ (ssh-ed25519 / ssh-rsa …)")
				return
			}
			if name == "" {
				name = comment
			}
			for _, l := range lines {
				if _, b, _, ok := parseKeyLine(l); ok && b == b64 {
					fail(w, http.StatusBadRequest, "такой ключ уже есть")
					return
				}
			}
			lines = append(lines, strings.TrimSpace(typ+" "+b64+" "+name))
		case "rename", "delete":
			if req.Index < 0 || req.Index >= len(lines) {
				fail(w, http.StatusBadRequest, "нет такого ключа")
				return
			}
			if req.Action == "delete" {
				if len(lines) <= 1 {
					fail(w, http.StatusBadRequest, "нельзя удалить последний ключ — потеряете доступ по SSH")
					return
				}
				lines = append(lines[:req.Index], lines[req.Index+1:]...)
			} else {
				typ, b64, _, _ := parseKeyLine(lines[req.Index])
				lines[req.Index] = strings.TrimSpace(typ + " " + b64 + " " + name)
			}
		default:
			fail(w, http.StatusBadRequest, "action: add, rename, delete")
			return
		}
		if err := writeAuthKeys(lines); err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		fail(w, http.StatusMethodNotAllowed, "GET или POST")
	}
}

// ---------- создание пары ключей ed25519 (формат OpenSSH) ----------

func sshString(b []byte) []byte {
	out := binary.BigEndian.AppendUint32(nil, uint32(len(b)))
	return append(out, b...)
}

func genEd25519(comment string) (pub string, priv string) {
	pk, sk, _ := ed25519.GenerateKey(rand.Reader)
	pubBlob := append(sshString([]byte("ssh-ed25519")), sshString(pk)...)
	pub = "ssh-ed25519 " + base64.StdEncoding.EncodeToString(pubBlob) + " " + comment

	check := make([]byte, 4)
	rand.Read(check)
	var pr bytes.Buffer
	pr.Write(check)
	pr.Write(check)
	pr.Write(sshString([]byte("ssh-ed25519")))
	pr.Write(sshString(pk))
	pr.Write(sshString(sk)) // 64 байта: seed + public
	pr.Write(sshString([]byte(comment)))
	for i := 1; pr.Len()%8 != 0; i++ {
		pr.WriteByte(byte(i))
	}
	var b bytes.Buffer
	b.WriteString("openssh-key-v1\x00")
	b.Write(sshString([]byte("none")))
	b.Write(sshString([]byte("none")))
	b.Write(sshString(nil))
	b.Write(binary.BigEndian.AppendUint32(nil, 1))
	b.Write(sshString(pubBlob))
	b.Write(sshString(pr.Bytes()))
	priv = string(pem.EncodeToMemory(&pem.Block{Type: "OPENSSH PRIVATE KEY", Bytes: b.Bytes()}))
	return
}

func (p *homePortal) handleSSHGen(w http.ResponseWriter, r *http.Request) {
	if !needPost(w, r) {
		return
	}
	var req struct {
		Name      string `json:"name"`
		Authorize bool   `json:"authorize"`
	}
	json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req)
	name := strings.Join(strings.Fields(req.Name), "-")
	if name == "" {
		name = "zalet-" + time.Now().Format("2006-01-02")
	}
	pub, priv := genEd25519(name)
	if req.Authorize {
		keysMu.Lock()
		lines, _ := readAuthKeys()
		lines = append(lines, pub)
		err := writeAuthKeys(lines)
		keysMu.Unlock()
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	// Закрытый ключ отдаётся один раз и на роутере не хранится.
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "public": pub, "private": priv, "name": name})
}

// ---------- хранилище ключей и заметок ----------

type vaultItem struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Host    string `json:"host"`
	User    string `json:"user"`
	Public  string `json:"public"`
	Note    string `json:"note"`
	Created int64  `json:"created"`
}

func (p *homePortal) vaultPath() string { return p.s.meta("vault.json") }

func (p *homePortal) handleVault(w http.ResponseWriter, r *http.Request) {
	keysMu.Lock()
	defer keysMu.Unlock()
	var items []vaultItem
	if b, err := os.ReadFile(p.vaultPath()); err == nil {
		json.Unmarshal(b, &items)
	}
	if r.Method == http.MethodGet {
		if items == nil {
			items = []vaultItem{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
		return
	}
	if !needPost(w, r) {
		return
	}
	var req struct {
		Action string    `json:"action"` // save, delete
		Item   vaultItem `json:"item"`
	}
	json.NewDecoder(io.LimitReader(r.Body, 32<<10)).Decode(&req)
	if strings.Contains(req.Item.Public, "PRIVATE KEY") || strings.Contains(req.Item.Note, "PRIVATE KEY") {
		fail(w, http.StatusBadRequest, "закрытые ключи здесь не храним — только публичные ключи и заметки")
		return
	}
	switch req.Action {
	case "save":
		if req.Item.ID == "" {
			req.Item.ID = randHex(6)
			req.Item.Created = time.Now().Unix()
			items = append(items, req.Item)
		} else {
			for i := range items {
				if items[i].ID == req.Item.ID {
					req.Item.Created = items[i].Created
					items[i] = req.Item
				}
			}
		}
	case "delete":
		for i := range items {
			if items[i].ID == req.Item.ID {
				items = append(items[:i], items[i+1:]...)
				break
			}
		}
	}
	b, _ := json.MarshalIndent(items, "", " ")
	os.WriteFile(p.vaultPath(), b, 0o600)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- токен ZALET ----------

func (p *homePortal) handleToken(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		qr := ""
		if r.URL.Query().Get("qr") == "1" {
			setup := "http://192.168.1.1:8099|" + p.s.token
			if out, err := exec.Command("qrencode", "-t", "SVG", "-m", "1", "-o", "-", setup).Output(); err == nil {
				qr = string(out)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"token": p.s.token, "server": "http://192.168.1.1:8099", "qr": qr})
	case http.MethodPost:
		// Новый токен: старый перестанет работать — приложение нужно будет обновить.
		tok := randHex(24)
		if err := os.WriteFile(p.tokenFile, []byte(tok+"\n"), 0o600); err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		p.s.mu.Lock()
		p.s.token = tok
		p.s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "token": tok})
	}
}

// ---------- имена устройств сети ----------

func (p *homePortal) namesPath() string { return p.s.meta("client-names.json") }

func (p *homePortal) customNames() map[string]string {
	m := map[string]string{}
	if b, err := os.ReadFile(p.namesPath()); err == nil {
		json.Unmarshal(b, &m)
	}
	return m
}

func (p *homePortal) handleClientName(w http.ResponseWriter, r *http.Request) {
	if !needPost(w, r) {
		return
	}
	var req struct{ MAC, Name string }
	json.NewDecoder(io.LimitReader(r.Body, 2048)).Decode(&req)
	keysMu.Lock()
	m := p.customNames()
	mac := strings.ToUpper(strings.TrimSpace(req.MAC))
	if strings.TrimSpace(req.Name) == "" {
		delete(m, mac)
	} else {
		m[mac] = strings.TrimSpace(req.Name)
	}
	b, _ := json.Marshal(m)
	os.WriteFile(p.namesPath(), b, 0o644)
	keysMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Производитель по первым трём байтам MAC (самые частые в доме).
var macVendors = map[string]string{
	"D8:D6:68": "Tuya", "38:2C:E5": "Tuya", "20:F1:B2": "Tuya", "10:5A:17": "Tuya", "68:57:2D": "Tuya", "84:E3:42": "Tuya",
	"00:AE:F7": "Dreame", "5C:C5:63": "Капсула (VK)", "4C:75:25": "Daichi",
	"C8:7F:54": "ASUS", "24:0F:5E": "Routerich", "88:20:0D": "Apple",
	"3C:22:FB": "Apple", "F0:18:98": "Apple", "A4:83:E7": "Apple", "DC:A6:32": "Raspberry Pi",
	"28:6C:07": "Xiaomi", "64:09:80": "Xiaomi", "50:EC:50": "Xiaomi", "B0:E4:D5": "Google",
	"F4:F5:D8": "Google", "70:3A:CB": "Google", "FC:A6:67": "Amazon", "44:65:0D": "Amazon",
	"00:1A:11": "Google", "B8:27:EB": "Raspberry Pi", "AC:84:C6": "TP-Link", "50:C7:BF": "TP-Link",
	"E4:5F:01": "Raspberry Pi", "8C:85:90": "Apple", "BC:D0:74": "Apple", "00:E0:4C": "Realtek",
	"30:C9:22": "Espressif", "A0:20:A6": "Espressif", "24:6F:28": "Espressif", "48:3F:DA": "Espressif",
}

func vendorOf(mac string) string {
	mac = strings.ToUpper(mac)
	if len(mac) < 8 {
		return ""
	}
	if v, ok := macVendors[mac[:8]]; ok {
		return v
	}
	// «частный адрес Wi-Fi»: второй бит первого байта
	b := mac[1]
	if strings.ContainsRune("26AE", rune(b)) {
		return "Телефон (частный адрес)"
	}
	return ""
}
