#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node="$(command -v node || true)"
if [ -z "$node" ] && [ -x /opt/tumpel/node/bin/node ]; then
  node=/opt/tumpel/node/bin/node
fi
if [ -z "$node" ]; then
  echo "prebuild: NodeMissing: this image has no node; run the prebuild on a ClaudeCode guest image" >&2
  exit 1
fi
exec "$node" "$here/prebuild.mjs" "$@"
