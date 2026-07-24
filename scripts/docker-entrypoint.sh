#!/bin/sh
set -eu

data_dir="${KRELVAN_DATA_DIR:-/data}"

if [ "$(id -u)" -eq 0 ]; then
  case "$data_dir" in
    ""|"/"|"/app"|"/etc"|"/home"|"/root"|"/usr"|"/var")
      echo "[krelvan] refusing unsafe data directory for ownership repair" >&2
      exit 1
      ;;
    /*)
      ;;
    *)
      echo "[krelvan] data directory must be an absolute path" >&2
      exit 1
      ;;
  esac

  if [ -d "$data_dir" ]; then
    chown -R --no-dereference node:node -- "$data_dir"
  fi

  exec gosu node "$@"
fi

exec "$@"
