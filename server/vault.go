// Хранилище паролей: всё шифруется мастер-паролем (PBKDF2-SHA256 → AES-256-GCM).
// На роутере лежит только зашифрованный файл; мастер-пароль нигде не сохраняется.
package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	pwIterations = 200000
	pwLockAfter  = 10 * time.Minute
)

type pwEntry struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Username string `json:"username"`
	Password string `json:"password"`
	URL      string `json:"url"`
	Note     string `json:"note"`
	Folder   string `json:"folder"`
	Fav      bool   `json:"fav"`
	TOTP     string `json:"totp"`
	Created  int64  `json:"created"`
	Updated  int64  `json:"updated"`
}

type pwVault struct {
	file     string
	mu       sync.Mutex
	sessions map[string]*pwSession
	fails    int
	lockTill time.Time
}

type pwSession struct {
	key     []byte
	salt    []byte
	expires time.Time
}

// PBKDF2-HMAC-SHA256 (RFC 8018), один блок — ключ 32 байта.
func pbkdf2(pass, salt []byte, iter int) []byte {
	m := hmac.New(sha256.New, pass)
	m.Write(salt)
	m.Write([]byte{0, 0, 0, 1})
	u := m.Sum(nil)
	out := append([]byte{}, u...)
	for i := 1; i < iter; i++ {
		m.Reset()
		m.Write(u)
		u = m.Sum(u[:0])
		for j := range out {
			out[j] ^= u[j]
		}
	}
	return out
}

// формат файла: "ZPV1" | salt(16) | nonce(12) | AES-GCM(json)
func (v *pwVault) exists() bool { _, err := os.Stat(v.file); return err == nil }

func (v *pwVault) load(pass []byte) ([]pwEntry, []byte, []byte, error) {
	b, err := os.ReadFile(v.file)
	if err != nil {
		return nil, nil, nil, err
	}
	if len(b) < 4+16+12+16 || string(b[:4]) != "ZPV1" {
		return nil, nil, nil, errors.New("файл хранилища повреждён")
	}
	salt, nonce, ct := b[4:20], b[20:32], b[32:]
	key := pbkdf2(pass, salt, pwIterations)
	plain, err := gcmOpen(key, nonce, ct)
	if err != nil {
		return nil, nil, nil, errors.New("неверный мастер-пароль")
	}
	var items []pwEntry
	json.Unmarshal(plain, &items)
	return items, key, salt, nil
}

func (v *pwVault) save(items []pwEntry, key, salt []byte) error {
	plain, _ := json.Marshal(items)
	nonce := make([]byte, 12)
	rand.Read(nonce)
	blk, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(blk)
	out := append([]byte("ZPV1"), salt...)
	out = append(out, nonce...)
	out = append(out, gcm.Seal(nil, nonce, plain, nil)...)
	tmp := v.file + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	// резервная копия прошлой версии
	if old, err := os.ReadFile(v.file); err == nil {
		os.WriteFile(v.file+".bak", old, 0o600)
	}
	return os.Rename(tmp, v.file)
}

func gcmOpen(key, nonce, ct []byte) ([]byte, error) {
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, _ := cipher.NewGCM(blk)
	return gcm.Open(nil, nonce, ct, nil)
}

func (v *pwVault) readWithKey(key []byte) ([]pwEntry, error) {
	b, err := os.ReadFile(v.file)
	if err != nil || len(b) < 32 {
		return nil, errors.New("нет хранилища")
	}
	plain, err := gcmOpen(key, b[20:32], b[32:])
	if err != nil {
		return nil, err
	}
	var items []pwEntry
	json.Unmarshal(plain, &items)
	return items, nil
}

func (v *pwVault) session(r *http.Request) *pwSession {
	tok := r.Header.Get("X-Vault")
	v.mu.Lock()
	defer v.mu.Unlock()
	s := v.sessions[tok]
	if s == nil || time.Now().After(s.expires) {
		delete(v.sessions, tok)
		return nil
	}
	s.expires = time.Now().Add(pwLockAfter)
	return s
}

func (v *pwVault) handle(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action string    `json:"action"` // status, setup, unlock, lock, list, save, delete, change
		Master string    `json:"master"`
		Next   string    `json:"next"`
		Entry  pwEntry   `json:"entry"`
		Items  []pwEntry `json:"items"`
	}
	if r.Method == http.MethodPost {
		json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&req)
	} else {
		req.Action = "status"
	}
	switch req.Action {
	case "status":
		writeJSON(w, http.StatusOK, map[string]any{"exists": v.exists(), "unlocked": v.session(r) != nil})
	case "setup":
		if v.exists() {
			fail(w, http.StatusBadRequest, "хранилище уже создано")
			return
		}
		if len(req.Master) < 8 {
			fail(w, http.StatusBadRequest, "мастер-пароль — минимум 8 символов")
			return
		}
		salt := make([]byte, 16)
		rand.Read(salt)
		key := pbkdf2([]byte(req.Master), salt, pwIterations)
		if err := v.save([]pwEntry{}, key, salt); err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		log.Printf("хранилище паролей создано")
		v.issue(w, key, salt, []pwEntry{})
	case "unlock":
		v.mu.Lock()
		if wait := time.Until(v.lockTill); wait > 0 {
			v.mu.Unlock()
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "слишком много попыток", "locked": int(wait.Seconds()) + 1})
			return
		}
		v.mu.Unlock()
		items, key, salt, err := v.load([]byte(req.Master))
		if err != nil {
			v.mu.Lock()
			v.fails++
			if v.fails >= 5 {
				v.lockTill = time.Now().Add(time.Minute << uint(min(v.fails-5, 4)))
			}
			v.mu.Unlock()
			log.Printf("хранилище паролей: неверный мастер-пароль (%s)", clientIP(r))
			fail(w, http.StatusUnauthorized, err.Error())
			return
		}
		v.mu.Lock()
		v.fails = 0
		v.mu.Unlock()
		v.issue(w, key, salt, items)
	case "lock":
		v.mu.Lock()
		delete(v.sessions, r.Header.Get("X-Vault"))
		v.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "list", "save", "delete", "change", "totp", "import":
		s := v.session(r)
		if s == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "хранилище заблокировано", "locked": true})
			return
		}
		v.mu.Lock()
		defer v.mu.Unlock()
		items, err := v.readWithKey(s.key)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		switch req.Action {
		case "totp":
			for _, it := range items {
				if it.ID == req.Entry.ID && it.TOTP != "" {
					code, left, err := totpNow(it.TOTP)
					if err != nil {
						fail(w, http.StatusBadRequest, err.Error())
						return
					}
					writeJSON(w, http.StatusOK, map[string]any{"code": code, "left": left})
					return
				}
			}
			fail(w, http.StatusNotFound, "нет ключа 2FA")
			return
		case "import":
			for _, e := range req.Items {
				e.ID = randHex(6)
				e.Created = time.Now().Unix()
				e.Updated = e.Created
				items = append(items, e)
			}
		case "save":
			e := req.Entry
			e.Updated = time.Now().Unix()
			if e.ID == "" {
				e.ID = randHex(6)
				e.Created = e.Updated
				items = append(items, e)
			} else {
				for i := range items {
					if items[i].ID == e.ID {
						e.Created = items[i].Created
						items[i] = e
					}
				}
			}
		case "delete":
			for i := range items {
				if items[i].ID == req.Entry.ID {
					items = append(items[:i], items[i+1:]...)
					break
				}
			}
		case "change":
			if _, _, _, err := v.load([]byte(req.Master)); err != nil {
				fail(w, http.StatusUnauthorized, "текущий мастер-пароль неверный")
				return
			}
			if len(req.Next) < 8 {
				fail(w, http.StatusBadRequest, "новый мастер-пароль — минимум 8 символов")
				return
			}
			salt := make([]byte, 16)
			rand.Read(salt)
			s.key = pbkdf2([]byte(req.Next), salt, pwIterations)
			s.salt = salt
		}
		if req.Action != "list" {
			if err := v.save(items, s.key, s.salt); err != nil {
				fail(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		if items == nil {
			items = []pwEntry{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
	default:
		fail(w, http.StatusBadRequest, "неизвестное действие")
	}
}

func (v *pwVault) issue(w http.ResponseWriter, key, salt []byte, items []pwEntry) {
	tok := randHex(24)
	v.mu.Lock()
	if v.sessions == nil {
		v.sessions = map[string]*pwSession{}
	}
	v.sessions[tok] = &pwSession{key: key, salt: salt, expires: time.Now().Add(pwLockAfter)}
	v.mu.Unlock()
	if items == nil {
		items = []pwEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "vault": tok, "items": items, "lockAfter": int(pwLockAfter.Seconds())})
}

// totpNow — код 2FA (RFC 6238, SHA1, 6 цифр, 30 с) из base32-ключа или otpauth:// ссылки.
func totpNow(secret string) (string, int, error) {
	if u, err := url.Parse(secret); err == nil && u.Scheme == "otpauth" {
		secret = u.Query().Get("secret")
	}
	secret = strings.ToUpper(strings.NewReplacer(" ", "", "-", "", "=", "").Replace(secret))
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil || len(key) == 0 {
		return "", 0, errors.New("неверный ключ 2FA")
	}
	now := time.Now().Unix()
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(now/30))
	m := hmac.New(sha1.New, key)
	m.Write(msg[:])
	h := m.Sum(nil)
	off := h[len(h)-1] & 0x0f
	n := binary.BigEndian.Uint32(h[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", n%1000000), int(30 - now%30), nil
}
