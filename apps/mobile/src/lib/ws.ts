import type { ClientMessage, ServerMessage } from "@golazo/core";

/**
 * Typed WebSocket client for LIVE mode.
 *
 * Thin wrapper over the browser/RN `WebSocket` that:
 *   - sends only well-typed `ClientMessage`s,
 *   - parses every inbound frame into a `ServerMessage` (both shapes come from
 *     @golazo/core's protocol, so client and server can never drift),
 *   - exposes lifecycle callbacks the hook uses to drive the UI and to fall
 *     back to offline mode on failure.
 *
 * It does NOT auto-reconnect: the live loop's policy is "if the socket drops,
 * fall back to OFFLINE and tell the user" (see useGameFeed). Keeping reconnection
 * out of here keeps that policy in one place.
 */

export interface FeedSocketHandlers {
  onMessage: (msg: ServerMessage) => void;
  onOpen?: () => void;
  /** Fired on connection error OR close — the hook treats both as "go offline". */
  onClose?: (reason: string) => void;
}

export interface FeedSocket {
  /** Returns true only if the frame was actually written to an OPEN socket. */
  send: (msg: ClientMessage) => boolean;
  close: () => void;
}

export function connectFeed(
  url: string,
  handlers: FeedSocketHandlers,
): FeedSocket {
  const ws = new WebSocket(url);
  let closed = false;

  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    handlers.onClose?.(reason);
  };

  ws.onopen = () => handlers.onOpen?.();

  ws.onmessage = (event: WebSocketMessageEvent) => {
    try {
      // The server only ever sends JSON-encoded ServerMessages. We trust the
      // shape because both ends share the protocol type; a malformed frame is a
      // server bug and is dropped rather than crashing the UI.
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      handlers.onMessage(msg);
    } catch {
      // Ignore unparseable frames — never let the feed take down the screen.
    }
  };

  // RN surfaces both error and close; we collapse them into one "offline" signal.
  ws.onerror = () => finish("connection error");
  ws.onclose = (e: WebSocketCloseEvent) =>
    finish(`socket closed (${e.code ?? "n/a"})`);

  return {
    send: (msg: ClientMessage) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    close: () => {
      closed = true; // suppress the onClose -> fallback when WE close on purpose
      ws.close();
    },
  };
}
