#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
AWS_REGION="us-east-1"
ECS_CLUSTER="your-cluster"                        # TODO
ECS_SERVICE="your-service"                        # TODO
ALB_ARN="arn:aws:elasticloadbalancing:..."        # TODO
WAF_WEBACL_ARN="arn:aws:wafv2:..."                # TODO
CLOUDFRONT_DISTRIBUTION_ID="EXXXXXXXXXXXXX"       # TODO
NAT_GATEWAY_ID="nat-xxxxxxxxxxxxxxxxx"            # TODO: leave blank to skip NAT teardown
NAT_ROUTE_TABLE_ID="rtb-xxxxxxxxxxxxxxxxx"        # TODO: private subnet route table
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

# ── 2. Snapshot NAT Gateway EIP (so we can reuse it on start) ────────────────
NAT_EIP_ALLOC=""
if [[ -n "$NAT_GATEWAY_ID" ]]; then
  echo "==> Reading NAT Gateway EIP allocation..."
  NAT_EIP_ALLOC=$(aws ec2 describe-nat-gateways \
    --nat-gateway-ids "$NAT_GATEWAY_ID" \
    --query 'NatGateways[0].NatGatewayAddresses[0].AllocationId' \
    --output text)
fi

# ── Save state ────────────────────────────────────────────────────────────────
echo "==> Saving state to $STATE_FILE..."
cat > "$STATE_FILE" <<EOF
{
  "ecs_desired_count": $DESIRED,
  "nat_eip_alloc": "$NAT_EIP_ALLOC",
  "nat_route_table_id": "$NAT_ROUTE_TABLE_ID"
}
EOF

# ── 3. Scale ECS to 0 ─────────────────────────────────────────────────────────
echo "==> Scaling ECS service to 0 tasks..."
aws ecs update-service \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --desired-count 0 \
  --output text --query 'service.serviceName'

# ── 4. Disassociate WAF from ALB ──────────────────────────────────────────────
echo "==> Disassociating WAF WebACL from ALB..."
aws wafv2 disassociate-web-acl \
  --resource-arn "$ALB_ARN" \
  --region "$AWS_REGION"

# ── 5. Disable CloudFront distribution ───────────────────────────────────────
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

# ── 6. Delete NAT Gateway ─────────────────────────────────────────────────────
# The EIP is NOT released on deletion, so start.sh can reuse it.
if [[ -n "$NAT_GATEWAY_ID" ]]; then
  echo "==> Deleting NAT Gateway $NAT_GATEWAY_ID (EIP $NAT_EIP_ALLOC retained)..."
  aws ec2 delete-nat-gateway \
    --nat-gateway-id "$NAT_GATEWAY_ID" \
    --output text --query 'NatGatewayId'
  echo "    NAT Gateway deletion initiated (~60 sec). Private subnet outbound will fail once complete."
fi

echo ""
echo "==> Done. What was stopped:"
echo "    [x] ECS tasks scaled to 0 (was $DESIRED)"
echo "    [x] WAF WebACL disassociated from ALB"
echo "    [x] CloudFront distribution disabled"
[[ -n "$NAT_GATEWAY_ID" ]] && echo "    [x] NAT Gateway deleted (~\$0.045/hr saved)"
echo ""
echo "    Note: The ALB still accrues a small fixed charge (~\$0.008/hr) while it exists."
echo "    Run ./start.sh to restore all services."
