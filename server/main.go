// photossd — сервер ZALET: приём фото с iPhone на SSD роутера, просмотр, корзина, статистика.
//
// Все запросы — с заголовком Authorization: Bearer <token>.
//
//   GET  /api/v1/ping                         статус, место, счётчики
//   GET  /api/v1/index                        id всех принятых файлов (для сверки, без повторов)
//   PUT  /api/v1/upload?path&id&size&mtime&date&kind&album   приём файла
//   PUT  /api/v1/thumb?id|path                превью (jpeg) от клиента
//   GET  /api/v1/thumb?id|path                превью
//   GET  /api/v1/file?id|path[&trash=1]       оригинал (с поддержкой Range)
//   GET  /api/v1/browse?dir                   содержимое папки на SSD
//   GET  /api/v1/items?from&to&kind&album&q&offset&limit   лента с фильтрами
//   GET  /api/v1/albums                       альбомы и количество
//   GET  /api/v1/stats                        статистика
//   POST /api/v1/trash?id|path                переместить в корзину
//   GET  /api/v1/trash                        содержимое корзины
//   POST /api/v1/trash/restore?id             вернуть из корзины
//   POST /api/v1/trash/delete?id              удалить навсегда
//   POST /api/v1/trash/empty                  очистить корзину
//   POST /api/v1/forget?id                    забыть запись (разрешить повторную выгрузку)
package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	version   = "3.0.0"
	trashDays = 30
	metaDir   = ".photossd"
)

type record struct {
	ID      string `json:"id"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Time    int64  `json:"time"`            // когда принят
	Date    int64  `json:"date,omitempty"`  // когда снят
	Kind    string `json:"kind,omitempty"`  // photo, live, livevideo, video, screenshot
	Album   string `json:"album,omitempty"` // альбом на iPhone
	Thumb   bool   `json:"thumb,omitempty"`
	Trashed int64  `json:"trashed,omitempty"` // когда перемещён в корзину
	Purged  bool   `json:"purged,omitempty"`  // удалён навсегда (повторно не выгружать)
	Gone    bool   `json:"gone,omitempty"`    // запись забыта
}

type server struct {
	root  string
	token string

	mux          *http.ServeMux
	sessionCheck func(*http.Request) bool // вход в панель по PIN (cookie)

	mu    sync.Mutex
	byID  map[string]*record
	paths map[string]string // путь -> id (только для живых файлов)
	idx   *os.File
}

func main() {
	listen := flag.String("listen", ":8099", "адрес для прослушивания")
	root := flag.String("root", "/mnt/ssd/Photos", "корневая папка для фото")
	tokenFile := flag.String("token-file", "/etc/photossd.token", "файл с токеном доступа")
	portalListen := flag.String("portal-listen", "", "адреса панели ZALET HOME через запятую, напр. 192.168.1.1:80")
	portalProxy := flag.String("portal-proxy", "", "куда отдавать служебные пути роутера (LuCI), напр. http://192.168.1.2")
	tuyaConf := flag.String("tuya-conf", "/etc/pc-remote.conf", "настройки облака Tuya")
	pcIP := flag.String("pc-ip", "192.168.1.104", "IP компьютера")
	pcMAC := flag.String("pc-mac", "C8:7F:54:A9:D9:C1", "MAC компьютера")
	pinFile := flag.String("pin-file", "/etc/zalet-portal.json", "PIN панели (хэш)")
	tuyaProbe := flag.Bool("tuya-probe", false, "проверить локальное управление Tuya и выйти")
	flag.Parse()
	if *tuyaProbe {
		runProbeCLI(*tuyaConf)
		return
	}

	tok, err := os.ReadFile(*tokenFile)
	if err != nil || strings.TrimSpace(string(tok)) == "" {
		log.Fatalf("не удалось прочитать токен из %s: %v", *tokenFile, err)
	}
	s := &server{
		root:  filepath.Clean(*root),
		token: strings.TrimSpace(string(tok)),
		byID:  map[string]*record{},
		paths: map[string]string{},
	}
	if err := s.openIndex(); err != nil {
		log.Fatalf("индекс: %v", err)
	}
	go s.purgeLoop()

	mux := http.NewServeMux()
	routes := map[string]http.HandlerFunc{
		"/api/v1/ping":          s.handlePing,
		"/api/v1/index":         s.handleIndex,
		"/api/v1/upload":        s.handleUpload,
		"/api/v1/thumb":         s.handleThumb,
		"/api/v1/file":          s.handleFile,
		"/api/v1/browse":        s.handleBrowse,
		"/api/v1/items":         s.handleItems,
		"/api/v1/albums":        s.handleAlbums,
		"/api/v1/stats":         s.handleStats,
		"/api/v1/trash":         s.handleTrash,
		"/api/v1/trash/restore": s.handleTrashRestore,
		"/api/v1/trash/delete":  s.handleTrashDelete,
		"/api/v1/trash/empty":   s.handleTrashEmpty,
		"/api/v1/forget":        s.handleForget,
	}
	for p, h := range routes {
		mux.HandleFunc(p, s.auth(h))
	}
	s.mux = mux
	if *portalListen != "" {
		newPortal(s, *tuyaConf, *portalProxy, *pcIP, *pcMAC, *pinFile, *tokenFile).listen(*portalListen)
	}
	srv := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 30 * time.Second, IdleTimeout: 120 * time.Second}
	log.Printf("photossd %s: %s -> %s (%d записей)", version, *listen, s.root, len(s.byID))
	log.Fatal(srv.ListenAndServe())
}

// ---------- пути ----------

func (s *server) meta(parts ...string) string {
	return filepath.Join(append([]string{s.root, metaDir}, parts...)...)
}
func (s *server) abs(rel string) string { return filepath.Join(s.root, filepath.FromSlash(rel)) }
func (s *server) trashAbs(rel string) string {
	return filepath.Join(s.root, metaDir, "trash", filepath.FromSlash(rel))
}

func cleanRel(p string, allowEmpty bool) (string, error) {
	p = strings.ReplaceAll(p, "\\", "/")
	p = path.Clean("/" + p)
	p = strings.TrimPrefix(p, "/")
	if p == "." {
		p = ""
	}
	if p == "" {
		if allowEmpty {
			return "", nil
		}
		return "", errors.New("пустой путь")
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." || strings.HasPrefix(part, ".") {
			return "", errors.New("недопустимое имя")
		}
	}
	return p, nil
}

func thumbKey(id, rel string) string {
	src := id
	if src == "" {
		src = "path:" + rel
	}
	h := sha1.Sum([]byte(src))
	return hex.EncodeToString(h[:])
}

func (s *server) thumbPath(id, rel string) string {
	k := thumbKey(id, rel)
	return s.meta("thumbs", k[:2], k+".jpg")
}

// ---------- индекс ----------

func (s *server) openIndex() error {
	if err := os.MkdirAll(s.meta("thumbs"), 0o755); err != nil {
		return err
	}
	os.MkdirAll(s.meta("trash"), 0o755)
	ip := s.meta("index.jsonl")
	if f, err := os.Open(ip); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			var r record
			if json.Unmarshal(sc.Bytes(), &r) != nil || r.ID == "" {
				continue
			}
			if old, ok := s.byID[r.ID]; ok && s.paths[old.Path] == r.ID {
				delete(s.paths, old.Path)
			}
			if r.Gone {
				delete(s.byID, r.ID)
				continue
			}
			rc := r
			s.byID[r.ID] = &rc
			if rc.Trashed == 0 && !rc.Purged {
				s.paths[rc.Path] = rc.ID
			}
		}
		f.Close()
	}
	f, err := os.OpenFile(ip, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	s.idx = f
	return nil
}

// put сохраняет запись (вызывать под s.mu).
func (s *server) put(r *record) {
	if old, ok := s.byID[r.ID]; ok && s.paths[old.Path] == r.ID {
		delete(s.paths, old.Path)
	}
	if r.Gone {
		delete(s.byID, r.ID)
	} else {
		s.byID[r.ID] = r
		if r.Trashed == 0 && !r.Purged {
			s.paths[r.Path] = r.ID
		}
	}
	b, _ := json.Marshal(r)
	s.idx.Write(append(b, '\n'))
	s.idx.Sync()
}

func (s *server) live(r *record) bool { return r.Trashed == 0 && !r.Purged }

// ---------- http ----------

func (s *server) auth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if got == "" {
			got = r.URL.Query().Get("token")
		}
		if got == "" && s.sessionCheck != nil && s.sessionCheck(r) {
			h(w, r)
			return
		}
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

func fail(w http.ResponseWriter, code int, msg string) { writeJSON(w, code, map[string]any{"error": msg}) }

func needPost(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "нужен POST")
		return false
	}
	return true
}

func qInt(r *http.Request, k string) int64 {
	v, _ := strconv.ParseInt(r.URL.Query().Get(k), 10, 64)
	return v
}

// ---------- ping / index ----------

func (s *server) handlePing(w http.ResponseWriter, r *http.Request) {
	var st syscall.Statfs_t
	var free, total uint64
	if syscall.Statfs(s.root, &st) == nil {
		free = st.Bavail * uint64(st.Bsize)
		total = st.Blocks * uint64(st.Bsize)
	}
	s.mu.Lock()
	files, trash := 0, 0
	var trashBytes int64
	for _, rec := range s.byID {
		switch {
		case s.live(rec):
			files++
		case rec.Trashed > 0 && !rec.Purged:
			trash++
			trashBytes += rec.Size
		}
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "version": version, "free": free, "total": total,
		"files": files, "trash": trash, "trashBytes": trashBytes,
	})
}

func (s *server) handleIndex(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	items := make([]record, 0, len(s.byID))
	for _, rec := range s.byID {
		items = append(items, *rec)
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *server) handleForget(w http.ResponseWriter, r *http.Request) {
	if !needPost(w, r) {
		return
	}
	id := r.URL.Query().Get("id")
	s.mu.Lock()
	if _, ok := s.byID[id]; ok {
		s.put(&record{ID: id, Gone: true, Time: time.Now().Unix()})
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- приём ----------

func (s *server) uniquePath(rel string, exists func(string) bool) string {
	ext := path.Ext(rel)
	base := strings.TrimSuffix(rel, ext)
	for i := 1; ; i++ {
		cand := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if !exists(cand) {
			return cand
		}
	}
}

func (s *server) takenOnDisk(rel string) bool {
	if _, err := os.Stat(s.abs(rel)); err == nil {
		return true
	}
	_, taken := s.paths[rel]
	return taken
}

func (s *server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "нужен PUT")
		return
	}
	q := r.URL.Query()
	id := q.Get("id")
	rel, err := cleanRel(q.Get("path"), false)
	if err != nil || id == "" {
		io.Copy(io.Discard, r.Body)
		fail(w, http.StatusBadRequest, "нужны path и id")
		return
	}
	size := qInt(r, "size")
	mtime := qInt(r, "mtime")
	date := qInt(r, "date")
	if date == 0 {
		date = mtime
	}

	s.mu.Lock()
	if rec, ok := s.byID[id]; ok {
		s.mu.Unlock()
		io.Copy(io.Discard, r.Body)
		writeJSON(w, http.StatusOK, map[string]any{"status": "duplicate", "path": rec.Path, "size": rec.Size})
		return
	}
	s.mu.Unlock()

	dst := s.abs(rel)
	if err := os.MkdirAll(filepath.Dir(dst), 0o777); err != nil {
		io.Copy(io.Discard, r.Body)
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".upload-*")
	if err != nil {
		io.Copy(io.Discard, r.Body)
		fail(w, http.StatusInternalServerError, err.Error())
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
	if rec, ok := s.byID[id]; ok {
		os.Remove(tmp.Name())
		writeJSON(w, http.StatusOK, map[string]any{"status": "duplicate", "path": rec.Path, "size": rec.Size})
		return
	}
	status := "stored"
	if fi, err := os.Stat(dst); err == nil {
		if fi.Size() == n {
			status = "existing"
		} else {
			rel = s.uniquePath(rel, s.takenOnDisk)
			dst = s.abs(rel)
		}
	}
	if status == "existing" {
		os.Remove(tmp.Name())
	} else {
		if err := os.Rename(tmp.Name(), dst); err != nil {
			os.Remove(tmp.Name())
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if mtime > 0 {
			t := time.Unix(mtime, 0)
			os.Chtimes(dst, t, t)
		}
	}
	rec := &record{ID: id, Path: rel, Size: n, Time: time.Now().Unix(), Date: date,
		Kind: q.Get("kind"), Album: q.Get("album")}
	if _, err := os.Stat(s.thumbPath(id, rel)); err == nil {
		rec.Thumb = true
	}
	s.put(rec)
	log.Printf("%s %s (%d байт)", status, rel, n)
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "path": rel, "size": n})
}

// ---------- поиск записи по id или пути ----------

func (s *server) lookup(r *http.Request) (*record, string) {
	q := r.URL.Query()
	if id := q.Get("id"); id != "" {
		if rec, ok := s.byID[id]; ok {
			return rec, rec.Path
		}
		return nil, ""
	}
	rel, err := cleanRel(q.Get("path"), false)
	if err != nil {
		return nil, ""
	}
	if id, ok := s.paths[rel]; ok {
		return s.byID[id], rel
	}
	return nil, rel
}

// ---------- превью ----------

func (s *server) handleThumb(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	rec, rel := s.lookup(r)
	id := ""
	if rec != nil {
		id = rec.ID
	}
	s.mu.Unlock()
	if rel == "" {
		fail(w, http.StatusNotFound, "нет такого файла")
		return
	}
	tp := s.thumbPath(id, rel)

	if r.Method == http.MethodPut || r.Method == http.MethodPost {
		data, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
		if err != nil || len(data) < 100 {
			fail(w, http.StatusBadRequest, "пустое превью")
			return
		}
		os.MkdirAll(filepath.Dir(tp), 0o755)
		if err := os.WriteFile(tp, data, 0o644); err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if rec != nil && !rec.Thumb {
			s.mu.Lock()
			c := *rec
			c.Thumb = true
			s.put(&c)
			s.mu.Unlock()
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}

	if _, err := os.Stat(tp); err != nil {
		// Нет превью — пробуем сделать сами (JPEG/PNG).
		src := s.abs(rel)
		if rec != nil && rec.Trashed > 0 {
			src = s.trashAbs(rec.Path)
		}
		ext := strings.ToLower(path.Ext(rel))
		if ext != ".jpg" && ext != ".jpeg" && ext != ".png" {
			fail(w, http.StatusNotFound, "нет превью")
			return
		}
		if err := makeThumb(src, tp, 400); err != nil {
			fail(w, http.StatusNotFound, "нет превью")
			return
		}
	}
	w.Header().Set("Cache-Control", "private, max-age=604800")
	http.ServeFile(w, r, tp)
}

func makeThumb(src, dst string, max int) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return err
	}
	b := img.Bounds()
	wd, ht := b.Dx(), b.Dy()
	if wd == 0 || ht == 0 {
		return errors.New("пустое изображение")
	}
	scale := float64(max) / float64(wd)
	if ht > wd {
		scale = float64(max) / float64(ht)
	}
	if scale > 1 {
		scale = 1
	}
	nw, nh := int(float64(wd)*scale), int(float64(ht)*scale)
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}
	out := image.NewRGBA(image.Rect(0, 0, nw, nh))
	// усреднение по блоку — достаточно для превью
	for y := 0; y < nh; y++ {
		y0 := b.Min.Y + y*ht/nh
		y1 := b.Min.Y + (y+1)*ht/nh
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for x := 0; x < nw; x++ {
			x0 := b.Min.X + x*wd/nw
			x1 := b.Min.X + (x+1)*wd/nw
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var rs, gs, bs, n uint64
			stepY := (y1-y0)/4 + 1
			stepX := (x1-x0)/4 + 1
			for yy := y0; yy < y1; yy += stepY {
				for xx := x0; xx < x1; xx += stepX {
					cr, cg, cb, _ := img.At(xx, yy).RGBA()
					rs += uint64(cr)
					gs += uint64(cg)
					bs += uint64(cb)
					n++
				}
			}
			out.Set(x, y, color.RGBA{uint8(rs / n >> 8), uint8(gs / n >> 8), uint8(bs / n >> 8), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, out, &jpeg.Options{Quality: 80}); err != nil {
		return err
	}
	os.MkdirAll(filepath.Dir(dst), 0o755)
	return os.WriteFile(dst, buf.Bytes(), 0o644)
}

// ---------- файлы ----------

func (s *server) handleFile(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	rec, rel := s.lookup(r)
	var p string
	if rec != nil && rec.Trashed > 0 && !rec.Purged {
		p = s.trashAbs(rec.Path)
	} else if rel != "" {
		p = s.abs(rel)
	}
	s.mu.Unlock()
	if p == "" {
		fail(w, http.StatusNotFound, "нет такого файла")
		return
	}
	f, err := os.Open(p)
	if err != nil {
		fail(w, http.StatusNotFound, "файл не найден на SSD")
		return
	}
	defer f.Close()
	fi, _ := f.Stat()
	w.Header().Set("Content-Disposition", "inline; filename*=UTF-8''"+urlEscape(path.Base(p)))
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

func urlEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// ---------- обзор папок ----------

type entry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Dir   bool   `json:"dir,omitempty"`
	Count int    `json:"count,omitempty"`
	Size  int64  `json:"size,omitempty"`
	Mtime int64  `json:"mtime,omitempty"`
	ID    string `json:"id,omitempty"`
	Date  int64  `json:"date,omitempty"`
	Kind  string `json:"kind,omitempty"`
	Album string `json:"album,omitempty"`
	Thumb bool   `json:"thumb,omitempty"`
}

func (s *server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	rel, err := cleanRel(r.URL.Query().Get("dir"), true)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	des, err := os.ReadDir(s.abs(rel))
	if err != nil {
		fail(w, http.StatusNotFound, "папка не найдена")
		return
	}
	out := []entry{}
	s.mu.Lock()
	for _, de := range des {
		name := de.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		p := name
		if rel != "" {
			p = rel + "/" + name
		}
		if de.IsDir() {
			n := 0
			if sub, err := os.ReadDir(s.abs(p)); err == nil {
				for _, x := range sub {
					if !strings.HasPrefix(x.Name(), ".") {
						n++
					}
				}
			}
			out = append(out, entry{Name: name, Path: p, Dir: true, Count: n})
			continue
		}
		fi, err := de.Info()
		if err != nil {
			continue
		}
		e := entry{Name: name, Path: p, Size: fi.Size(), Mtime: fi.ModTime().Unix()}
		if id, ok := s.paths[p]; ok {
			rec := s.byID[id]
			e.ID, e.Date, e.Kind, e.Album, e.Thumb = rec.ID, rec.Date, rec.Kind, rec.Album, rec.Thumb
		}
		if !e.Thumb {
			if _, err := os.Stat(s.thumbPath(e.ID, p)); err == nil {
				e.Thumb = true
			}
		}
		out = append(out, e)
	}
	s.mu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		if out[i].Dir {
			return out[i].Name > out[j].Name // новые годы/месяцы сверху
		}
		return out[i].Mtime > out[j].Mtime
	})
	writeJSON(w, http.StatusOK, map[string]any{"dir": rel, "entries": out})
}

// ---------- лента и поиск ----------

func (s *server) handleItems(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from, to := qInt(r, "from"), qInt(r, "to")
	kind := q.Get("kind")
	album := q.Get("album")
	text := strings.ToLower(strings.TrimSpace(q.Get("q")))
	offset, limit := int(qInt(r, "offset")), int(qInt(r, "limit"))
	if limit <= 0 || limit > 1000 {
		limit = 300
	}
	withLive := q.Get("livevideo") == "1"

	s.mu.Lock()
	list := make([]record, 0, 1024)
	for _, rec := range s.byID {
		if !s.live(rec) {
			continue
		}
		if rec.Kind == "livevideo" && !withLive {
			continue
		}
		d := rec.Date
		if d == 0 {
			d = rec.Time
		}
		if from > 0 && d < from || to > 0 && d >= to {
			continue
		}
		if kind != "" && rec.Kind != kind {
			continue
		}
		if album != "" && rec.Album != album {
			continue
		}
		if text != "" && !strings.Contains(strings.ToLower(rec.Path), text) && !strings.Contains(strings.ToLower(rec.Album), text) {
			continue
		}
		list = append(list, *rec)
	}
	s.mu.Unlock()
	sort.Slice(list, func(i, j int) bool {
		di, dj := list[i].Date, list[j].Date
		if di == 0 {
			di = list[i].Time
		}
		if dj == 0 {
			dj = list[j].Time
		}
		if di != dj {
			return di > dj
		}
		return list[i].Path > list[j].Path
	})
	total := len(list)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	writeJSON(w, http.StatusOK, map[string]any{"total": total, "offset": offset, "items": list[offset:end]})
}

func (s *server) handleAlbums(w http.ResponseWriter, r *http.Request) {
	counts := map[string]int{}
	s.mu.Lock()
	for _, rec := range s.byID {
		if s.live(rec) && rec.Album != "" && rec.Kind != "livevideo" {
			counts[rec.Album]++
		}
	}
	s.mu.Unlock()
	type al struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	}
	out := []al{}
	for n, c := range counts {
		out = append(out, al{n, c})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	writeJSON(w, http.StatusOK, map[string]any{"albums": out})
}

// ---------- статистика ----------

func (s *server) handleStats(w http.ResponseWriter, r *http.Request) {
	type bucket struct {
		Key   string `json:"key"`
		Count int    `json:"count"`
		Bytes int64  `json:"bytes"`
	}
	byMonth := map[string]*bucket{}
	byKind := map[string]*bucket{}
	byDay := map[string]*bucket{}
	var total int
	var bytesTotal, biggest int64
	var biggestPath string
	var oldest, newest int64
	since := time.Now().AddDate(0, 0, -30).Unix()

	add := func(m map[string]*bucket, k string, sz int64) {
		b, ok := m[k]
		if !ok {
			b = &bucket{Key: k}
			m[k] = b
		}
		b.Count++
		b.Bytes += sz
	}

	s.mu.Lock()
	for _, rec := range s.byID {
		if !s.live(rec) {
			continue
		}
		total++
		bytesTotal += rec.Size
		d := rec.Date
		if d == 0 {
			d = rec.Time
		}
		if oldest == 0 || d < oldest {
			oldest = d
		}
		if d > newest {
			newest = d
		}
		if rec.Size > biggest {
			biggest, biggestPath = rec.Size, rec.Path
		}
		add(byMonth, time.Unix(d, 0).Format("2006-01"), rec.Size)
		k := rec.Kind
		if k == "" {
			k = "other"
		}
		add(byKind, k, rec.Size)
		if rec.Time >= since {
			add(byDay, time.Unix(rec.Time, 0).Format("2006-01-02"), rec.Size)
		}
	}
	s.mu.Unlock()

	flat := func(m map[string]*bucket) []bucket {
		out := make([]bucket, 0, len(m))
		for _, b := range m {
			out = append(out, *b)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
		return out
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"total": total, "bytes": bytesTotal,
		"oldest": oldest, "newest": newest,
		"biggest": biggest, "biggestPath": biggestPath,
		"byMonth": flat(byMonth), "byKind": flat(byKind), "uploadsByDay": flat(byDay),
	})
}

// ---------- корзина ----------

func (s *server) handleTrash(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		s.mu.Lock()
		list := []record{}
		for _, rec := range s.byID {
			if rec.Trashed > 0 && !rec.Purged {
				list = append(list, *rec)
			}
		}
		s.mu.Unlock()
		sort.Slice(list, func(i, j int) bool { return list[i].Trashed > list[j].Trashed })
		writeJSON(w, http.StatusOK, map[string]any{"items": list, "days": trashDays})
		return
	}
	if !needPost(w, r) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, rel := s.lookup(r)
	if rel == "" {
		fail(w, http.StatusNotFound, "нет такого файла")
		return
	}
	if rec == nil {
		// Файл попал на SSD не через ZALET — заводим запись, чтобы его можно было вернуть.
		fi, err := os.Stat(s.abs(rel))
		if err != nil {
			fail(w, http.StatusNotFound, "файл не найден")
			return
		}
		rec = &record{ID: "path:" + rel, Path: rel, Size: fi.Size(), Time: fi.ModTime().Unix(), Date: fi.ModTime().Unix()}
	}
	if rec.Trashed > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	dst := s.trashAbs(rec.Path)
	os.MkdirAll(filepath.Dir(dst), 0o755)
	if _, err := os.Stat(dst); err == nil {
		os.Remove(dst) // старая версия в корзине
	}
	if err := os.Rename(s.abs(rec.Path), dst); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	c := *rec
	c.Trashed = time.Now().Unix()
	s.put(&c)
	log.Printf("в корзину: %s", c.Path)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) handleTrashRestore(w http.ResponseWriter, r *http.Request) {
	if !needPost(w, r) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.byID[r.URL.Query().Get("id")]
	if !ok || rec.Trashed == 0 || rec.Purged {
		fail(w, http.StatusNotFound, "нет в корзине")
		return
	}
	rel := rec.Path
	if s.takenOnDisk(rel) {
		rel = s.uniquePath(rel, s.takenOnDisk)
	}
	os.MkdirAll(filepath.Dir(s.abs(rel)), 0o777)
	if err := os.Rename(s.trashAbs(rec.Path), s.abs(rel)); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	c := *rec
	c.Trashed = 0
	c.Path = rel
	s.put(&c)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": rel})
}

func (s *server) purge(rec *record) {
	os.Remove(s.trashAbs(rec.Path))
	os.Remove(s.thumbPath(rec.ID, rec.Path))
	c := *rec
	c.Purged = true
	c.Thumb = false
	s.put(&c)
}

func (s *server) handleTrashDelete(w http.ResponseWriter, r *http.Request) {
	if !needPost(w, r) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.byID[r.URL.Query().Get("id")]
	if !ok || rec.Trashed == 0 || rec.Purged {
		fail(w, http.StatusNotFound, "нет в корзине")
		return
	}
	s.purge(rec)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) handleTrashEmpty(w http.ResponseWriter, r *http.Request) {
	if !needPost(w, r) {
		return
	}
	s.mu.Lock()
	n := 0
	for _, rec := range s.byID {
		if rec.Trashed > 0 && !rec.Purged {
			s.purge(rec)
			n++
		}
	}
	s.mu.Unlock()
	log.Printf("корзина очищена: %d", n)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": n})
}

func (s *server) purgeLoop() {
	for {
		limit := time.Now().AddDate(0, 0, -trashDays).Unix()
		s.mu.Lock()
		for _, rec := range s.byID {
			if rec.Trashed > 0 && !rec.Purged && rec.Trashed < limit {
				s.purge(rec)
			}
		}
		s.mu.Unlock()
		time.Sleep(time.Hour)
	}
}
