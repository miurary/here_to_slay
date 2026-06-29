#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
AWS_REGION="us-west-2"
ECS_CLUSTER="wiggles-cluster"
ECS_SERVICE="wiggles-task-service-xh5xjwiw"
ECS_DEFAULT_COUNT=1                              # fallback if no state file
CLOUDFRONT_DISTRIBUTION_ID="EEESGFDKI1CIE"
# NOTE: This deployment uses public subnets + an Internet Gateway (no NAT
# gateway), so there is no NAT recreate step. The only WAF WebACL is
# CloudFront-scoped, so enabling CloudFront below restores it; the ALB has no
# WebACL, so there is no WAF associate step.
# ─────────────────────────────────────────────────────────────────────────────

STATE_FILE=".service-state.json"

# ── Read saved state ──────────────────────────────────────────────────────────
if [[ -f "$STATE_FILE" ]]; then
  DESIRED=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['ecs_desired_count'])")
else
  echo "No state file found — using default desired count of $ECS_DEFAULT_COUNT."
  DESIRED=$ECS_DEFAULT_COUNT
fi

# ── 1. Enable CloudFront distribution ────────────────────────────────────────
echo "==> Enabling CloudFront distribution $CLOUDFRONT_DISTRIBUTION_ID..."
CF_ETAG=$(aws cloudfront get-distribution-config \
  --id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --query 'ETag' --output text)
aws cloudfront get-distribution-config \
  --id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --query 'DistributionConfig' \
  | python3 -c "import json,sys; cfg=json.load(sys.stdin); cfg['Enabled']=True; print(json.dumps(cfg))" \
  > /tmp/cf-config-start.json
aws cloudfront update-distribution \
  --id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --distribution-config file:///tmp/cf-config-start.json \
  --if-match "$CF_ETAG" \
  --output text --query 'Distribution.Id'
echo "    CloudFront enable initiated — takes 15-20 min to fully propagate."

# ── 2. Scale ECS back up ──────────────────────────────────────────────────────
echo "==> Scaling ECS service to $DESIRED task(s)..."
aws ecs update-service \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --desired-count "$DESIRED" \
  --output text --query 'service.serviceName'

# ── Clean up state file ───────────────────────────────────────────────────────
rm -f "$STATE_FILE"

echo ""
echo "==> Done. Services are coming back up:"
echo "    [x] CloudFront distribution enabled (15-20 min to propagate)"
echo "    [x] ECS service scaling to $DESIRED task(s)"
