#!/bin/bash
set -euxo pipefail

exec > >(tee /var/log/golazo-bootstrap.log | logger -t golazo-bootstrap -s 2>/dev/console) 2>&1

dnf update -y
dnf install -y nodejs npm awscli

mkdir -p /opt/golazo
aws s3 cp s3://golazo-deploy-050752647977-20260620092236/golazo.tgz /opt/golazo.tgz
tar -xzf /opt/golazo.tgz -C /opt/golazo

cd /opt/golazo
npm install --include=dev
npm run build --workspace @golazo/core

TOKEN="$(curl -sS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600' || true)"
if [ -n "$TOKEN" ]; then
  PUBLIC_IP="$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)"
else
  PUBLIC_IP="$(curl -sS http://169.254.169.254/latest/meta-data/public-ipv4)"
fi
# Same-origin WebSocket via the static server proxy (/ws → localhost:8787).
FEED_URL="ws://${PUBLIC_IP}/ws"

# Feed service env — AI key + operator keypair are bundled in the tarball (gitignored locally).
cat >/opt/golazo/services/feed/.env <<ENV
PORT=8787
FEED_MODE=auto
ESPN_LEAGUE=fifa.world
CHAIN_ENABLED=1
SOLANA_RPC_URL=https://api.devnet.solana.com
GOLAZO_PROGRAM_ID=GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu
OPERATOR_KEYPAIR=./operator-keypair.json
RAKE=0.06
FEE_RECIPIENT=5kBBKSV2EUyLsa2sXoK9E1VVzmDXCaHnQiMfz8B8yJtP
BASE_SEED=12345
BOT_COUNT=24
CHAIN_SEED_LAMPORTS=1000000
ENV

# Append secrets from the tarball's local .env if present (ANTHROPIC_API_KEY, etc.).
if [ -f /opt/golazo/services/feed/.env.deploy ]; then
  cat /opt/golazo/services/feed/.env.deploy >>/opt/golazo/services/feed/.env
fi

cat >/etc/systemd/system/golazo-feed.service <<'SERVICE'
[Unit]
Description=Golazo feed websocket
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/golazo
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run start --workspace @golazo/feed
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now golazo-feed

cd /opt/golazo/apps/mobile
EXPO_USE_METRO_WORKSPACE_ROOT=1 \
EXPO_PUBLIC_FEED_URL="${FEED_URL}" \
EXPO_PUBLIC_CHAIN_ENABLED=1 \
EXPO_PUBLIC_SOLANA_CLUSTER=devnet \
EXPO_PUBLIC_GOLAZO_PROGRAM_ID=GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu \
npx expo export -p web

cat >/opt/golazo/static-server.mjs <<'JS'
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import httpProxy from 'http-proxy';

const root = '/opt/golazo/apps/mobile/dist';
const FEED_PORT = 8787;
const proxy = httpProxy.createProxyServer({ ws: true, target: `http://127.0.0.1:${FEED_PORT}` });

const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    proxy.web(req, res, { target: `http://127.0.0.1:${FEED_PORT}` });
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path === '/') path = '/index.html';
  let file = join(root, path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  res.setHeader('Cache-Control', file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', types.get(extname(file)) ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/ws' || url.pathname === '/ws/') {
    req.url = '/';
    proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${FEED_PORT}` });
    return;
  }
  socket.destroy();
});

proxy.on('error', (err, req, res) => {
  console.error('[golazo-web] proxy error:', err.message);
  if (res && !res.headersSent) {
    res.writeHead(502);
    res.end('feed unavailable');
  }
});

server.listen(80, '0.0.0.0', () => {
  console.log('[golazo-web] listening on :80 (static + /ws proxy → :8787)');
});
JS

cd /opt/golazo
npm install http-proxy --no-save

cat >/etc/systemd/system/golazo-web.service <<'SERVICE'
[Unit]
Description=Golazo web app
After=network-online.target golazo-feed.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/golazo
ExecStart=/usr/bin/node /opt/golazo/static-server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now golazo-web

echo "GOLAZO_READY http://${PUBLIC_IP} ${FEED_URL}" >/opt/golazo/READY
