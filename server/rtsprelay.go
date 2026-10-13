// RTSP-реле для ускоренного архива Modus. go2rtc не умеет слать заголовок Scale,
// а Modus ускоряет архив только с ним. go2rtc подключается сюда, реле дописывает
// "Scale: N" в PLAY и дальше просто перекладывает байты в обе стороны.
//
// Адрес для go2rtc: rtsp://127.0.0.1:18554/x<N>/<host:port>/<путь Modus>
package main

import (
	"bufio"
	"io"
	"log"
	"net"
	"strconv"
	"strings"
	"time"
)

const (
	rtspRelayAddr   = "127.0.0.1:18554"
	rtspRelayPrefix = "rtsp://" + rtspRelayAddr + "/"
)

func startRTSPRelay() {
	ln, err := net.Listen("tcp", rtspRelayAddr)
	if err != nil {
		log.Printf("rtsp-реле: %v", err)
		return
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			time.Sleep(time.Second)
			continue
		}
		go relayConn(c)
	}
}

// relayURL превращает ссылку Modus в адрес реле с заданной скоростью.
func relayURL(modus string, scale int) string {
	return rtspRelayPrefix + "x" + strconv.Itoa(scale) + "/" + strings.TrimPrefix(modus, "rtsp://")
}

func relayConn(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	var up net.Conn
	defer func() {
		if up != nil {
			up.Close()
		}
	}()
	scale, host := "", ""
	for {
		c.SetReadDeadline(time.Now().Add(90 * time.Second))
		b, err := br.Peek(1)
		if err != nil {
			return
		}
		if b[0] == '$' { // RTCP/RTP от клиента внутри TCP
			h := make([]byte, 4)
			if _, err := io.ReadFull(br, h); err != nil {
				return
			}
			n := int(h[2])<<8 | int(h[3])
			payload := make([]byte, n)
			if _, err := io.ReadFull(br, payload); err != nil {
				return
			}
			if up != nil {
				up.Write(append(h, payload...))
			}
			continue
		}
		var lines []string
		clen := 0
		for {
			l, err := br.ReadString('\n')
			if err != nil {
				return
			}
			l = strings.TrimRight(l, "\r\n")
			if l == "" {
				break
			}
			lines = append(lines, l)
			if k, v, ok := strings.Cut(l, ":"); ok && strings.EqualFold(strings.TrimSpace(k), "content-length") {
				clen, _ = strconv.Atoi(strings.TrimSpace(v))
			}
		}
		if len(lines) == 0 {
			continue
		}
		body := make([]byte, clen)
		if clen > 0 {
			if _, err := io.ReadFull(br, body); err != nil {
				return
			}
		}
		parts := strings.SplitN(lines[0], " ", 3)
		if len(parts) < 3 {
			return
		}
		method, uri := parts[0], parts[1]
		if strings.HasPrefix(uri, rtspRelayPrefix) {
			rest := strings.TrimPrefix(uri, rtspRelayPrefix) // x4/host:port/путь
			seg, tail, ok := strings.Cut(rest, "/")
			if !ok || !strings.HasPrefix(seg, "x") {
				return
			}
			hp, path, _ := strings.Cut(tail, "/")
			scale, host = seg[1:], hp
			uri = "rtsp://" + hp + "/" + path
		}
		if up == nil {
			if host == "" {
				return
			}
			u, err := net.DialTimeout("tcp", host, 10*time.Second)
			if err != nil {
				return
			}
			up = u
			go func() { // ответы и поток сервера — как есть
				io.Copy(c, up)
				c.Close()
			}()
		}
		out := method + " " + uri + " " + parts[2] + "\r\n"
		for _, l := range lines[1:] {
			out += l + "\r\n"
		}
		if method == "PLAY" && scale != "" && scale != "1" {
			out += "Scale: " + scale + "\r\n"
		}
		out += "\r\n"
		if _, err := up.Write(append([]byte(out), body...)); err != nil {
			return
		}
	}
}
