// photossd — сервер приёма фото с iPhone на SSD роутера.
//
// API (все запросы с заголовком Authorization: Bearer <token>):
//   GET  /api/v1/ping                      — статус, место на диске, число файлов
//   GET  /api/v1/index                     — список уже принятых файлов (для сверки)
//   PUT  /api/v1/upload?path=&id=&size=&mtime=  — приём файла (тело = содержимое)
//   POST /api/v1/forget?id=                — забыть запись (для повторной выгрузки)
package main

import (
	"bufio"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const version = "1.0.0"

type record struct {
	ID    string `json:"id"`
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Time  int64  `json:"time"`
	Gone  bool   `json:"gone,omitempty"`
}

type server struct {
	root      string
	token     string
	indexPath string

	mu    sync.Mutex
	byID  map[string]record
	paths map[string]string // путь -> id
	idx   *os.File
}

func main() {
	listen := flag.String("listen", ":8099", "адрес для прослушивания")
	root := flag.String("root", "/mnt/ssd/Photos", "корневая папка для фото")
	tokenFile := flag.String("token-file", "/etc/photossd.token", "файл с токеном доступа")
	flag.Parse()

	tok, err := os.ReadFile(*tokenFile)
	if err != nil || strings.TrimSpace(string(tok)) == "" {
		log.Fatalf("не удалось прочитать токен из %s: %v", *tokenFile, err)
	}

	s := &server{
		root:  filepath.Clean(*root),
		token: strings.TrimSpace(string(tok)),
		byID:  map[string]record{},
		paths: map[string]string{},
	}
	if err := s.openIndex(); err != nil {
		log.Fatalf("индекс: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/ping", s.auth(s.handlePing))
	mux.HandleFunc("/api/v1/index", s.auth(s.handleIndex))
	mux.HandleFunc("/api/v1/upload", s.auth(s.handleUpload))
	mux.HandleFunc("/api/v1/forget", s.auth(s.handleForget))

	srv := &http.Server{
		Addr:              *listen,
		Handler:           mux,
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("photossd %s: %s -> %s (%d записей)", version, *listen, s.root, len(s.byID))
	log.Fatal(srv.ListenAndServe())
}

// ---------- индекс ----------

func (s *server) openIndex() error {
	dir := filepath.Join(s.root, ".photossd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	s.indexPath = filepath.Join(dir, "index.jsonl")
	if f, err := os.Open(s.indexPath); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			var r record
			if json.Unmarshal(sc.Bytes(), &r) != nil || r.ID == "" {
				continue
			}
			if r.Gone {
				if old, ok := s.byID[r.ID]; ok {
					delete(s.paths, old.Path)
				}
				delete(s.byID, r.ID)
				continue
			}
			s.byID[r.ID] = r
			s.paths[r.Path] = r.ID
		}
		f.Close()
	}
	f, err := os.OpenFile(s.indexPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	s.idx = f
	return nil
}

func (s *server) appendIndex(r record) {
	b, _ := json.Marshal(r)
	s.idx.Write(append(b, '\n'))
	s.idx.Sync()
}

// ---------- http ----------

func (s *server) auth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "неверный токен"})
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func (s *server) handlePing(w http.ResponseWriter, r *http.Request) {
	var st syscall.Statfs_t
	var free, total uint64
	if syscall.Statfs(s.root, &st) == nil {
		free = st.Bavail * uint64(st.Bsize)
		total = st.Blocks * uint64(st.Bsize)
	}
	s.mu.Lock()
	n := len(s.byID)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "version": version, "free": free, "total": total, "files": n,
	})
}

func (s *server) handleIndex(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	items := make([]record, 0, len(s.byID))
	for _, rec := range s.byID {
		items = append(items, rec)
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *server) handleForget(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "нужен POST"})
		return
	}
	id := r.URL.Query().Get("id")
	s.mu.Lock()
	if old, ok := s.byID[id]; ok {
		delete(s.paths, old.Path)
		delete(s.byID, id)
		s.appendIndex(record{ID: id, Gone: true, Time: time.Now().Unix()})
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// cleanRel превращает присланный путь в безопасный относительный путь внутри root.
func cleanRel(p string) (string, error) {
	p = strings.ReplaceAll(p, "\\", "/")
	p = path.Clean("/" + p)
	p = strings.TrimPrefix(p, "/")
	if p == "" || p == "." || strings.HasPrefix(p, "..") {
		return "", errors.New("недопустимый путь")
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".photossd" || strings.HasPrefix(part, ".") {
			return "", errors.New("недопустимое имя")
		}
	}
	return p, nil
}

// uniquePath подбирает свободное имя: "IMG_1.HEIC" -> "IMG_1 (1).HEIC".
func (s *server) uniquePath(rel string) string {
	ext := path.Ext(rel)
	base := strings.TrimSuffix(rel, ext)
	for i := 1; ; i++ {
		cand := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Stat(filepath.Join(s.root, filepath.FromSlash(cand))); errors.Is(err, os.ErrNotExist) {
			if _, taken := s.paths[cand]; !taken {
				return cand
			}
		}
	}
}

func (s *server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "нужен PUT"})
		return
	}
	q := r.URL.Query()
	id := q.Get("id")
	rel, err := cleanRel(q.Get("path"))
	if err != nil || id == "" {
		io.Copy(io.Discard, r.Body)
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "нужны path и id"})
		return
	}
	size, _ := strconv.ParseInt(q.Get("size"), 10, 64)
	mtime, _ := strconv.ParseInt(q.Get("mtime"), 10, 64)

	// Уже принимали этот файл — тело не нужно.
	s.mu.Lock()
	if rec, ok := s.byID[id]; ok {
		s.mu.Unlock()
		io.Copy(io.Discard, r.Body)
		writeJSON(w, http.StatusOK, map[string]any{"status": "duplicate", "path": rec.Path, "size": rec.Size})
		return
	}
	s.mu.Unlock()

	dst := filepath.Join(s.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(dst), 0o777); err != nil {
		io.Copy(io.Discard, r.Body)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".upload-*")
	if err != nil {
		io.Copy(io.Discard, r.Body)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	n, err := io.Copy(tmp, r.Body)
	if err == nil {
		err = tmp.Sync()
	}
	tmp.Close()
	if err != nil || (size > 0 && n != size) {
		os.Remove(tmp.Name())
		msg := "передача оборвалась"
		if err != nil {
			msg = err.Error()
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": msg, "received": n, "expected": size})
		return
	}
	os.Chmod(tmp.Name(), 0o666)

	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, ok := s.byID[id]; ok { // параллельный дубль
		os.Remove(tmp.Name())
		writeJSON(w, http.StatusOK, map[string]any{"status": "duplicate", "path": rec.Path, "size": rec.Size})
		return
	}
	status := "stored"
	if fi, err := os.Stat(dst); err == nil {
		if fi.Size() == n {
			// Такой же файл уже лежит (например, выгружен раньше другим способом).
			status = "existing"
		} else {
			rel = s.uniquePath(rel)
			dst = filepath.Join(s.root, filepath.FromSlash(rel))
		}
	}
	if status == "existing" {
		os.Remove(tmp.Name())
	} else {
		if err := os.Rename(tmp.Name(), dst); err != nil {
			os.Remove(tmp.Name())
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		if mtime > 0 {
			t := time.Unix(mtime, 0)
			os.Chtimes(dst, t, t)
		}
	}
	rec := record{ID: id, Path: rel, Size: n, Time: time.Now().Unix()}
	s.byID[id] = rec
	s.paths[rel] = id
	s.appendIndex(rec)
	log.Printf("%s %s (%d байт)", status, rel, n)
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "path": rel, "size": n})
}
