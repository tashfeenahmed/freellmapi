import type { Request } from 'express';

export function isLoopbackAddress(value: string | undefined): boolean {
  let addr = (value ?? '').trim();
  // Node reports IPv4 loopback over a dual-stack socket as "::ffff:127.0.0.1".
  if (addr.toLowerCase().startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

// Is the caller on this machine? The socket peer address is the authority,
// NOT req.ip: forwarded headers are caller-controlled, so letting one of them
// ASSERT locality would hand a remote caller the exemption outright.
//
// The socket peer alone is not enough either: the documented reverse-proxy
// setup (docs/en/proxy/OVERVIEW.md) puts Caddy/nginx/Traefik on the SAME host,
// so every request arrives from 127.0.0.1. Forwarded headers can therefore
// only WITHDRAW locality, never grant it:
//  - X-Forwarded-For: EVERY hop must be loopback. nginx's
//    $proxy_add_x_forwarded_for appends the real client after whatever the
//    caller sent, so a spoofed "127.0.0.1" lands first and the real remote
//    address last.
//  - X-Real-IP, CF-Connecting-IP, True-Client-IP, X-Client-IP: single-IP
//    headers a proxy, tunnel or CDN may set instead of X-Forwarded-For.
//  - Forwarded (RFC 7239): a browser never sends it, so its presence means a
//    proxy is in front; not parsed, it just withdraws locality.
//  - TRUST_PROXY (Express `trust proxy`, app.ts): the operator declared a proxy.
//    A bare nginx `proxy_pass` sends none of the headers above, so without this
//    every internet caller would look like a loopback socket.
const CLIENT_IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip'];

export function isLocalRequest(req: Request): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  if (req.app?.get('trust proxy')) return false;
  if (req.headers.forwarded) return false;
  const hops = CLIENT_IP_HEADERS.map(name => req.headers[name])
    .flat()
    .flatMap(value => (value ?? '').split(','))
    .map(hop => hop.trim())
    .filter(Boolean);
  return hops.every(isLoopbackAddress);
}
