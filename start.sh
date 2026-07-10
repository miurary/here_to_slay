#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
AWS_REGION="us-west-2"
LIGHTSAIL_INSTANCE="wiggles"          # <-- your Lightsail instance name
# ─────────────────────────────────────────────────────────────────────────────

# Reverses stop.sh. The static IP stays attached across stop/start, so the
# Route 53 record still points here — no DNS change needed. Docker is enabled at
# boot and the containers use `restart: unless-stopped`, so caddy + wiggles come
# back on their own once the instance is up (give them ~30s after "running").

echo "==> Starting Lightsail instance '$LIGHTSAIL_INSTANCE'..."
aws lightsail start-instance \
  --region "$AWS_REGION" \
  --instance-name "$LIGHTSAIL_INSTANCE" \
  --query 'operations[0].status' --output text

echo "==> Waiting for the instance to reach 'running'..."
for _ in $(seq 1 60); do
  STATE=$(aws lightsail get-instance-state \
    --region "$AWS_REGION" \
    --instance-name "$LIGHTSAIL_INSTANCE" \
    --query 'state.name' --output text 2>/dev/null || echo "unknown")
  if [[ "$STATE" == "running" ]]; then
    echo "==> Instance is running. Containers will be back within ~30s."
    exit 0
  fi
  sleep 5
done

echo "==> Instance did not report 'running' within the timeout — check the Lightsail console." >&2
exit 1
