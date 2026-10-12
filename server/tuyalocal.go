// Локальное управление устройствами Tuya по домашней сети (протоколы 3.3 / 3.4 / 3.5) — без облака и квот.
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net"
	"strconv"
	"sync"
	"time"
)

const (
	cmdSessStart  = 3
	cmdSessResp   = 4
	cmdSessFinish = 5
	cmdControl    = 7
	cmdStatus     = 8
	cmdHeartbeat  = 9
	cmdDPQuery    = 10
	cmdControlNew = 13
	cmdDPQueryNew = 16
)

var (
	prefix55 = []byte{0x00, 0x00, 0x55, 0xAA}
	suffix55 = []byte{0x00, 0x00, 0xAA, 0x55}
	prefix66 = []byte{0x00, 0x00, 0x66, 0x99}
	suffix66 = []byte{0x00, 0x00, 0x99, 0x66}
)

type localDev struct {
	ID      string // devId
	Key     []byte // local_key
	IP      string
	Version string // "3.3", "3.4", "3.5"
	GwID    string // для под-устройств: id шлюза
	NodeID  string // для под-устройств: cid
}

// ---------- AES ----------

func pkcs7(b []byte) []byte {
	n := 16 - len(b)%16
	return append(b, bytes.Repeat([]byte{byte(n)}, n)...)
}
func unpkcs7(b []byte) []byte {
	if len(b) == 0 {
		return b
	}
	n := int(b[len(b)-1])
	if n == 0 || n > 16 || n > len(b) {
		return b
	}
	return b[:len(b)-n]
}
func ecbEnc(key, b []byte) []byte {
	c, _ := aes.NewCipher(key)
	b = pkcs7(append([]byte{}, b...))
	out := make([]byte, len(b))
	for i := 0; i < len(b); i += 16 {
		c.Encrypt(out[i:i+16], b[i:i+16])
	}
	return out
}
func ecbEncRaw(key, b []byte) []byte { // без дополнения (длина кратна 16)
	c, _ := aes.NewCipher(key)
	out := make([]byte, len(b))
	for i := 0; i+16 <= len(b); i += 16 {
		c.Encrypt(out[i:i+16], b[i:i+16])
	}
	return out
}
func ecbDec(key, b []byte) ([]byte, error) {
	if len(b)%16 != 0 || len(b) == 0 {
		return nil, errors.New("неверная длина шифротекста")
	}
	c, _ := aes.NewCipher(key)
	out := make([]byte, len(b))
	for i := 0; i < len(b); i += 16 {
		c.Decrypt(out[i:i+16], b[i:i+16])
	}
	return unpkcs7(out), nil
}
func hmac256(key, b []byte) []byte { m := hmac.New(sha256.New, key); m.Write(b); return m.Sum(nil) }

// ---------- соединение ----------

type tuyaConn struct {
	d       *localDev
	c       net.Conn
	seq     uint32
	sessKey []byte
}

func dialTuya(d *localDev, timeout time.Duration) (*tuyaConn, error) {
	c, err := net.DialTimeout("tcp", net.JoinHostPort(d.IP, "6668"), timeout)
	if err != nil {
		return nil, err
	}
	tc := &tuyaConn{d: d, c: c, sessKey: d.Key}
	if d.Version == "3.4" || d.Version == "3.5" {
		if err := tc.negotiate(); err != nil {
			c.Close()
			return nil, fmt.Errorf("согласование ключа: %w", err)
		}
	}
	return tc, nil
}

func (t *tuyaConn) Close() { t.c.Close() }

// pack собирает кадр. Для 3.4 — HMAC вместо CRC, для 3.5 — AES-GCM и префикс 6699.
func (t *tuyaConn) pack(cmd uint32, payload []byte) []byte {
	t.seq++
	v := t.d.Version
	key := t.sessKey
	if v == "3.5" {
		iv := make([]byte, 12)
		rand.Read(iv)
		hdr := make([]byte, 0, 18)
		hdr = append(hdr, 0, 0) // unknown
		hdr = binary.BigEndian.AppendUint32(hdr, t.seq)
		hdr = binary.BigEndian.AppendUint32(hdr, cmd)
		hdr = binary.BigEndian.AppendUint32(hdr, uint32(12+len(payload)+16))
		blk, _ := aes.NewCipher(key)
		gcm, _ := cipher.NewGCM(blk)
		sealed := gcm.Seal(nil, iv, payload, hdr) // шифротекст + тег
		out := append([]byte{}, prefix66...)
		out = append(out, hdr...)
		out = append(out, iv...)
		out = append(out, sealed...)
		return append(out, suffix66...)
	}
	var enc []byte
	switch v {
	case "3.4":
		enc = ecbEnc(key, payload)
	default:
		enc = payload // для 3.3 шифрование делает вызывающий
	}
	tail := 4
	if v == "3.4" {
		tail = 32
	}
	buf := append([]byte{}, prefix55...)
	buf = binary.BigEndian.AppendUint32(buf, t.seq)
	buf = binary.BigEndian.AppendUint32(buf, cmd)
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(enc)+tail+4))
	buf = append(buf, enc...)
	if v == "3.4" {
		buf = append(buf, hmac256(key, buf)...)
	} else {
		buf = binary.BigEndian.AppendUint32(buf, crc32.ChecksumIEEE(buf))
	}
	return append(buf, suffix55...)
}

type frame struct {
	cmd     uint32
	payload []byte // уже расшифровано (для 3.4/3.5) или как есть (3.3)
}

func (t *tuyaConn) read(deadline time.Time) (*frame, error) {
	t.c.SetReadDeadline(deadline)
	hdr := make([]byte, 4)
	if _, err := io.ReadFull(t.c, hdr); err != nil {
		return nil, err
	}
	if bytes.Equal(hdr, prefix66) {
		h := make([]byte, 14)
		if _, err := io.ReadFull(t.c, h); err != nil {
			return nil, err
		}
		cmd := binary.BigEndian.Uint32(h[6:10])
		n := binary.BigEndian.Uint32(h[10:14])
		body := make([]byte, n+4)
		if _, err := io.ReadFull(t.c, body); err != nil {
			return nil, err
		}
		iv, sealed := body[:12], body[12:n]
		blk, _ := aes.NewCipher(t.sessKey)
		gcm, _ := cipher.NewGCM(blk)
		aad := h // 2 + seq + cmd + len
		plain, err := gcm.Open(nil, iv, sealed, aad)
		if err != nil {
			return nil, err
		}
		if len(plain) >= 4 { // код возврата
			plain = plain[4:]
		}
		return &frame{cmd: cmd, payload: plain}, nil
	}
	if !bytes.Equal(hdr, prefix55) {
		return nil, errors.New("неизвестный кадр")
	}
	h := make([]byte, 12)
	if _, err := io.ReadFull(t.c, h); err != nil {
		return nil, err
	}
	cmd := binary.BigEndian.Uint32(h[4:8])
	n := binary.BigEndian.Uint32(h[8:12])
	if n > 64<<10 {
		return nil, errors.New("слишком большой кадр")
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(t.c, body); err != nil {
		return nil, err
	}
	tail := 8 // crc + suffix
	if t.d.Version == "3.4" {
		tail = 36
	}
	if int(n) < tail {
		return &frame{cmd: cmd}, nil
	}
	data := body[:int(n)-tail]
	if len(data) >= 4 && t.d.Version != "3.4" { // у 3.3 ответа впереди код возврата
		rc := binary.BigEndian.Uint32(data[:4])
		if rc == 0 || rc == 1 {
			data = data[4:]
		}
	}
	if t.d.Version == "3.4" {
		dec, err := ecbDec(t.sessKey, data)
		if err != nil {
			return nil, err
		}
		if len(dec) >= 4 && cmd != cmdSessResp {
			rc := binary.BigEndian.Uint32(dec[:4])
			if rc == 0 || rc == 1 {
				dec = dec[4:]
			}
		}
		data = dec
	}
	return &frame{cmd: cmd, payload: data}, nil
}

func (t *tuyaConn) negotiate() error {
	local := make([]byte, 16)
	rand.Read(local)
	t.sessKey = t.d.Key
	if _, err := t.c.Write(t.pack(cmdSessStart, local)); err != nil {
		return err
	}
	var remote []byte
	for {
		f, err := t.read(time.Now().Add(4 * time.Second))
		if err != nil {
			return err
		}
		if f.cmd == cmdSessResp {
			p := f.payload
			if t.d.Version == "3.5" && len(p) >= 16 {
				remote = p[:16]
			} else if len(p) >= 16 {
				remote = p[:16]
			}
			break
		}
	}
	if len(remote) != 16 {
		return errors.New("нет ответа на согласование")
	}
	if _, err := t.c.Write(t.pack(cmdSessFinish, hmac256(t.d.Key, remote))); err != nil {
		return err
	}
	x := make([]byte, 16)
	for i := range x {
		x[i] = local[i] ^ remote[i]
	}
	if t.d.Version == "3.5" {
		blk, _ := aes.NewCipher(t.d.Key)
		gcm, _ := cipher.NewGCM(blk)
		sealed := gcm.Seal(nil, local[:12], x, nil)
		t.sessKey = sealed[:16]
	} else {
		t.sessKey = ecbEncRaw(t.d.Key, x)[:16]
	}
	return nil
}

func (t *tuyaConn) jsonCmd(cmd uint32, body map[string]any) error {
	raw, _ := json.Marshal(body)
	var payload []byte
	switch t.d.Version {
	case "3.3":
		enc := ecbEnc(t.d.Key, raw)
		if cmd == cmdDPQuery {
			payload = enc
		} else {
			payload = append(append([]byte("3.3"), make([]byte, 12)...), enc...)
		}
	default: // 3.4 / 3.5: заголовок версии внутри шифрования (кроме запросов)
		if cmd == cmdDPQuery || cmd == cmdDPQueryNew || cmd == cmdHeartbeat {
			payload = raw
		} else {
			payload = append(append([]byte(t.d.Version), make([]byte, 12)...), raw...)
		}
	}
	_, err := t.c.Write(t.pack(cmd, payload))
	return err
}

// decodeDPS вынимает {"dps":{...}} из ответа.
func (t *tuyaConn) decodeDPS(f *frame) (map[string]any, error) {
	p := f.payload
	if t.d.Version == "3.3" && len(p) > 0 {
		if bytes.HasPrefix(p, []byte("3.3")) && len(p) > 15 {
			p = p[15:]
		}
		dec, err := ecbDec(t.d.Key, p)
		if err != nil {
			return nil, err
		}
		p = dec
	} else if len(p) > 15 && (bytes.HasPrefix(p, []byte("3.4")) || bytes.HasPrefix(p, []byte("3.5"))) {
		p = p[15:]
	}
	var out struct {
		DPS  map[string]any `json:"dps"`
		Data struct {
			DPS map[string]any `json:"dps"`
		} `json:"data"`
	}
	if err := json.Unmarshal(bytes.TrimRight(p, "\x00"), &out); err != nil {
		return nil, fmt.Errorf("не JSON: %w", err)
	}
	if out.DPS != nil {
		return out.DPS, nil
	}
	return out.Data.DPS, nil
}

// ---------- высокоуровневые операции ----------

func ts() string { return strconv.FormatInt(time.Now().Unix(), 10) }

func localStatus(d *localDev) (map[string]any, error) {
	tc, err := dialTuya(d, 3*time.Second)
	if err != nil {
		return nil, err
	}
	defer tc.Close()
	gw := d.ID
	if d.GwID != "" {
		gw = d.GwID
	}
	body := map[string]any{"gwId": gw, "devId": gw, "uid": gw, "t": ts()}
	cmd := uint32(cmdDPQuery)
	if d.NodeID != "" {
		body["cid"] = d.NodeID
	}
	if d.Version != "3.3" {
		cmd = cmdDPQueryNew
		body = map[string]any{}
		if d.NodeID != "" {
			body["cid"] = d.NodeID
		}
	}
	if err := tc.jsonCmd(cmd, body); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		f, err := tc.read(deadline)
		if err != nil {
			return nil, err
		}
		if f.cmd == cmdDPQuery || f.cmd == cmdDPQueryNew || f.cmd == cmdStatus {
			if len(f.payload) == 0 {
				continue
			}
			return tc.decodeDPS(f)
		}
	}
	return nil, errors.New("нет ответа")
}

func localSet(d *localDev, dps map[string]any) error {
	tc, err := dialTuya(d, 3*time.Second)
	if err != nil {
		return err
	}
	defer tc.Close()
	gw := d.ID
	if d.GwID != "" {
		gw = d.GwID
	}
	var body map[string]any
	cmd := uint32(cmdControl)
	if d.Version == "3.3" {
		body = map[string]any{"devId": gw, "uid": gw, "t": ts(), "dps": dps}
		if d.NodeID != "" {
			body["cid"] = d.NodeID
		}
	} else {
		cmd = cmdControlNew
		data := map[string]any{"dps": dps}
		if d.NodeID != "" {
			data["cid"] = d.NodeID
		}
		body = map[string]any{"protocol": 5, "t": time.Now().Unix(), "data": data}
	}
	if err := tc.jsonCmd(cmd, body); err != nil {
		return err
	}
	// ждём подтверждение (не все устройства отвечают — это не ошибка)
	deadline := time.Now().Add(2500 * time.Millisecond)
	for time.Now().Before(deadline) {
		f, err := tc.read(deadline)
		if err != nil {
			return nil
		}
		if f.cmd == cmd || f.cmd == cmdStatus {
			return nil
		}
	}
	return nil
}

// ---------- поиск: какой IP у какого устройства и какая версия ----------

type localRegistry struct {
	mu   sync.Mutex
	devs map[string]*localDev // devId -> устройство
	at   time.Time
}

// probe пробует ключ устройства на IP во всех версиях протокола.
func probe(id string, key []byte, ip string) (*localDev, map[string]any) {
	for _, v := range []string{"3.3", "3.4", "3.5"} {
		d := &localDev{ID: id, Key: key, IP: ip, Version: v}
		if st, err := localStatus(d); err == nil && st != nil {
			return d, st
		}
	}
	return nil, nil
}
