#!/bin/bash
# ZALET HOME — флешка для macOS: ставит Tailscale (если нужно), подключает к дому и открывает панель.
# Двойной клик (при первом запуске: правый клик → «Открыть»). Отключиться: «Отключиться (Mac).command».
HERE="$(cd "$(dirname "$0")" && pwd)"
PORTAL="http://100.113.69.110/"
APP="/Applications/Tailscale.app"
TS="$APP/Contents/MacOS/Tailscale"
KEYFILE="$HERE/.zalet/key.txt"

ok()   { echo "  ✓ $*"; }
fail() { echo; echo "  ✕ $*"; echo; read -r -p "  Нажмите Enter, чтобы закрыть " _; exit 1; }
reach(){ curl -fsS -m 3 -o /dev/null "$PORTAL" 2>/dev/null; }

clear; echo; echo "   ZALET HOME"; echo "   подключаюсь к дому…"; echo
if reach; then ok "Связь с домом уже есть"; open "$PORTAL"; exit 0; fi

if [ ! -x "$TS" ]; then
  pkg="$(ls "$HERE"/.zalet/Tailscale-*-macos.pkg 2>/dev/null | head -1)"
  [ -n "$pkg" ] || fail "На флешке нет установщика Tailscale для Mac"
  echo "  Устанавливаю Tailscale (попросит пароль от Mac)…"
  sudo installer -pkg "$pkg" -target / || fail "Установка не удалась"
  ok "Tailscale установлен"
  open -g "$APP"; sleep 6
else
  ok "Tailscale уже есть"
  pgrep -xq Tailscale || { open -g "$APP"; sleep 5; }
fi

if "$TS" status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then
  ok "Tailscale уже подключён"
else
  [ -s "$KEYFILE" ] || fail "Нет ключа подключения в .zalet/key.txt"
  key="$(tr -d ' \r\n' < "$KEYFILE")"
  extra=()
  case "$key" in tskey-client-*) case "$key" in *\?*) ;; *) key="$key?ephemeral=false&preauthorized=true";; esac; extra+=(--advertise-tags=tag:usb);; esac
  name="usb-$(scutil --get LocalHostName 2>/dev/null | tr 'A-Z' 'a-z')"
  echo "  Подключаюсь к домашней сети как $name…"
  "$TS" up --authkey="$key" --hostname="$name" --accept-routes --reset "${extra[@]}" || fail "Tailscale не подключился — проверьте ключ"
  ok "Подключено к домашней сети"
fi

echo "  Жду ответа от дома…"
for i in $(seq 1 40); do if reach; then ok "Дом на связи"; open "$PORTAL"; exit 0; fi; sleep 1; done
open "$PORTAL"; fail "Роутер пока не ответил — страница открыта, обновите её через минуту"
