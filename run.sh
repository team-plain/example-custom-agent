#!/usr/bin/env bash
# Checks the setup, then runs the agent.
set -euo pipefail
cd "$(dirname "$0")"
bun run src/index.ts check
echo
bun run src/index.ts serve
