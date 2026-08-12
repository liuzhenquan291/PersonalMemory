#!/bin/sh
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "PersonalMemory requires Node.js 22.19.0 or newer." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "PersonalMemory requires npm." >&2
  exit 1
fi

node -e '
const current = process.versions.node.split(".").map(Number);
const minimum = [22, 19, 0];
for (let index = 0; index < minimum.length; index += 1) {
  if (current[index] > minimum[index]) process.exit(0);
  if (current[index] < minimum[index]) {
    console.error("PersonalMemory requires Node.js 22.19.0 or newer.");
    process.exit(1);
  }
}
'

if [ ! -d node_modules ]; then
  npm ci
fi
npm run install:product
