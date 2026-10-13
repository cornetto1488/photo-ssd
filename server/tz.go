package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// setLocalZone — часовой пояс роутера. В OpenWrt нет /etc/localtime, только /etc/TZ в формате POSIX
// («<+06>-6», «MSK-3»), который Go сам не понимает — разбираем смещение и ставим его как местное время.
func setLocalZone() {
	tz := strings.TrimSpace(os.Getenv("TZ"))
	if tz == "" {
		b, _ := os.ReadFile("/etc/TZ")
		tz = strings.TrimSpace(string(b))
	}
	if tz == "" {
		return
	}
	name, rest := tz, ""
	if strings.HasPrefix(tz, "<") {
		if i := strings.Index(tz, ">"); i > 0 {
			name, rest = tz[1:i], tz[i+1:]
		}
	} else {
		i := strings.IndexAny(tz, "+-0123456789")
		if i <= 0 {
			return
		}
		name, rest = tz[:i], tz[i:]
	}
	// смещение до возможной части про летнее время
	end := 0
	for end < len(rest) && strings.ContainsRune("+-0123456789:", rune(rest[end])) {
		end++
	}
	off := rest[:end]
	if off == "" {
		return
	}
	sign := 1
	if off[0] == '-' {
		sign = -1
		off = off[1:]
	} else if off[0] == '+' {
		off = off[1:]
	}
	hm := strings.SplitN(off, ":", 2)
	h, err := strconv.Atoi(hm[0])
	if err != nil {
		return
	}
	m := 0
	if len(hm) == 2 {
		m, _ = strconv.Atoi(hm[1])
	}
	// в POSIX знак обратный: «<+06>-6» — это UTC+6
	secs := -sign * (h*3600 + m*60)
	time.Local = time.FixedZone(name, secs)
}
