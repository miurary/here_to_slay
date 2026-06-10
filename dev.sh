#!/usr/bin/env bash
set -e

(cd wiggles && npm install --silent)
(cd snowball && npm install --silent)

(cd wiggles && npm run dev) &
WIGGLES_PID=$!

(cd snowball && npm run dev) &
SNOWBALL_PID=$!

trap 'kill $WIGGLES_PID $SNOWBALL_PID 2>/dev/null' EXIT INT TERM

wait $WIGGLES_PID $SNOWBALL_PID
