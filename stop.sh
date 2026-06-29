#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
AWS_REGION="us-west-2"
ECS_CLUSTER="wiggles-cluster"
ECS_SERVICE="wiggles-task-service-xh5xjwiw"
ALB_ARN="arn:aws:elasticloadbalancing:us-west-2:063418082823:loadbalancer/app/wiggles-alb/72b3295da747bb26"
CLOUDFRONT_DISTRIBUTION_ID="EEESGFDKI1CIE"
# NOTE: This deployment uses public subnets + an Internet Gateway (no NAT
# gateway). An IGW is free and must not be torn down, so there is no NAT step.
# The only WAF WebACL is CloudFront-scoped (CreatedByCloudFront-*); it is
# attached to the distribution, so disabling CloudFront below covers it. The
# ALB has no WebACL, so there is no WAF disassociate step.
# ─────────────────────────────────────────────────────────────────────────────

STATE_FILE=".service-state.json"

if [[ -f "$STATE_FILE" ]]; then
  echo "State file $STATE_FILE already exists — services may already be stopped."
  echo "Delete $STATE_FILE to force a re-run."
  exit 1
fi

# ── 1. Snapshot ECS desired count ────────────────────────────────────────────
echo "==> Reading ECS desired count..."
DESIRED=$(aws ecs describe-services \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --query 'services[0].desiredCount' \
  --output text)

# ── Save state ────────────────────────────────────────────────────────────────
echo "==> Saving state to $STATE_FILE..."
cat > "$STATE_FILE" <<EOF
{
  "ecs_desired_count": $DESIRED
}
EOF

# ── 2. Scale ECS to 0 ─────────────────────────────────────────────────────────
echo "==> Scaling ECS service to 0 tasks..."
aws ecs update-service \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --desired-count 0 \
  --output text --query 'service.serviceName'

# ── 3. Disable CloudFront distribution ───────────────────────────────────────
echo "==> Disabling CloudFront distribution $CLOUDFRONT_DISTRIBUTION_ID..."
CF_ETAG=$(aws cloudfront get-distribution-config \
  --id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --query 'ETag' --output text)
aws cloudfront get-distribution-config \
  --id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --query 'DistributionConfig' \
  | python3 -c "import json,sys; cfg=json.load(sys.stdin); cfg['Enabled']=False; print(json.dumps(cfg))" \
  > /tmp/cf-config-stop.json
aws cloudfront update-distribution \
  --id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --distribution-config file:///tmp/cf-config-stop.json \
  --if-match "$CF_ETAG" \
  --output text --query 'Distribution.Id'
echo "    CloudFront disable initiated — takes 15-20 min to fully propagate."

echo ""
echo "==> Done. What was stopped:"
echo "    [x] ECS tasks scaled to 0 (was $DESIRED)"
echo "    [x] CloudFront distribution disabled (its WAF goes inactive with it)"
echo ""
echo "    Note: The ALB still accrues a small fixed charge (~\$0.008/hr) while it exists."
echo "    Run ./start.sh to restore all services."
