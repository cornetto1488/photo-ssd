// Фото и SSD в панели: «В этот день», места съёмки (GPS из EXIF), файлы SSD с плеером и загрузкой.
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ---------- «В этот день» ----------

func (s *server) handleOnThisDay(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	type group struct {
		Year  int      `json:"year"`
		Ago   int      `json:"ago"`
		Items []record `json:"items"`
	}
	byYear := map[int][]record{}
	s.mu.Lock()
	for _, rec := range s.byID {
		if !s.live(rec) || rec.Date == 0 || rec.Kind == "livevideo" || rec.Kind == "screenshot" {
			continue
		}
		t := time.Unix(rec.Date, 0)
		if t.Month() == now.Month() && t.Day() == now.Day() && t.Year() < now.Year() {
			byYear[t.Year()] = append(byYear[t.Year()], *rec)
		}
	}
	s.mu.Unlock()
	var out []group
	for y, l := range byYear {
		sort.Slice(l, func(i, j int) bool { return l[i].Date < l[j].Date })
		if len(l) > 24 {
			l = l[:24]
		}
		out = append(out, group{y, now.Year() - y, l})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Year > out[j].Year })
	if out == nil {
		out = []group{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"days": out, "date": now.Format("2 January")})
}

// ---------- GPS из EXIF ----------

type gpsPoint struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

var gpsIdx = struct {
	sync.Mutex
	pts  map[string]*gpsPoint // id -> точка (nil = нет GPS)
	busy bool
	done int
}{pts: map[string]*gpsPoint{}}

// exifGPS ищет блок EXIF в начале файла (JPEG и HEIC) и читает координаты.
func exifGPS(path string) *gpsPoint {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	buf := make([]byte, 512<<10)
	n, _ := io.ReadFull(f, buf)
	buf = buf[:n]
	// В HEIC первая метка «Exif» — это имя раздела в оглавлении; сами данные — там, где после
	// «Exif\0\0» начинается заголовок TIFF (II* или MM*). Ищем именно такое место.
	var t []byte
	for off := 0; ; {
		i := bytes.Index(buf[off:], []byte("Exif\x00\x00"))
		if i < 0 {
			break
		}
		p := off + i + 6
		if p+4 <= len(buf) && (string(buf[p:p+2]) == "II" || string(buf[p:p+2]) == "MM") {
			t = buf[p:]
			break
		}
		off = p
	}
	if t == nil {
		return nil
	}
	if len(t) < 8 {
		return nil
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return nil
	}
	ifd := func(off uint32) map[uint16][]byte { // тег -> (тип, кол-во, значение/смещение)
		m := map[uint16][]byte{}
		if int(off)+2 > len(t) {
			return m
		}
		cnt := int(bo.Uint16(t[off:]))
		for k := 0; k < cnt; k++ {
			e := int(off) + 2 + k*12
			if e+12 > len(t) {
				break
			}
			m[bo.Uint16(t[e:])] = t[e : e+12]
		}
		return m
	}
	ifd0 := ifd(bo.Uint32(t[4:]))
	gp, ok := ifd0[0x8825]
	if !ok {
		return nil
	}
	g := ifd(bo.Uint32(gp[8:]))
	rational3 := func(e []byte) (float64, bool) {
		if e == nil {
			return 0, false
		}
		off := int(bo.Uint32(e[8:]))
		if off+24 > len(t) {
			return 0, false
		}
		v := 0.0
		for k := 0; k < 3; k++ {
			num, den := float64(bo.Uint32(t[off+k*8:])), float64(bo.Uint32(t[off+k*8+4:]))
			if den == 0 {
				return 0, false
			}
			v += num / den / math.Pow(60, float64(k))
		}
		return v, true
	}
	lat, ok1 := rational3(g[2])
	lon, ok2 := rational3(g[4])
	if !ok1 || !ok2 || (lat == 0 && lon == 0) {
		return nil
	}
	if r := g[1]; r != nil && r[8] == 'S' {
		lat = -lat
	}
	if r := g[3]; r != nil && r[8] == 'W' {
		lon = -lon
	}
	return &gpsPoint{math.Round(lat*1e5) / 1e5, math.Round(lon*1e5) / 1e5}
}

func (s *server) gpsPath() string { return s.meta("gps.json") }

// gpsLoop — потихоньку читает координаты всех фото (не мешая выгрузке) и запоминает.
func (s *server) gpsLoop() {
	if b, err := os.ReadFile(s.gpsPath()); err == nil {
		gpsIdx.Lock()
		json.Unmarshal(b, &gpsIdx.pts)
		gpsIdx.Unlock()
	}
	// v2: раньше координаты в HEIC не находились — один раз перечитываем HEIC без координат
	if _, err := os.Stat(s.meta("gps.v2")); err != nil {
		s.mu.Lock()
		gpsIdx.Lock()
		n := 0
		for id, pt := range gpsIdx.pts {
			if rec := s.byID[id]; pt == nil && rec != nil && strings.HasSuffix(strings.ToLower(rec.Path), ".heic") {
				delete(gpsIdx.pts, id)
				n++
			}
		}
		gpsIdx.Unlock()
		s.mu.Unlock()
		os.WriteFile(s.meta("gps.v2"), []byte("1"), 0o644)
		log.Printf("места съёмки: перечитываю %d фото HEIC", n)
	}
	for {
		var todo []record
		s.mu.Lock()
		gpsIdx.Lock()
		for id, rec := range s.byID {
			if _, ok := gpsIdx.pts[id]; !ok && s.live(rec) && (rec.Kind == "photo" || rec.Kind == "live" || rec.Kind == "") {
				todo = append(todo, *rec)
			}
		}
		gpsIdx.busy = len(todo) > 0
		gpsIdx.Unlock()
		s.mu.Unlock()
		for k, rec := range todo {
			pt := exifGPS(s.abs(rec.Path))
			gpsIdx.Lock()
			gpsIdx.pts[rec.ID] = pt
			gpsIdx.done++
			gpsIdx.Unlock()
			if k%200 == 199 {
				s.saveGPS()
			}
			time.Sleep(15 * time.Millisecond)
		}
		if len(todo) > 0 {
			s.saveGPS()
			log.Printf("места съёмки: обработано %d фото", len(todo))
		}
		gpsIdx.Lock()
		gpsIdx.busy = false
		gpsIdx.Unlock()
		time.Sleep(10 * time.Minute)
	}
}

func (s *server) saveGPS() {
	gpsIdx.Lock()
	b, _ := json.Marshal(gpsIdx.pts)
	gpsIdx.Unlock()
	os.WriteFile(s.gpsPath(), b, 0o644)
}

// названия мест (город) — у OpenStreetMap, один раз на клетку ~10 км
var placeNames = struct {
	sync.Mutex
	m map[string]string
}{m: map[string]string{}}

func (s *server) placeName(lat, lon float64) string {
	key := fmt.Sprintf("%.1f,%.1f", lat, lon)
	placeNames.Lock()
	if len(placeNames.m) == 0 {
		if b, err := os.ReadFile(s.meta("places.json")); err == nil {
			json.Unmarshal(b, &placeNames.m)
		}
	}
	if v, ok := placeNames.m[key]; ok {
		placeNames.Unlock()
		return v
	}
	placeNames.Unlock()
	u := fmt.Sprintf("https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&accept-language=ru&lat=%f&lon=%f", lat, lon)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "ZALET-HOME/3.6 (home router photo map)")
	c := &http.Client{Timeout: 8 * time.Second}
	name := ""
	if resp, err := c.Do(req); err == nil {
		var j struct {
			Address map[string]string `json:"address"`
		}
		json.NewDecoder(resp.Body).Decode(&j)
		resp.Body.Close()
		for _, k := range []string{"city", "town", "village", "municipality", "county", "state"} {
			if v := j.Address[k]; v != "" {
				name = v
				break
			}
		}
		if cc := j.Address["country"]; cc != "" && cc != "Россия" && name != "" {
			name += ", " + cc
		}
	}
	placeNames.Lock()
	placeNames.m[key] = name
	b, _ := json.Marshal(placeNames.m)
	placeNames.Unlock()
	os.WriteFile(s.meta("places.json"), b, 0o644)
	time.Sleep(1100 * time.Millisecond) // правила Nominatim: не чаще раза в секунду
	return name
}

// клетка ~10 км: по ней группируются места и запрашиваются названия
func cellKey(lat, lon float64) string { return fmt.Sprintf("%.1f,%.1f", lat, lon) }

var namesBusy sync.Mutex

// resolveNames — в фоне узнаёт названия для клеток без названия (не тормозит страницу).
func (s *server) resolveNames(cells []gpsPoint) {
	if !namesBusy.TryLock() {
		return
	}
	defer namesBusy.Unlock()
	for _, c := range cells {
		s.placeName(c.Lat, c.Lon)
	}
}

type placeOut struct {
	Key   string  `json:"key"` // клетки через «|»
	Name  string  `json:"name"`
	Lat   float64 `json:"lat"`
	Lon   float64 `json:"lon"`
	Count int     `json:"count"`
	Cover string  `json:"cover"`
	From  int64   `json:"from"`
	To    int64   `json:"to"`
}

// places — места с фото: клетки ~10 км, одинаковые названия (город) объединены.
func (s *server) places() ([]placeOut, map[string]string, bool, int) {
	type cell struct {
		lat, lon float64
		n        int
		cover    string
		from, to int64
	}
	cells := map[string]*cell{}
	cellOf := map[string]string{} // id -> клетка
	s.mu.Lock()
	gpsIdx.Lock()
	for id, g := range gpsIdx.pts {
		rec := s.byID[id]
		if g == nil || rec == nil || !s.live(rec) {
			continue
		}
		k := cellKey(g.Lat, g.Lon)
		cellOf[id] = k
		c := cells[k]
		if c == nil {
			c = &cell{lat: g.Lat, lon: g.Lon, cover: id, from: rec.Date, to: rec.Date}
			cells[k] = c
		}
		c.n++
		if rec.Date < c.from {
			c.from = rec.Date
		}
		if rec.Date > c.to {
			c.to, c.cover = rec.Date, id
		}
	}
	busy, done := gpsIdx.busy, gpsIdx.done
	gpsIdx.Unlock()
	s.mu.Unlock()
	placeNames.Lock()
	if len(placeNames.m) == 0 {
		if b, err := os.ReadFile(s.meta("places.json")); err == nil {
			json.Unmarshal(b, &placeNames.m)
		}
	}
	names := map[string]string{}
	for k := range cells {
		names[k] = placeNames.m[k]
	}
	placeNames.Unlock()
	// объединяем клетки с одинаковым названием
	merged := map[string]*placeOut{}
	var order []string
	keys := make([]string, 0, len(cells))
	for k := range cells {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return cells[keys[i]].n > cells[keys[j]].n })
	for _, k := range keys {
		c := cells[k]
		group := names[k]
		if group == "" {
			group = "#" + k
		}
		p := merged[group]
		if p == nil {
			p = &placeOut{Key: k, Name: names[k], Lat: c.lat, Lon: c.lon, Cover: c.cover, From: c.from, To: c.to}
			merged[group] = p
			order = append(order, group)
		} else {
			p.Key += "|" + k
		}
		p.Count += c.n
		if c.from < p.From {
			p.From = c.from
		}
		if c.to > p.To {
			p.To, p.Cover = c.to, c.cover
		}
	}
	out := make([]placeOut, 0, len(order))
	for _, g := range order {
		out = append(out, *merged[g])
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	// названия для крупных безымянных клеток — в фоне
	var need []gpsPoint
	for _, k := range keys {
		if _, ok := placeNames.m[k]; !ok && len(need) < 40 {
			need = append(need, gpsPoint{cells[k].lat, cells[k].lon})
		}
	}
	if len(need) > 0 {
		go s.resolveNames(need)
	}
	return out, cellOf, busy, done
}

// GET /api/home/places — точки для карты и список мест.
func (s *server) handlePlaces(w http.ResponseWriter, r *http.Request) {
	places, cellOf, busy, done := s.places()
	// какой клетке какое место
	placeOfCell := map[string]int{}
	for i, p := range places {
		for _, k := range strings.Split(p.Key, "|") {
			placeOfCell[k] = i
		}
	}
	type pt struct {
		ID    string  `json:"id"`
		Lat   float64 `json:"lat"`
		Lon   float64 `json:"lon"`
		Date  int64   `json:"date"`
		Path  string  `json:"path"`
		Kind  string  `json:"kind"`
		Size  int64   `json:"size"`
		Place int     `json:"place"`
	}
	pts := []pt{}
	s.mu.Lock()
	gpsIdx.Lock()
	for id, k := range cellOf {
		g, rec := gpsIdx.pts[id], s.byID[id]
		if g == nil || rec == nil {
			continue
		}
		pts = append(pts, pt{id, g.Lat, g.Lon, rec.Date, rec.Path, rec.Kind, rec.Size, placeOfCell[k]})
	}
	gpsIdx.Unlock()
	s.mu.Unlock()
	sort.Slice(pts, func(i, j int) bool { return pts[i].Date > pts[j].Date })
	writeJSON(w, http.StatusOK, map[string]any{"points": pts, "places": places, "indexing": busy, "scanned": done})
}

// GET /api/home/place?key=55.0,73.4|55.0,73.3 — фото, снятые в этом месте.
func (s *server) handlePlaceItems(w http.ResponseWriter, r *http.Request) {
	want := map[string]bool{}
	for _, k := range strings.Split(r.URL.Query().Get("key"), "|") {
		want[k] = true
	}
	var list []record
	s.mu.Lock()
	gpsIdx.Lock()
	for id, g := range gpsIdx.pts {
		if g == nil || !want[cellKey(g.Lat, g.Lon)] {
			continue
		}
		if rec := s.byID[id]; rec != nil && s.live(rec) {
			list = append(list, *rec)
		}
	}
	gpsIdx.Unlock()
	s.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].Date > list[j].Date })
	if list == nil {
		list = []record{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list, "total": len(list)})
}

// GET /api/home/albums — умные альбомы: все фото, по годам, по видам, места, альбомы приложений.
func (s *server) handleSmartAlbums(w http.ResponseWriter, r *http.Request) {
	type album struct {
		Type  string `json:"type"` // all, year, kind, place, app
		Name  string `json:"name"`
		Value string `json:"value"`
		Count int    `json:"count"`
		Cover string `json:"cover"`
		Sub   string `json:"sub,omitempty"`
	}
	type acc struct {
		n     int
		cover string
		last  int64
	}
	years, kinds, apps := map[string]*acc{}, map[string]*acc{}, map[string]*acc{}
	all := &acc{}
	add := func(m map[string]*acc, k string, rec *record, d int64) {
		a := m[k]
		if a == nil {
			a = &acc{}
			m[k] = a
		}
		a.n++
		if d >= a.last {
			a.last, a.cover = d, rec.ID
		}
	}
	s.mu.Lock()
	for _, rec := range s.byID {
		if !s.live(rec) || rec.Kind == "livevideo" {
			continue
		}
		d := rec.Date
		if d == 0 {
			d = rec.Time
		}
		if rec.Kind != "screenshot" {
			all.n++
			if d >= all.last {
				all.last, all.cover = d, rec.ID
			}
			add(years, fmt.Sprint(time.Unix(d, 0).Year()), rec, d)
		}
		kind := rec.Kind
		if kind == "" {
			kind = "photo"
		}
		add(kinds, kind, rec, d)
		if rec.Album != "" {
			add(apps, rec.Album, rec, d)
		}
	}
	s.mu.Unlock()
	out := []album{{Type: "all", Name: "Все фото и видео", Count: all.n, Cover: all.cover}}
	ys := make([]string, 0, len(years))
	for y := range years {
		ys = append(ys, y)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(ys)))
	for _, y := range ys {
		if years[y].n >= 3 && y >= "2005" {
			out = append(out, album{Type: "year", Name: y, Value: y, Count: years[y].n, Cover: years[y].cover})
		}
	}
	kindNames := map[string]string{"photo": "Фото", "video": "Видео", "live": "Live Photos", "screenshot": "Скриншоты"}
	for _, k := range []string{"video", "live", "screenshot", "photo"} {
		if a := kinds[k]; a != nil {
			out = append(out, album{Type: "kind", Name: kindNames[k], Value: k, Count: a.n, Cover: a.cover})
		}
	}
	places, _, _, _ := s.places()
	for i, p := range places {
		if i >= 12 || p.Name == "" {
			continue
		}
		out = append(out, album{Type: "place", Name: p.Name, Value: p.Key, Count: p.Count, Cover: p.Cover})
	}
	as := make([]string, 0, len(apps))
	for a := range apps {
		as = append(as, a)
	}
	sort.Slice(as, func(i, j int) bool { return apps[as[i]].n > apps[as[j]].n })
	for _, a := range as {
		out = append(out, album{Type: "app", Name: a, Value: a, Count: apps[a].n, Cover: apps[a].cover})
	}
	writeJSON(w, http.StatusOK, map[string]any{"albums": out})
}

// ---------- файлы SSD: обзор, плеер, загрузка ----------

// statfs — свободно и всего на диске, байты.
func statfs(path string) ([2]uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return [2]uint64{}, err
	}
	return [2]uint64{st.Bavail * uint64(st.Bsize), st.Blocks * uint64(st.Bsize)}, nil
}

// ssdRoot — корень SSD (папка над Photos).
func (s *server) ssdRoot() string { return filepath.Dir(s.root) }

// ssdPath — безопасный путь внутри SSD (без выхода наверх и служебных папок).
func (s *server) ssdPath(rel string) (string, error) {
	rel = strings.TrimPrefix(filepath.ToSlash(filepath.Clean("/"+rel)), "/")
	for _, part := range strings.Split(rel, "/") {
		if strings.HasPrefix(part, ".") {
			return "", fmt.Errorf("служебная папка")
		}
	}
	return filepath.Join(s.ssdRoot(), filepath.FromSlash(rel)), nil
}

var mediaExt = map[string]string{".mp4": "video", ".m4v": "video", ".mov": "video", ".mkv": "video", ".webm": "video", ".avi": "video",
	".mp3": "audio", ".m4a": "audio", ".flac": "audio", ".ogg": "audio", ".wav": "audio", ".aac": "audio",
	".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image", ".webp": "image", ".heic": "image",
	".pdf": "doc", ".txt": "doc", ".srt": "sub", ".vtt": "sub"}

func (s *server) handleFiles(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("dir")
	dir, err := s.ssdPath(rel)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if r.Method == http.MethodPost {
		var req struct {
			Action string `json:"action"` // mkdir, delete, rename
			Name   string `json:"name"`
			To     string `json:"to"`
		}
		json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req)
		name := filepath.Base(strings.TrimSpace(req.Name))
		if name == "." || name == "/" || name == "" || strings.HasPrefix(name, ".") {
			fail(w, http.StatusBadRequest, "неверное имя")
			return
		}
		target := filepath.Join(dir, name)
		if filepath.Clean(target) == filepath.Clean(s.root) {
			fail(w, http.StatusBadRequest, "папку с фото ZALET здесь менять нельзя")
			return
		}
		switch req.Action {
		case "mkdir":
			err = os.MkdirAll(target, 0o755)
		case "rename":
			to := filepath.Base(strings.TrimSpace(req.To))
			if to == "" || strings.HasPrefix(to, ".") {
				fail(w, http.StatusBadRequest, "неверное имя")
				return
			}
			err = os.Rename(target, filepath.Join(dir, to))
		case "delete": // в корзину SSD, а не насовсем
			trash := filepath.Join(s.ssdRoot(), ".trash-zalet", time.Now().Format("2006-01-02"))
			os.MkdirAll(trash, 0o755)
			err = os.Rename(target, filepath.Join(trash, fmt.Sprintf("%d-%s", time.Now().Unix(), name)))
		}
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		log.Printf("файлы SSD: %s %s (%s)", req.Action, filepath.Join(rel, name), clientIP(r))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		fail(w, http.StatusNotFound, "папка не найдена")
		return
	}
	type fe struct {
		Name  string `json:"name"`
		Dir   bool   `json:"dir"`
		Size  int64  `json:"size"`
		Mtime int64  `json:"mtime"`
		Type  string `json:"type"`
	}
	list := []fe{}
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), ".") || e.Name() == "lost+found" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		list = append(list, fe{e.Name(), e.IsDir(), info.Size(), info.ModTime().Unix(), mediaExt[strings.ToLower(filepath.Ext(e.Name()))]})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Dir != list[j].Dir {
			return list[i].Dir
		}
		return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
	})
	var free, total uint64
	if st, err := statfs(s.ssdRoot()); err == nil {
		free, total = st[0], st[1]
	}
	writeJSON(w, http.StatusOK, map[string]any{"dir": strings.Trim(filepath.ToSlash(rel), "/"), "items": list, "free": free, "total": total})
}

// GET /api/home/files/get?path= — отдать файл (с поддержкой перемотки видео).
func (s *server) handleFileGet(w http.ResponseWriter, r *http.Request) {
	p, err := s.ssdPath(r.URL.Query().Get("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		fail(w, http.StatusNotFound, "файл не найден")
		return
	}
	ext := strings.ToLower(filepath.Ext(p))
	if ext == ".srt" && r.URL.Query().Get("vtt") == "1" { // субтитры для браузерного плеера
		b, _ := os.ReadFile(p)
		t := strings.ReplaceAll(string(b), "\r", "")
		var out strings.Builder
		out.WriteString("WEBVTT\n\n")
		for _, l := range strings.Split(t, "\n") {
			if strings.Contains(l, "-->") {
				l = strings.ReplaceAll(l, ",", ".")
			}
			out.WriteString(l + "\n")
		}
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
		io.WriteString(w, out.String())
		return
	}
	if r.URL.Query().Get("dl") == "1" {
		w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(st.Name()))
	}
	f, err := os.Open(p)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer f.Close()
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

// POST /api/home/files/upload?dir=&name= — загрузка файла потоком (хоть фильм на 30 ГБ).
func (s *server) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	if !needPost(w, r) {
		return
	}
	dir, err := s.ssdPath(r.URL.Query().Get("dir"))
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	name := filepath.Base(strings.TrimSpace(r.URL.Query().Get("name")))
	if name == "" || name == "." || strings.HasPrefix(name, ".") {
		fail(w, http.StatusBadRequest, "неверное имя файла")
		return
	}
	if filepath.Clean(dir) == filepath.Clean(s.root) || strings.HasPrefix(filepath.Clean(dir), filepath.Clean(s.root)+string(os.PathSeparator)) {
		fail(w, http.StatusBadRequest, "в папку фото ZALET загружает приложение — выберите другую папку")
		return
	}
	os.MkdirAll(dir, 0o755)
	dst := filepath.Join(dir, name)
	if _, err := os.Stat(dst); err == nil {
		ext := filepath.Ext(name)
		dst = filepath.Join(dir, strings.TrimSuffix(name, ext)+fmt.Sprintf(" (%s)", time.Now().Format("150405"))+ext)
	}
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	n, err := io.Copy(f, r.Body)
	f.Close()
	if err != nil {
		os.Remove(tmp)
		fail(w, http.StatusBadRequest, "загрузка прервалась")
		return
	}
	os.Rename(tmp, dst)
	log.Printf("файлы SSD: загружен %s (%d байт, %s)", dst, n, clientIP(r))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": filepath.Base(dst), "size": n})
}
