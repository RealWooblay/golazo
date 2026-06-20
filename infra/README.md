# Golazo HTTPS + domain

Production URL (once DNS is live): **https://golazo.wooblay.com**

## Current AWS state

| Item | Value |
|------|--------|
| EC2 | `i-0c6e6843d8ac4c15e` (eu-central-1) |
| Elastic IP | `3.74.18.103` |
| Caddy | TLS on :443, proxies → golazo-web :8080 |
| Feed | localhost :8787 only (public :8787 closed) |
| WebSocket | `wss://golazo.wooblay.com/ws` (same-origin after HTTPS) |

## One manual step: GoDaddy DNS

`wooblay.com` uses **GoDaddy nameservers** (`domaincontrol.com`), not Route53.
The Route53 A record in this account is **not authoritative** until NS are migrated.

In **GoDaddy → DNS → wooblay.com**, add:

| Type | Host | Value | TTL |
|------|------|-------|-----|
| A | `golazo` | `3.74.18.103` | 600 |

After propagation (~5–15 min), Caddy will auto-issue a Let's Encrypt cert.
Check: `curl https://golazo.wooblay.com/health`

## Re-run setup

```bash
GOLAZO_DOMAIN=golazo.wooblay.com ./infra/setup-golazo-https.sh
```

## Deploy updates with domain

```bash
GOLAZO_DOMAIN=golazo.wooblay.com bash deploy-update.sh
```

When `GOLAZO_DOMAIN` is set, the SPA uses same-origin `wss://` (no baked-in IP).
