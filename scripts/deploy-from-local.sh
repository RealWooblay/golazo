#!/bin/bash
# Bundle the repo and push to S3, then trigger in-place update on the EC2 instance.
set -euxo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${GOLAZO_DEPLOY_BUCKET:-s3://golazo-deploy-050752647977-20260620092236}"
INSTANCE_ID="${GOLAZO_INSTANCE_ID:-i-0c6e6843d8ac4c15e}"
DOMAIN="${GOLAZO_DOMAIN:-golazo.wooblay.com}"
TARBALL="/tmp/golazo-$(date +%Y%m%d%H%M%S).tgz"

cd "$ROOT"
tar -czf "$TARBALL" \
  --exclude=node_modules \
  --exclude=.git \
  --exclude='programs/golazo-parimutuel/target/debug' \
  --exclude='apps/mobile/dist' \
  --exclude='apps/mobile/.expo' \
  --exclude='programs/golazo-parimutuel/deploy-keypair.json' \
  --exclude='programs/golazo-parimutuel/target' \
  .

# Hard safety gate: the program UPGRADE-AUTHORITY keypair must NEVER leave this
# machine. The server signs on-chain only with services/feed/operator-keypair.json
# (intentionally bundled); the deployer/program keypairs are not needed there. Fail
# the deploy loudly rather than ship a tarball that leaks them.
if tar -tzf "$TARBALL" | grep -E 'deploy-keypair\.json|golazo_parimutuel-keypair\.json'; then
  echo "ABORT: program/deployer keypair found in deploy tarball — refusing to upload." >&2
  rm -f "$TARBALL"
  exit 1
fi

aws s3 cp "$TARBALL" "${BUCKET}/golazo.tgz"

CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Golazo deploy $(date -Iseconds)" \
  --parameters "commands=[\"aws s3 cp ${BUCKET}/golazo.tgz /opt/golazo.tgz && tar -xzf /opt/golazo.tgz -C /opt/golazo && GOLAZO_DOMAIN=${DOMAIN} bash /opt/golazo/deploy-update.sh\"]" \
  --output text \
  --query 'Command.CommandId')

echo "Deploy command ${CMD_ID} sent to ${INSTANCE_ID}"
