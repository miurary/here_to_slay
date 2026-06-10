#!/usr/bin/env bash
set -e

# ── Configuration ────────────────────────────────────────────────────────────
AWS_REGION="us-east-1"           # TODO: your AWS region
AWS_ACCOUNT_ID="123456789012"    # TODO: your AWS account ID
ECR_REPO="wiggles"               # TODO: your ECR repository name
ECS_CLUSTER="your-cluster"       # TODO: your ECS cluster name
ECS_SERVICE="your-service"       # TODO: your ECS service name
# ─────────────────────────────────────────────────────────────────────────────

ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO"

echo "==> Building image..."
docker build -f wiggles/Dockerfile -t "$ECR_REPO" .

echo "==> Logging in to ECR..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

echo "==> Pushing $ECR_URI:latest..."
docker tag "$ECR_REPO:latest" "$ECR_URI:latest"
docker push "$ECR_URI:latest"

echo "==> Triggering ECS redeployment..."
aws ecs update-service \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --force-new-deployment \
  --output text --query 'service.serviceName'

echo "==> Done. New task will start rolling out shortly."
