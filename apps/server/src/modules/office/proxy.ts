import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { AppContext } from '../../context';
import { editingEnabled } from './editor';

// What browsers use: the editor's pages and scripts (/browser/…), its WebSocket and clipboard
// (/cool/…). The editor accepts its conversion and admin endpoints from any private address,
// which every request through here comes from, so those never get through: anyone on the
// internet could otherwise convert files on this server, or try the admin console.
const ALLOWED = /^\/(browser|cool|hosting)\//;
const BLOCKED =
  /^\/(cool\/(convert-to|extract-|get-thumbnail|render-|adminws|getMetrics)|browser\/[^/]+\/admin|hosting\/discovery)/i;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function allowed(url: string | undefined): url is string {
  if (!url?.startsWith('/')) return false;
  const raw = url.split('?')[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return false;
  }
  // As sent and as decoded: the WebSocket's path carries the file's encoded WOPI address, and
  // a blocked path must not get through spelled differently (encoded, or with dot segments).
  return [raw, decoded].every(
    (p) => ALLOWED.test(p) && !BLOCKED.test(p) && !/\\|\/\.\.?(\/|$)/.test(p),
  );
}

/**
 * Request headers for the editor. Cookies stay behind: none are the editor's, and on a LAN
 * install the app's sign-in cookie is sent here too (cookies ignore the port).
 */
function forwarded(headers: IncomingHttpHeaders, upgrade: boolean): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'cookie' || (!upgrade && HOP_BY_HOP.has(k))) continue;
    out[k] = v;
  }
  return out;
}

function page(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Document editor</title><body style="font:16px system-ui;margin:3rem;color:#444"><p>${message}</p>`,
  );
}

/**
 * Passes browsers through to the editor container (OFFICE_PROXY_PORT, what OFFICE_PUBLIC_URL
 * is routed to), so the container itself needs no route to the internet. Plain HTTP and
 * WebSockets; the Host header goes through unchanged, for the addresses the editor writes into
 * its pages. Nothing is logged: the editor's addresses carry access tokens.
 */
export function createEditorProxy(ctx: AppContext): http.Server {
  const office = ctx.config.office;
  if (!office) throw new Error('The document editor is not set up (OFFICE_PUBLIC_URL)');
  const target = new URL(office.internalUrl);
  const host = target.hostname;
  const port = Number(target.port || 80);

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!allowed(req.url)) return page(res, 404, 'Not found.');
    if (!(await editingEnabled(ctx).catch(() => false))) {
      return page(res, 503, 'Editing documents in the browser is turned off on this server.');
    }
    const upstream = http.request(
      { host, port, method: req.method, path: req.url, headers: forwarded(req.headers, false) },
      (up) => {
        const headers: IncomingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (!HOP_BY_HOP.has(k)) headers[k] = v;
        }
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        page(res, 502, "The document editor isn't answering. It may still be starting.");
      } else res.destroy();
    });
    req.pipe(upstream);
  });

  server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const refuse = (status: string) =>
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    if (!allowed(req.url)) return refuse('404 Not Found');
    if (!(await editingEnabled(ctx).catch(() => false))) return refuse('503 Service Unavailable');
    const up = net.connect(port, host, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(forwarded(req.headers, true))) {
        for (const value of Array.isArray(v) ? v : [v]) {
          if (value !== undefined) lines.push(`${k}: ${value}`);
        }
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('close', () => up.destroy());
    up.on('close', () => socket.destroy());
  });

  return server;
}
