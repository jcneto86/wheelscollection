#!/usr/bin/env sh
# Wheels Collection CLI - macOS e Linux
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "[X] Node.js 18 ou superior nao encontrado." >&2
  echo "    Instale em https://nodejs.org/ e tente novamente." >&2
  exit 1
fi
exec node "$DIR/wheels.mjs" "$@"
