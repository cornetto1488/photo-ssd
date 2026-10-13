// Карта уборки Dreame: скачивание, расшифровка и разбор в компактный JSON для рисования в панели.
// Формат — по открытой интеграции Tasshack/dreame-vacuum (map.py).
package main

import (
	"bytes"
	"compress/zlib"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// IV для расшифровки карт зависит от модели (таблица устройств интеграции).
var dreameMapIV = map[string]string{"r5021a": "NRwnBj5FsNPgBNbT"}

type dreamePath struct {
	T string    `json:"t"` // S — пылесос, W — швабра, M — оба
	P []float64 `json:"p"` // x0,y0,x1,y1… в клетках карты
}

type dreameRoom struct {
	ID    int     `json:"id"`
	Cells int     `json:"cells"`
	Area  float64 `json:"area"` // м²
	CX    float64 `json:"cx"`
	CY    float64 `json:"cy"`
}

type dreameMapOut struct {
	W       int          `json:"w"`
	H       int          `json:"h"`
	Grid    int          `json:"grid"`  // мм на клетку
	Cells   string       `json:"cells"` // base64: 0 снаружи, 1..60 комната, 99 пол без комнаты, 255 стена
	Robot   *[2]float64  `json:"robot,omitempty"`
	Charger *[2]float64  `json:"charger,omitempty"`
	Paths   []dreamePath `json:"paths"`
	Rooms   []dreameRoom `json:"rooms"`
	Time    int64        `json:"t"`
	Area    int          `json:"area"`
	Min     int          `json:"min"`
}

var (
	dreameMapMu    sync.Mutex
	dreameMapCache = map[string]*dreameMapOut{}
	pathRe         = regexp.MustCompile(`([MWSLl])(-?\d+),(-?\d+)`)
)

func decodeDreameMap(content, key, model string) (*dreameMapOut, error) {
	s := strings.NewReplacer("_", "/", "-", "+").Replace(strings.TrimSpace(content))
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
		if err != nil {
			return nil, fmt.Errorf("карта: не base64")
		}
	}
	if key != "" {
		short := model[strings.LastIndex(model, ".")+1:]
		iv := dreameMapIV[short]
		if iv == "" {
			return nil, fmt.Errorf("карта зашифрована, для модели %s нет ключа", short)
		}
		sum := sha256.Sum256([]byte(key))
		k := []byte(hex.EncodeToString(sum[:])[:32])
		blk, err := aes.NewCipher(k)
		if err != nil || len(raw)%16 != 0 {
			return nil, fmt.Errorf("карта: ошибка расшифровки")
		}
		out := make([]byte, len(raw))
		cipher.NewCBCDecrypter(blk, []byte(iv)).CryptBlocks(out, raw)
		raw = out
	}
	zr, err := zlib.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("карта: не сжата zlib")
	}
	data, err := io.ReadAll(io.LimitReader(zr, 16<<20))
	if err != nil || len(data) < 27 {
		return nil, fmt.Errorf("карта: повреждена")
	}
	i16 := func(o int) int { return int(int16(binary.LittleEndian.Uint16(data[o:]))) }
	grid, w, h := i16(17), i16(19), i16(21)
	left, top := i16(23), i16(25)
	if w <= 0 || h <= 0 || grid <= 0 || 27+w*h > len(data) {
		return nil, fmt.Errorf("карта: странные размеры")
	}
	var js map[string]any
	json.Unmarshal(data[27+w*h:], &js)
	if o, ok := js["origin"].([]any); ok && len(o) > 1 {
		left, top = num(o[0]), num(o[1])
	}
	frameMap := num(js["fsm"]) == 1
	pix := data[27 : 27+w*h]
	cells := make([]byte, w*h)
	type acc struct {
		n      int
		sx, sy float64
	}
	rooms := map[int]*acc{}
	for i, p := range pix {
		var c byte
		if frameMap {
			id := int(p >> 2)
			switch {
			case id == 63:
				c = 255
			case id == 62:
				c = 99
			case id == 61:
				c = 0
			case id > 0 && id < 61:
				c = byte(id)
			default:
				switch p & 3 {
				case 1, 3:
					c = 99
				case 2:
					c = 255
				}
			}
		} else {
			seg := int(p & 0x1F)
			wall := (p >> 5) & 3
			switch {
			case seg == 0:
				c = 0
			case wall > 0:
				c = 255
			case seg == 31:
				c = 99
			default:
				c = byte(seg)
			}
		}
		cells[i] = c
		if c > 0 && c < 99 {
			a := rooms[int(c)]
			if a == nil {
				a = &acc{}
				rooms[int(c)] = a
			}
			a.n++
			a.sx += float64(i % w)
			a.sy += float64(i / w)
		}
	}
	px := func(x, y float64) [2]float64 {
		return [2]float64{math.Round((x-float64(left))/float64(grid)*10) / 10, math.Round((y-float64(top))/float64(grid)*10) / 10}
	}
	out := &dreameMapOut{W: w, H: h, Grid: grid, Cells: base64.StdEncoding.EncodeToString(cells), Paths: []dreamePath{}, Rooms: []dreameRoom{}}
	if r, ok := js["robot"].([]any); ok && len(r) > 1 {
		v := px(float64(num(r[0])), float64(num(r[1])))
		out.Robot = &v
	}
	if r, ok := js["charger"].([]any); ok && len(r) > 1 {
		v := px(float64(num(r[0])), float64(num(r[1])))
		out.Charger = &v
	}
	if tr, _ := js["tr"].(string); tr != "" {
		cx, cy := 0, 0
		var cur *dreamePath
		for _, m := range pathRe.FindAllStringSubmatch(tr, -1) {
			x, _ := strconv.Atoi(m[2])
			y, _ := strconv.Atoi(m[3])
			op := m[1]
			if op == "L" || op == "l" {
				cx, cy = cx+x, cy+y
			} else {
				cx, cy = x, y
				out.Paths = append(out.Paths, dreamePath{T: op})
				cur = &out.Paths[len(out.Paths)-1]
			}
			if cur == nil {
				out.Paths = append(out.Paths, dreamePath{T: "S"})
				cur = &out.Paths[len(out.Paths)-1]
			}
			v := px(float64(cx), float64(cy))
			cur.P = append(cur.P, v[0], v[1])
		}
	}
	cellM2 := float64(grid) * float64(grid) / 1e6
	for id, a := range rooms {
		out.Rooms = append(out.Rooms, dreameRoom{ID: id, Cells: a.n, Area: math.Round(float64(a.n)*cellM2*10) / 10, CX: a.sx / float64(a.n), CY: a.sy / float64(a.n)})
	}
	out.Area, out.Min = num(js["cs"]), num(js["ct"])
	out.Time = int64(num(js["sd"]))
	return out, nil
}

// GET /api/home/dreame/map?i=0 — карта i-й (0 — последней) уборки.
func (p *homePortal) handleDreameMap(w http.ResponseWriter, r *http.Request) {
	dreameLoad()
	i, _ := strconv.Atoi(r.URL.Query().Get("i"))
	c := dreame
	c.mu.Lock()
	have := c.hist != nil
	c.mu.Unlock()
	if !have {
		p.handleDreameHistory(httptest.NewRecorder(), r)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cf.User == "" {
		fail(w, http.StatusConflict, "Dreame не подключён")
		return
	}
	if c.hist == nil || i < 0 || i >= len(c.hist) {
		fail(w, http.StatusNotFound, "нет такой уборки")
		return
	}
	f, _ := c.hist[i]["file"].(string)
	dreameMapMu.Lock()
	cached := dreameMapCache[f]
	dreameMapMu.Unlock()
	if cached == nil {
		content, key, err := c.mapFile(f)
		if err != nil {
			fail(w, http.StatusBadGateway, err.Error())
			return
		}
		cached, err = decodeDreameMap(content, key, c.model)
		if err != nil {
			fail(w, http.StatusBadGateway, err.Error())
			return
		}
		if t, ok := c.hist[i]["t"].(int); ok && cached.Time == 0 {
			cached.Time = int64(t)
		}
		dreameMapMu.Lock()
		if len(dreameMapCache) > 8 {
			dreameMapCache = map[string]*dreameMapOut{}
		}
		dreameMapCache[f] = cached
		dreameMapMu.Unlock()
	}
	w.Header().Set("Cache-Control", "private, max-age=300")
	writeJSON(w, http.StatusOK, cached)
}

const dreameRoomsFile = "/mnt/ssd/.router/dreame_rooms.json"

// GET/POST /api/home/dreame/rooms — названия комнат (id -> имя), хранятся на роутере.
func (p *homePortal) handleDreameRooms(w http.ResponseWriter, r *http.Request) {
	dreameMapMu.Lock()
	defer dreameMapMu.Unlock()
	if r.Method == http.MethodPost {
		b, err := io.ReadAll(io.LimitReader(r.Body, 8<<10))
		var m map[string]string
		if err != nil || json.Unmarshal(b, &m) != nil {
			fail(w, http.StatusBadRequest, "некорректные названия")
			return
		}
		if os.WriteFile(dreameRoomsFile, b, 0o644) != nil {
			fail(w, http.StatusInternalServerError, "не удалось сохранить")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	b, err := os.ReadFile(dreameRoomsFile)
	if err != nil || !json.Valid(b) {
		b = []byte("{}")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(b)
}
