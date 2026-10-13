#!/usr/bin/env bash
# ZALET HOME — флешка для Linux: ставит Tailscale (если нужно), подключает к дому и открывает панель.
# Запуск: bash zalet-linux.sh        Отключиться: bash zalet-linux-stop.sh

HERE="$(cd "$(dirname "$0")" && pwd)"
ROUTER="100.113.69.110"
PORTAL="http://$ROUTER/"
case "$(uname -m)" in
  aarch64|arm64) PKG="$HERE/.zalet/tailscale_arm64.tgz" ;;
  *)             PKG="$HERE/.zalet/tailscale_amd64.tgz" ;;
esac
KEYFILE="$HERE/.zalet/key.txt"

# Запустили двойным кликом без терминала — откроем терминал, чтобы было видно, что происходит
if [ ! -t 1 ] && [ -z "$ZALET_IN_TERM" ]; then
  export ZALET_IN_TERM=1
  for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal fly-term mate-terminal lxterminal xterm; do
    if command -v "$t" >/dev/null 2>&1; then
      case "$t" in
        gnome-terminal) exec "$t" -- bash "$0" "$@" ;;
        *) exec "$t" -e bash "$0" "$@" ;;
      esac
    fi
  done
fi

o="\033[38;5;208m"; g="\033[32m"; r="\033[31m"; y="\033[33m"; d="\033[90m"; n="\033[0m"
say()  { echo -e "  $*"; }
ok()   { echo -e "  ${g}✓${n} $*"; }
pause(){ echo; read -r -p "  Нажмите Enter, чтобы закрыть " _; }
fail() { echo; echo -e "  ${r}✕ $*${n}"; pause; exit 1; }
reach(){ curl -fsS -m 3 -o /dev/null "$PORTAL" 2>/dev/null || wget -q -T 3 -O /dev/null "$PORTAL" 2>/dev/null; }
open_portal() { (xdg-open "$PORTAL" >/dev/null 2>&1 || sensible-browser "$PORTAL" >/dev/null 2>&1 || x-www-browser "$PORTAL" >/dev/null 2>&1) & sleep 1; }

clear
echo
echo -e "   ${o}ZA${n}LET ${d}HOME${n}"
echo -e "   ${d}подключаюсь к дому…${n}"
echo

# ---------- отключение ----------
if [ "$1" = "stop" ]; then
  command -v tailscale >/dev/null 2>&1 || { say "Tailscale на этом компьютере не установлен."; pause; exit 0; }
  echo "  1 — отключиться от дома"
  echo "  2 — отключиться и удалить Tailscale с компьютера"
  read -r -p "  Выберите 1 или 2: " c
  sudo tailscale logout >/dev/null 2>&1; ok "Отключено от домашней сети"
  if [ "$c" = "2" ]; then
    if [ -f /etc/systemd/system/tailscaled.service ]; then
      sudo systemctl disable --now tailscaled >/dev/null 2>&1
      sudo rm -f /etc/systemd/system/tailscaled.service /etc/default/tailscaled
      sudo systemctl daemon-reload
    else
      sudo pkill -x tailscaled
    fi
    sudo rm -f /usr/sbin/tailscaled /usr/bin/tailscale
    sudo rm -rf /var/lib/tailscale
    ok "Tailscale удалён"
  fi
  pause; exit 0
fi

# 0. Уже есть связь с домом — сразу открываем
if reach; then ok "Связь с домом уже есть"; open_portal; exit 0; fi

say "${d}Понадобится пароль администратора этого компьютера (sudo).${n}"
sudo -v || fail "Нужны права администратора (sudo)"

# 1. Tailscale
if ! command -v tailscale >/dev/null 2>&1; then
  arch="$(uname -m)"
  if { [ "$arch" = "x86_64" ] || [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; } && [ -f "$PKG" ]; then
    say "${y}Устанавливаю Tailscale с флешки…${n}"
    tmp="$(mktemp -d)"
    tar xzf "$PKG" -C "$tmp" || fail "Не удалось распаковать Tailscale"
    src="$(echo "$tmp"/tailscale_*)"
    sudo install -m 755 "$src/tailscaled" /usr/sbin/tailscaled
    sudo install -m 755 "$src/tailscale" /usr/bin/tailscale
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
      sudo install -m 644 "$src/systemd/tailscaled.service" /etc/systemd/system/tailscaled.service
      [ -f /etc/default/tailscaled ] || sudo install -m 644 "$src/systemd/tailscaled.defaults" /etc/default/tailscaled
      sudo systemctl daemon-reload
      sudo systemctl enable --now tailscaled >/dev/null 2>&1
    fi
    rm -rf "$tmp"
  else
    say "${y}Ставлю Tailscale из интернета (процессор $arch)…${n}"
    curl -fsSL https://tailscale.com/install.sh | sh || fail "Не удалось установить Tailscale"
  fi
  ok "Tailscale установлен"
else
  ok "Tailscale уже есть на компьютере"
fi

# служба должна работать
if ! pgrep -x tailscaled >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files tailscaled.service >/dev/null 2>&1; then
    sudo systemctl start tailscaled
  else
    sudo mkdir -p /var/lib/tailscale
    sudo sh -c 'nohup /usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state >/var/log/tailscaled.log 2>&1 &'
  fi
  for i in $(seq 1 15); do pgrep -x tailscaled >/dev/null && break; sleep 1; done
fi

# 2. Подключение
if sudo tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then
  ok "Tailscale уже подключён"
else
  [ -s "$KEYFILE" ] || fail "Нет ключа подключения: положите его в .zalet/key.txt (см. ПРОЧТИ МЕНЯ.txt)"
  key="$(tr -d ' \r\n' < "$KEYFILE")"
  name="usb-$(hostname | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | sed 's/-*$//')"
  extra=()
  case "$key" in
    tskey-client-*)
      case "$key" in *\?*) ;; *) key="$key?ephemeral=false&preauthorized=true" ;; esac
      extra+=(--advertise-tags=tag:usb) ;;
  esac
  say "${y}Подключаюсь к домашней сети как $name…${n}"
  sudo tailscale up --authkey="$key" --hostname="$name" --accept-routes --reset --operator="$USER" "${extra[@]}" \
    || fail "Tailscale не подключился. Возможно, ключ устарел — создайте новый (см. ПРОЧТИ МЕНЯ.txt)"
  ok "Подключено к домашней сети"
fi

# 3. Ждём ответа от дома и открываем панель
say "${y}Жду ответа от дома…${n}"
for i in $(seq 1 40); do
  if reach; then ok "Дом на связи"; open_portal; exit 0; fi
  sleep 1
done
open_portal
fail "Роутер пока не ответил — страница открыта, обновите её через минуту"
