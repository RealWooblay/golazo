#!/usr/bin/env bash
# Provision HTTPS + custom domain for the Golazo EC2 stack.
# Run from a machine with AWS CLI credentials (account 050752647977).
#
# What this does:
#   1. Allocate + associate an Elastic IP (stable DNS target)
#   2. Route53 A record: golazo.wooblay.com → EIP
#   3. Open port 443; close public 8787 (feed stays on localhost)
#   4. SSM: install Caddy, move golazo-web to :8080, enable TLS
#
# Usage:
#   GOLAZO_DOMAIN=golazo.wooblay.com ./infra/setup-golazo-https.sh
#   GOLAZO_DOMAIN=golazo.wooblay.com ./infra/setup-golazo-https.sh --skip-dns  # EIP + EC2 only
set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
INSTANCE_ID="${GOLAZO_INSTANCE_ID:-i-0c6e6843d8ac4c15e}"
DOMAIN="${GOLAZO_DOMAIN:-golazo.wooblay.com}"
HOSTED_ZONE_ID="${GOLAZO_HOSTED_ZONE_ID:-Z09715682BZUN9ETRYKL1}"
SG_ID="${GOLAZO_SG_ID:-sg-0460e9f54c8087645}"
SKIP_DNS=false
for arg in "$@"; do
  [[ "$arg" == "--skip-dns" ]] && SKIP_DNS=true
done

echo "==> Golazo HTTPS setup: ${DOMAIN} on ${INSTANCE_ID} (${REGION})"

# ── 1. Elastic IP ──────────────────────────────────────────────────────────
EXISTING_EIP=$(aws ec2 describe-addresses --region "$REGION" \
  --filters "Name=instance-id,Values=${INSTANCE_ID}" \
  --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)

if [[ -n "$EXISTING_EIP" && "$EXISTING_EIP" != "None" ]]; then
  ALLOC_ID="$EXISTING_EIP"
  PUBLIC_IP=$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOC_ID" \
    --query 'Addresses[0].PublicIp' --output text)
  echo "==> Reusing Elastic IP ${PUBLIC_IP} (${ALLOC_ID})"
else
  ALLOC_ID=$(aws ec2 allocate-address --domain vpc --region "$REGION" \
    --query 'AllocationId' --output text)
  aws ec2 associate-address --region "$REGION" \
    --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID" >/dev/null
  PUBLIC_IP=$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOC_ID" \
    --query 'Addresses[0].PublicIp' --output text)
  echo "==> Allocated Elastic IP ${PUBLIC_IP} (${ALLOC_ID})"
fi

# ── 2. Route53 A record ─────────────────────────────────────────────────────
if [[ "$SKIP_DNS" == "false" ]]; then
  CHANGE_BATCH=$(cat <<EOF
{
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "${DOMAIN}.",
      "Type": "A",
      "TTL": 300,
      "ResourceRecords": [{"Value": "${PUBLIC_IP}"}]
    }
  }]
}
EOF
)
  CHANGE_ID=$(aws route53 change-resource-record-sets \
    --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "$CHANGE_BATCH" \
    --query 'ChangeInfo.Id' --output text)
  echo "==> Route53 UPSERT ${DOMAIN} → ${PUBLIC_IP} (change ${CHANGE_ID})"
else
  echo "==> Skipping Route53 (--skip-dns)"
fi

# ── 3. Security group ───────────────────────────────────────────────────────
aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
  --ip-permissions "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description=HTTPS}]" \
  2>/dev/null || echo "==> Port 443 already open"

# Close public feed port — Caddy proxies /ws on :443 only.
aws ec2 revoke-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
  --ip-permissions "IpProtocol=tcp,FromPort=8787,ToPort=8787,IpRanges=[{CidrIp=0.0.0.0/0}]" \
  2>/dev/null && echo "==> Closed public :8787" || echo "==> :8787 already closed or rule absent"

# ── 4. SSM: install Caddy + reconfigure golazo-web on :8080 ────────────────
CADDYFILE_B64=$(base64 < "$(dirname "$0")/caddy/Caddyfile" | tr -d '\n')

SSM_DOC=$(cat <<'REMOTE'
#!/bin/bash
set -euxo pipefail
DOMAIN="__DOMAIN__"
CADDYFILE_B64="__CADDYFILE_B64__"

# Caddy binary (Amazon Linux 2023 has no official dnf package).
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy
  chmod +x /usr/local/bin/caddy
  useradd --system --home /var/lib/caddy --shell /sbin/nologin caddy 2>/dev/null || true
  mkdir -p /etc/caddy /var/lib/caddy
  chown caddy:caddy /var/lib/caddy
fi

echo "$CADDYFILE_B64" | base64 -d >/etc/caddy/Caddyfile

# Move golazo-web off :80 so Caddy can bind 80/443.
if grep -q "server.listen(80" /opt/golazo/static-server.mjs 2>/dev/null; then
  sed -i 's/server.listen(80,/server.listen(8080,/' /opt/golazo/static-server.mjs
  sed -i "s/listening on :80/listening on :8080/" /opt/golazo/static-server.mjs
fi

cat >/etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy TLS reverse proxy
After=network-online.target golazo-web.service
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
Environment=GOLAZO_DOMAIN=__DOMAIN__
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable caddy
systemctl restart golazo-web
systemctl restart caddy

# Rebuild SPA without baking ws:// IP — same-origin wss:// works over HTTPS.
if [ -d /opt/golazo/apps/mobile ]; then
  cd /opt/golazo/apps/mobile
  EXPO_USE_METRO_WORKSPACE_ROOT=1 \
  EXPO_PUBLIC_CHAIN_ENABLED=1 \
  EXPO_PUBLIC_SOLANA_CLUSTER=devnet \
  EXPO_PUBLIC_GOLAZO_PROGRAM_ID=GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu \
  npx expo export -p web
  systemctl restart golazo-web
fi

echo "GOLAZO_HTTPS https://${DOMAIN} wss://${DOMAIN}/ws" >/opt/golazo/READY
REMOTE
)

SSM_DOC="${SSM_DOC//__DOMAIN__/${DOMAIN}}"
SSM_DOC="${SSM_DOC//__CADDYFILE_B64__/${CADDYFILE_B64}}"

CMD_ID=$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "Golazo HTTPS setup" \
  --parameters "$(python3 -c "import json,sys; print(json.dumps({'commands':[sys.stdin.read()]}))" <<<"$SSM_DOC")" \
  --query 'Command.CommandId' --output text)

echo "==> SSM command ${CMD_ID} — waiting for completion..."
for i in $(seq 1 60); do
  STATUS=$(aws ssm get-command-invocation --region "$REGION" \
    --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query 'Status' --output text 2>/dev/null || echo "Pending")
  if [[ "$STATUS" == "Success" ]]; then
    aws ssm get-command-invocation --region "$REGION" \
      --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
      --query 'StandardOutputContent' --output text | tail -20
    echo ""
    echo "✅ Golazo is live at https://${DOMAIN}"
    echo "   WebSocket: wss://${DOMAIN}/ws"
    exit 0
  fi
  if [[ "$STATUS" == "Failed" || "$STATUS" == "Cancelled" || "$STATUS" == "TimedOut" ]]; then
    aws ssm get-command-invocation --region "$REGION" \
      --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
      --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
    exit 1
  fi
  sleep 5
done
echo "Timed out waiting for SSM (check command ${CMD_ID} in console)"
exit 1
