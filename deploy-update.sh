#!/bin/bash
# In-place update for a running Golazo EC2 instance (no user-data re-run needed).
set -euxo pipefail

cd /opt/golazo
aws s3 cp s3://golazo-deploy-050752647977-20260620092236/golazo.tgz /opt/golazo.tgz
tar -xzf /opt/golazo.tgz -C /opt/golazo

# Secrets ship inside the tarball's gitignored services/feed/.env (from the build
# machine). Extract them BEFORE we overwrite .env with production defaults.
BUNDLE_ENV=/opt/golazo/services/feed/.env
SECRETS_TMP=$(mktemp)
if [ -f "$BUNDLE_ENV" ]; then
  grep -E '^(ANTHROPIC_API_KEY|AI_MODEL|AI_TIMEOUT_MS|AI_RESOLVE_TIMEOUT_MS|MIN_CONFIDENCE)=' "$BUNDLE_ENV" \
    >>"$SECRETS_TMP" 2>/dev/null || true
fi

npm install --include=dev
npm run build --workspace @golazo/core

TOKEN="$(curl -sS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600' || true)"
if [ -n "$TOKEN" ]; then
  PUBLIC_IP="$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)"
else
  PUBLIC_IP="$(curl -sS http://169.254.169.254/latest/meta-data/public-ipv4)"
fi
GOLAZO_DOMAIN="${GOLAZO_DOMAIN:-golazo.wooblay.com}"
if [ -n "$GOLAZO_DOMAIN" ]; then
  FEED_URL="wss://${GOLAZO_DOMAIN}/ws"
  WEB_PORT=8080
else
  FEED_URL="ws://${PUBLIC_IP}/ws"
  WEB_PORT=80
fi

cat >/opt/golazo/services/feed/.env <<ENV
PORT=8787
FEED_MODE=espn
ESPN_POLL_MS=2500
ESPN_LEAGUE=fifa.world
ESPN_COMMENTARY_LANG=dual
CHAIN_ENABLED=1
SOLANA_RPC_URL=https://api.devnet.solana.com
GOLAZO_PROGRAM_ID=GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu
OPERATOR_KEYPAIR=./operator-keypair.json
RAKE=0.06
FEE_RECIPIENT=5kBBKSV2EUyLsa2sXoK9E1VVzmDXCaHnQiMfz8B8yJtP
BASE_SEED=12345
BOT_COUNT=24
CHAIN_SEED_LAMPORTS=1000000
AI_TIMEOUT_MS=4000
AI_RESOLVE_TIMEOUT_MS=6000
MIN_CONFIDENCE=0.6
BET_DELAY_MS=5000
BET_SAFETY_BUFFER_MS=2000
ENV
if [ -s "$SECRETS_TMP" ]; then cat "$SECRETS_TMP" >>/opt/golazo/services/feed/.env; fi
rm -f "$SECRETS_TMP"
if [ -f /opt/golazo/services/feed/.env.deploy ]; then
  cat /opt/golazo/services/feed/.env.deploy >>/opt/golazo/services/feed/.env
fi

# Log whether AI is active (never print the key).
if grep -q '^ANTHROPIC_API_KEY=.' /opt/golazo/services/feed/.env 2>/dev/null; then
  echo "GOLAZO_ENV watcher=ai"
else
  echo "GOLAZO_ENV watcher=rules(no ANTHROPIC_API_KEY)"
fi

cd /opt/golazo/apps/mobile
rm -rf dist
if [ -n "$GOLAZO_DOMAIN" ]; then
    EXPO_USE_METRO_WORKSPACE_ROOT=1 \
    EXPO_PUBLIC_FEED_URL="${FEED_URL}" \
    EXPO_PUBLIC_CHAIN_ENABLED=1 \
    EXPO_PUBLIC_SOLANA_CLUSTER=devnet \
    EXPO_PUBLIC_GOLAZO_PROGRAM_ID=GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu \
    EXPO_PUBLIC_BET_DELAY_MS=5000 \
    npx expo export -p web
  else
    EXPO_USE_METRO_WORKSPACE_ROOT=1 \
    EXPO_PUBLIC_CHAIN_ENABLED=1 \
    EXPO_PUBLIC_SOLANA_CLUSTER=devnet \
    EXPO_PUBLIC_GOLAZO_PROGRAM_ID=GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu \
    EXPO_PUBLIC_BET_DELAY_MS=5000 \
    npx expo export -p web
fi

cat >/opt/golazo/static-server.mjs <<'JS'
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import httpProxy from 'http-proxy';

const root = '/opt/golazo/apps/mobile/dist';
const FEED_PORT = 8787;
const WEB_PORT = __WEB_PORT__;
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
  if (url.pathname === '/health' || url.pathname === '/metrics' || url.pathname === '/audit' || url.pathname.startsWith('/state')) {
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

server.listen(WEB_PORT, '0.0.0.0', () => {
  console.log(`[golazo-web] listening on :${WEB_PORT} (static + /ws proxy → :8787)`);
});
JS
sed -i "s/__WEB_PORT__/${WEB_PORT}/g" /opt/golazo/static-server.mjs

cd /opt/golazo
npm install http-proxy --no-save

systemctl restart golazo-feed
systemctl restart golazo-web

echo "GOLAZO_UPDATED ${GOLAZO_DOMAIN:+https://${GOLAZO_DOMAIN} }http://${PUBLIC_IP} ${FEED_URL}" >/opt/golazo/READY
