/**
 * Solana JSON-RPC proxy — keeps the upstream RPC URL (and any API key) on the
 * server. The mobile/web client points at `/rpc` on the same host as the feed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 256 * 1024;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
} as const;

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Forward POST /rpc to the configured Solana RPC endpoint. */
export async function handleRpcProxy(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamUrl: string,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, CORS);
    res.end();
    return;
  }

  try {
    const body = await readBody(req, MAX_BODY_BYTES);
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      ...CORS,
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'body too large') {
      res.writeHead(413, CORS);
      res.end();
      return;
    }
    console.error('[golazo/feed] rpc proxy error:', msg);
    res.writeHead(502, { ...CORS, 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'rpc proxy unavailable' },
        id: null,
      }),
    );
  }
}
