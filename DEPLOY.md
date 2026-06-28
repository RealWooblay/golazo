# GOLAZO AWS Redeploy

Production is the EC2 + Caddy stack at `https://golazo.wooblay.com`.

## Current Stack

| Item | Value |
| --- | --- |
| AWS account | `050752647977` |
| Region | `eu-central-1` |
| EC2 instance | `i-0c6e6843d8ac4c15e` |
| Deploy bucket | `s3://golazo-deploy-050752647977-20260620092236` |
| Public URL | `https://golazo.wooblay.com` |
| WebSocket | `wss://golazo.wooblay.com/ws` |

Caddy terminates TLS on `:443` and proxies to `golazo-web` on `:8080`.
The feed listens on localhost `:8787`; public feed traffic goes through `/ws`.

## Redeploy From Local

From the repo root:

```bash
npm run typecheck
GOLAZO_DOMAIN=golazo.wooblay.com ./scripts/deploy-from-local.sh
```

The script:

1. Builds a tarball excluding `node_modules`, `.git`, mobile export output, and program deploy keypairs.
2. Uploads it to `s3://golazo-deploy-050752647977-20260620092236/golazo.tgz`.
3. Runs AWS SSM on `i-0c6e6843d8ac4c15e`.
4. The instance runs `/opt/golazo/deploy-update.sh`, rebuilds the Expo web app, writes the feed env, and restarts `golazo-feed` and `golazo-web`.

## Verify

```bash
aws ssm describe-instance-information \
  --region eu-central-1 \
  --filters Key=InstanceIds,Values=i-0c6e6843d8ac4c15e

curl -sS https://golazo.wooblay.com/health
```

Expected health shape:

```json
{"ok":true,"clients":0,"feed":"empty","watcher":"rules","director":"ai-direct(idle)","playPhase":"calm","lastPollAgeMs":247,"marketsOpen":0}
```

## Provisioning

Use `infra/README.md` only for first-time HTTPS/domain setup or repair:

```bash
GOLAZO_DOMAIN=golazo.wooblay.com ./infra/setup-golazo-https.sh
```

GoDaddy DNS for `wooblay.com` is authoritative, not Route53, unless nameservers are migrated.
