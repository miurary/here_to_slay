#!/usr/bin/env bash
set -e

echo "==> Building backend Docker image..."
docker build -f wiggles/Dockerfile -t wiggles .

echo "==> Building frontend..."
(cd snowball && npm run build)

echo "==> Done."
