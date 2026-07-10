#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
AWS_REGION="us-west-2"
LIGHTSAIL_INSTANCE="wiggles"          # <-- your Lightsail instance name
# ─────────────────────────────────────────────────────────────────────────────

# The only thing worth turning off now is the Lightsail instance (the game
# server itself). CloudFront, S3, and Route 53 are effectively free at idle and
# toggling them only adds propagation delay, so they're left alone.
#
# NOTE: Lightsail bills a stopped instance the SAME as a running one — stopping
# only halts the game and its compute, it does not reduce the bill. For real
# savings on a long hiatus, snapshot the instance and delete it instead.

echo "==> Stopping Lightsail instance '$LIGHTSAIL_INSTANCE'..."
aws lightsail stop-instance \
  --region "$AWS_REGION" \
  --instance-name "$LIGHTSAIL_INSTANCE" \
  --query 'operations[0].status' --output text

echo "==> Stop requested. The game will be offline until you run ./start.sh."
