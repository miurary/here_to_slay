#!/usr/bin/env bash
set -euo pipefail

# Deploys BOTH frontend and backend together:
#   1. builds the frontend bundle + backend image (via ./build.sh)
#   2. pushes the backend image to ECR and rolls it out on the Lightsail box
#   3. syncs the frontend to S3 and invalidates CloudFront
#
# Run from anywhere — it cd's to its own directory.

cd "$(dirname "$0")"

# ── Configuration ────────────────────────────────────────────────────────────
AWS_REGION="us-west-2"
AWS_ACCOUNT_ID="063418082823"
ECR_REPO="wiggles"
ECR_HOST="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
ECR_URI="$ECR_HOST/$ECR_REPO"

# Frontend (static site: S3 origin + CloudFront)
# Find the bucket:  aws cloudfront get-distribution-config --id EEESGFDKI1CIE \
#                     --query 'DistributionConfig.Origins.Items[].DomainName'
FRONTEND_BUCKET="REPLACE_ME"                 # <-- set once (bucket name only, no s3://)
CLOUDFRONT_DISTRIBUTION_ID="EEESGFDKI1CIE"

# Backend host (Lightsail instance running docker compose in REMOTE_DIR)
DEPLOY_HOST="api.uhtso.click"                # resolves to the Lightsail static IP
DEPLOY_USER="ec2-user"
SSH_KEY="$HOME/.ssh/lightsail-wiggles.pem"   # <-- set to your Lightsail key path
REMOTE_DIR="/opt/wiggles"
# ─────────────────────────────────────────────────────────────────────────────

if [[ "$FRONTEND_BUCKET" == "REPLACE_ME" ]]; then
  echo "Set FRONTEND_BUCKET at the top of deploy.sh first." >&2
  exit 1
fi

# ── 1. Build both artifacts ───────────────────────────────────────────────────
echo "==> Building frontend bundle + backend image..."
./build.sh

# ── 2. Backend: push to ECR, then pull + recreate on Lightsail ────────────────
echo "==> Logging in to ECR (local)..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_HOST"

echo "==> Pushing backend image to ECR..."
docker tag "$ECR_REPO:latest" "$ECR_URI:latest"
docker push "$ECR_URI:latest"

echo "==> Rolling out backend on Lightsail ($DEPLOY_HOST)..."
# Unquoted heredoc: local vars below are expanded here and sent as literals.
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST" bash -s <<REMOTE
set -euo pipefail
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $ECR_HOST
cd $REMOTE_DIR
docker compose pull wiggles          # fetch the new :latest digest
docker compose up -d                 # recreates wiggles (new image), leaves caddy up
docker image prune -f >/dev/null 2>&1 || true
echo "Backend now running:"
docker compose ps
REMOTE

# ── 3. Frontend: sync to S3, invalidate CloudFront ────────────────────────────
echo "==> Uploading frontend to s3://$FRONTEND_BUCKET/ ..."
aws s3 sync snowball/dist/ "s3://$FRONTEND_BUCKET/" --delete --region "$AWS_REGION"

echo "==> Invalidating CloudFront distribution $CLOUDFRONT_DISTRIBUTION_ID..."
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths '/*' \
  --query 'Invalidation.Id' --output text

echo ""
echo "==> Done."
echo "    [x] Backend image pushed to ECR and recreated on Lightsail"
echo "    [x] Frontend synced to S3 and CloudFront invalidated"
