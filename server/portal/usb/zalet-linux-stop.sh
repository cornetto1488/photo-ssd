#!/usr/bin/env bash
# ZALET HOME — отключиться от дома на Linux (и по желанию удалить Tailscale).
exec bash "$(cd "$(dirname "$0")" && pwd)/zalet-linux.sh" stop
