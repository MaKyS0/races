#!/usr/bin/env bash
# rebuild + screenshot helper:  scripts/dev-shot.sh "<query>" out.png [waitMs] [w] [h]
cd "$(dirname "$0")/.." && npx vite build >/dev/null 2>&1 || { npx vite build 2>&1 | tail -20; exit 1; }
if ! curl -s -o /dev/null http://localhost:4173/; then (npx vite preview --port 4173 >/tmp/preview.log 2>&1 &); sleep 2; fi
node scripts/shot.mjs "$@"
