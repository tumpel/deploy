#!/bin/sh
set -eu

home=${RUNNER_HOME:-/home/runner}
npm_cache_limit_kb=$((2 * 1024 * 1024))

rm -rf "$home/cargo-target" "$home/.cargo/registry" "$home/.cargo/git"

for cache in "$home/supervisor-releases" "$home/tumpel-releases"; do
  if [ -d "$cache" ]; then
    find "$cache" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} +
  fi
done

if [ -d "$home/.npm/_cacache" ]; then
  npm_kb=$(du -sk "$home/.npm/_cacache" | cut -f1)
  if [ "$npm_kb" -gt "$npm_cache_limit_kb" ]; then
    rm -rf "$home/.npm/_cacache"
  fi
fi

if pgrep -x Runner.Worker >/dev/null; then
  echo "runner-prune: a job is running, work dirs left alone"
  exit 0
fi

for work in "$home"/actions-runner-*/_work; do
  [ -d "$work" ] || continue
  find "$work" -mindepth 3 -maxdepth 3 -name .tmp -type d -mmin +60 -exec rm -rf {} +
  if [ -d "$work/_temp" ]; then
    find "$work/_temp" -mindepth 1 -maxdepth 1 -mmin +60 -exec rm -rf {} +
  fi
done

df -h /
