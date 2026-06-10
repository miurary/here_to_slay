#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
AWS_REGION="us-east-1"
ECS_CLUSTER="your-cluster"                        # TODO
ECS_SERVICE="your-service"                        # TODO
ECS_DEFAULT_COUNT=1                               # fallback if no state file
ALB_ARN="arn:aws:elasticloadbalancing:..."        # TODO
WAF_WEBACL_ARN="arn:aws:wafv2:..."                # TODO
CLOUDFRONT_DISTRIBUTION_ID="EXXXXXXXXXXXXX"       # TODO
NAT_SUBNET_ID="subnet-xxxxxxxxxxxxxxxxx"          # TODO: public subnet to place NAT gateway in
# ─────────────────────────────────────────────────────────────────────────────

STATE_FILE=".service-state.json"

# ── Read saved state ──────────────────────────────────────────────────────────
if [[ -f "$STATE_FILE" ]]; then
  DESIRED=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['ecs_desired_count'])")
  NAT_EIP_ALLOC=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('nat_eip_alloc', ''))")
  NAT_ROUTE_TABLE_ID=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('nat_route_table_id', ''))")
else
  echo "No state file found — using default desired count of $ECS_DEFAULT_COUNT."
  DESIRED=$ECS_DEFAULT_COUNT
  NAT_EIP_ALLOC=""
  NAT_ROUTE_TABLE_ID=""
fi

# ── 1. Recreate NAT Gateway ───────────────────────────────────────────────────
if [[ -n "$NAT_EIP_ALLOC" && "$NAT_EIP_ALLOC" != "None" ]]; then
  echo "==> Creating NAT Gateway in subnet $NAT_SUBNET_ID with EIP $NAT_EIP_ALLOC..."
  NEW_NAT_ID=$(aws ec2 create-nat-gateway \
    --subnet-id "$NAT_SUBNET_ID" \
    --allocation-id "$NAT_EIP_ALLOC" \
    --query 'NatGateway.NatGatewayId' \
    --output text)
  echo "    Created $NEW_NAT_ID. Waiting for it to become available..."
  aws ec2 wait nat-gateway-available --nat-gateway-ids "$NEW_NAT_ID"
  echo "    NAT Gateway is available."

  if [[ -n "$NAT_ROUTE_TABLE_ID" ]]; then
    echo "==> Updating route table $NAT_ROUTE_TABLE_ID to use $NEW_NAT_ID..."
    aws ec2 replace-route \
      --route-table-id "$NAT_ROUTE_TABLE_ID" \
      --destination-cidr-block "0.0.0.0/0" \
      --nat-gateway-id "$NEW_NAT_ID" 2>/dev/null || \
    aws ec2 create-route \
      --route-table-id "$NAT_ROUTE_TABLE_ID" \
      --destination-cidr-block "0.0.0.0/0" \
      --nat-gateway-id "$NEW_NAT_ID"
    echo "    Route table updated."
  fi
fi

# ── 2. Re-associate WAF with ALB ──────────────────────────────────────────────
echo "==> Associating WAF WebACL with ALB..."
aws wafv2 associate-web-acl \
  --web-acl-arn "$WAF_WEBACL_ARN" \
  --resource-arn "$ALB_ARN" \
  --region "$AWS_REGION"

# ── 3. Enable CloudFront distribution ────────────────────────────────────────
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

# ── 4. Scale ECS back up ──────────────────────────────────────────────────────
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
[[ -n "$NAT_EIP_ALLOC" && "$NAT_EIP_ALLOC" != "None" ]] && echo "    [x] NAT Gateway recreated and routes updated"
echo "    [x] WAF WebACL re-associated with ALB"
echo "    [x] CloudFront distribution enabled (15-20 min to propagate)"
echo "    [x] ECS service scaling to $DESIRED task(s)"
