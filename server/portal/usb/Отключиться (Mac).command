#!/bin/bash
# ZALET HOME — отключиться от дома на Mac (и по желанию удалить Tailscale).
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
[ -x "$TS" ] || { echo "  Tailscale не установлен."; sleep 3; exit 0; }
echo "  1 — отключиться от дома"; echo "  2 — отключиться и удалить Tailscale"
read -r -p "  Выберите 1 или 2: " c
"$TS" logout >/dev/null 2>&1; echo "  ✓ Отключено от домашней сети"
if [ "$c" = "2" ]; then osascript -e 'quit app "Tailscale"' 2>/dev/null; sudo rm -rf /Applications/Tailscale.app; echo "  ✓ Tailscale удалён"; fi
sleep 3
