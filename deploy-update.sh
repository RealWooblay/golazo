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
  grep -E '^(ANTHROPIC_API_KEY|SOLANA_RPC_URL|AI_MODEL|AI_TIMEOUT_MS|AI_RESOLVE_TIMEOUT_MS|MIN_CONFIDENCE)=' "$BUNDLE_ENV" \
    >>"$SECRETS_TMP" 2>/dev/null || true
fi

# COLD-BUILD MEMORY: this box has ~3.8GB RAM and NO swap; a from-scratch metro build (which the
# cache wipe below forces so source changes actually ship) OOMs with no buffer — that hard-OOM
# is what took the site down. Ensure a 1G swapfile exists so a cold build can page instead of
# being kernel-killed. Idempotent + best-effort: never abort the deploy on swap setup.
if ! swapon --show 2>/dev/null | grep -q .; then
  ( fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 ) \
    && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile || true
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
# SOLANA_RPC_URL — set via services/feed/.env.deploy (Helius key stays server-side).
# Client uses https://<domain>/rpc (proxied to this URL).
GOLAZO_PROGRAM_ID=3Ej5xzfeW9LFMK55JA1gZ7ew5hqkL8S7zh2tHabGmYYM
USX_MINT=6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG
OPERATOR_KEYPAIR=./operator-keypair.json
RAKE=0.06
FEE_RECIPIENT=5kBBKSV2EUyLsa2sXoK9E1VVzmDXCaHnQiMfz8B8yJtP
BASE_SEED=0
BOT_COUNT=24
CHAIN_SEED_LAMPORTS=0
CHAIN_LOCK_GRACE_MS=0
AI_TIMEOUT_MS=4000
AI_RESOLVE_TIMEOUT_MS=6000
MIN_CONFIDENCE=0.6
BET_DELAY_MS=5000
BET_SAFETY_BUFFER_MS=2000
# Enhancer OFF: market titles come from the curated, clean templates only (no AI re-wording /
# "slop"). The director stays ON — AI still chooses WHICH market to open, not its wording.
AI_ENHANCER=0
AI_DIRECTOR=1
ENV
if [ -s "$SECRETS_TMP" ]; then cat "$SECRETS_TMP" >>/opt/golazo/services/feed/.env; fi
rm -f "$SECRETS_TMP"
if [ -f /opt/golazo/services/feed/.env.deploy ]; then
  cat /opt/golazo/services/feed/.env.deploy >>/opt/golazo/services/feed/.env
fi
# FINAL authority: the enhancer stays OFF no matter what a box-local .env.deploy says.
# Curated clean titles only — the director (which market to open) still respects .env.deploy.
sed -i '/^AI_ENHANCER=/d' /opt/golazo/services/feed/.env
echo 'AI_ENHANCER=0' >>/opt/golazo/services/feed/.env

# Log AI layer state (never print the key).
HAS_KEY=0
grep -q '^ANTHROPIC_API_KEY=.' /opt/golazo/services/feed/.env 2>/dev/null && HAS_KEY=1
ENH=$(grep -E '^AI_ENHANCER=' /opt/golazo/services/feed/.env 2>/dev/null | tail -1 | cut -d= -f2)
DIR=$(grep -E '^AI_DIRECTOR=' /opt/golazo/services/feed/.env 2>/dev/null | tail -1 | cut -d= -f2)
echo "GOLAZO_ENV enhancer=$([ "$ENH" = 1 ] && [ "$HAS_KEY" = 1 ] && echo on || echo off) director=$([ "$DIR" = 1 ] && [ "$HAS_KEY" = 1 ] && echo on || echo off) key=$([ "$HAS_KEY" = 1 ] && echo set || echo missing)"
HAS_RPC=0
grep -q '^SOLANA_RPC_URL=.' /opt/golazo/services/feed/.env 2>/dev/null && HAS_RPC=1
echo "GOLAZO_ENV solana_rpc=$([ "$HAS_RPC" = 1 ] && echo configured || echo MISSING)"
if [ "$HAS_RPC" != 1 ]; then
  echo "ABORT: SOLANA_RPC_URL missing from feed .env — refusing restart (real-money RPC would break)." >&2
  exit 1
fi

cd /opt/golazo/apps/mobile
# Prefer a PREBUILT web bundle shipped in the tarball (built on the dev machine, which has the
# RAM for a cold metro build — this 3.8GB box OOMs on one, which is what took the site down).
# EXPO_PUBLIC_* are baked at build time, so a shipped dist is served as-is. Only build here if
# no dist was shipped.
# If dist exists but index.html is missing (stale partial tree), treat as no bundle.
if [ -f dist/index.html ] && [ -n "$(ls -A dist/_expo/static/js/web/entry-*.js 2>/dev/null)" ]; then
  echo "[deploy] using prebuilt web bundle from tarball: $(ls dist/_expo/static/js/web/entry-*.js 2>/dev/null | head -1)"
else
  echo "[deploy] no prebuilt dist in tarball — building on the box"
  rm -rf dist .expo /opt/golazo/.expo
# Wipe EVERY transform cache, or a redeploy reuses stale output and serves an OLD bundle even
# though the source changed (confirmed: source on box had the fix, built bundle did not). With
# EXPO_USE_METRO_WORKSPACE_ROOT the metro + expo caches live at the WORKSPACE root and ~/.expo,
# not just apps/mobile — clear them all with hardcoded paths (the TMPDIR glob alone was missing
# /root/.expo and /tmp/metro-cache, which is what kept pinning the bundle).
rm -rf node_modules/.cache /opt/golazo/node_modules/.cache \
       "$HOME/.expo" /root/.expo \
       /tmp/metro-* /tmp/haste-map-* /tmp/metro-cache \
       "${TMPDIR:-/tmp}/metro-"* "${TMPDIR:-/tmp}/haste-map-"* 2>/dev/null || true
if [ -n "$GOLAZO_DOMAIN" ]; then
    NODE_OPTIONS=--max-old-space-size=3072 \
    EXPO_USE_METRO_WORKSPACE_ROOT=1 \
    EXPO_PUBLIC_FEED_URL="${FEED_URL}" \
    EXPO_PUBLIC_CHAIN_ENABLED=1 \
    EXPO_PUBLIC_SOLANA_CLUSTER=mainnet-beta \
    EXPO_PUBLIC_GOLAZO_PROGRAM_ID=3Ej5xzfeW9LFMK55JA1gZ7ew5hqkL8S7zh2tHabGmYYM \
    EXPO_PUBLIC_USX_MINT=6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG \
    EXPO_PUBLIC_BET_DELAY_MS=5000 \
    npx expo export -p web --clear
  else
    NODE_OPTIONS=--max-old-space-size=3072 \
    EXPO_USE_METRO_WORKSPACE_ROOT=1 \
    EXPO_PUBLIC_CHAIN_ENABLED=1 \
    EXPO_PUBLIC_SOLANA_CLUSTER=mainnet-beta \
    EXPO_PUBLIC_GOLAZO_PROGRAM_ID=3Ej5xzfeW9LFMK55JA1gZ7ew5hqkL8S7zh2tHabGmYYM \
    EXPO_PUBLIC_USX_MINT=6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG \
    EXPO_PUBLIC_BET_DELAY_MS=5000 \
    npx expo export -p web --clear
  fi
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
  if (url.pathname === '/health' || url.pathname === '/metrics' || url.pathname === '/audit' || url.pathname.startsWith('/state') || url.pathname === '/rpc' || url.pathname === '/rpc/') {
    proxy.web(req, res, { target: `http://127.0.0.1:${FEED_PORT}` });
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path === '/') path = '/index.html';
  let file = join(root, path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  // HTML entry points must NEVER be cached: they point to the content-hashed JS bundle, so a
  // cached index.html keeps an old bundle alive forever (the "demo still voids / sponsored fail"
  // staleness). no-store (not just no-cache, which the browser can serve without a validator
  // since we emit no ETag) guarantees every load fetches fresh HTML → latest bundle. Hashed
  // assets stay immutable (safe — the hash changes when content does).
  res.setHeader(
    'Cache-Control',
    file.endsWith('.html') ? 'no-store, no-cache, must-revalidate' : 'public, max-age=31536000, immutable',
  );
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
