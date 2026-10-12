#!/bin/sh
# Run by the install job in ci.yml, inside a bare Node image: installs the
# packed polyglots tarball globally, as a user would, and proves the CLI and
# its native SQLite binding load. Every failure exits non-zero with a reason.
set -eu

# The check means nothing on an image that can compile: npm would build
# better-sqlite3 from source and pass.
for tool in make cc gcc g++; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "This image has $tool, so it cannot show an install without a compiler." >&2
    exit 1
  fi
done

npm install --global --no-audit --no-fund /pkg/polyglots-*.tgz

root="$(npm root --global)"
if [ -d "$root/polyglots/node_modules/better-sqlite3/build" ]; then
  echo "better-sqlite3 was compiled instead of using its ready-made binary." >&2
  exit 1
fi

cd "$root/polyglots"
node -e 'const Database = require("better-sqlite3"); console.log("sqlite " + new Database(":memory:").prepare("select sqlite_version() as v").get().v)'
cd /
POLYGLOTS_HOME="$(mktemp -d)" polyglots --version
