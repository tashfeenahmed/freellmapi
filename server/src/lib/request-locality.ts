import type { Request } from 'express';

// Is this request from a client on this machine?
//
// Locality is an elevation: it exempts first-run setup from the one-time setup
// code, opens Ollama "open-loopback" inference without a key, and hands desktop
// installs a session and key export without a password. Every one of those
// surfaces asks THIS function, so they all follow one policy, and the policy
// fails closed: when the client's identity cannot be established, the request
// is remote.
//
// The hard case is a reverse proxy on the same host. It connects from
// 127.0.0.1 for every client on the internet, and the forwarding headers it
// adds are partly client-written: nginx keeps a client's own X-Forwarded-For
// under `$proxy_add_x_forwarded_for`, and passes it through untouched when the
// config sets only X-Real-IP. A misconfigured proxy (a bare `proxy_pass`) adds
// nothing at all. The rules below are layered so that a proxy configured
// slightly wrong still lands on "remote":
//
//  0. DISABLE_LOCAL_TRUST=true turns locality off entirely. Nothing, not even
//     a loopback socket, is local. This is the switch for any deployment behind
//     a reverse proxy, where the server cannot tell the proxy from a local user.
//  1. The socket peer must be loopback. Headers can never make a remote socket
//     local.
//  2. HTTP/1.0 is never local. nginx speaks HTTP/1.0 to its upstream unless
//     `proxy_http_version` is set; browsers and API clients use HTTP/1.1+.
//  3. The Host header must be a loopback name (localhost, a 127/8 or ::1
//     literal, or the 0.0.0.0/:: wildcards a local user may type). A proxy that
//     forwards the public Host (`proxy_set_header Host $host`, Caddy, Traefik)
//     is caught here, and so is a DNS-rebinding page.
//  4. Any proxy marker (X-Forwarded-*, Forwarded, X-Real-IP, Via, CDN client
//     headers) means the socket peer is a proxy, not the client:
//       a. Only X-Forwarded-For can be checked against TRUST_PROXY. Forwarded
//          and CDN client headers cannot, so they fail closed. X-Real-IP can
//          never grant locality on its own.
//       b. TRUST_PROXY must name a hop count or an address list. Unset trusts
//          nothing; `true` makes the client-written left-most entry the client.
//       c. Every X-Forwarded-For entry must be a well-formed IP address.
//       d. The client Express resolves through the trusted hops (req.ip) must
//          be loopback.
//       e. If X-Real-IP is present it must be a single address equal to that
//          client. A trusted proxy that sets X-Real-IP has stated the client;
//          a client-written X-Forwarded-For that disagrees must not win.

/** Set to true to disable every local-machine shortcut (see rule 0). */
export const DISABLE_LOCAL_TRUST_ENV = 'DISABLE_LOCAL_TRUST';

/** Headers whose presence means a proxy or CDN sits between us and the client. */
const PROXY_MARKER_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'x-forwarded-prefix',
  'via',
  'true-client-ip',
  'cf-connecting-ip',
  'fastly-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-original-forwarded-for',
] as const;

/** Markers that name the client in a form TRUST_PROXY cannot verify. */
const UNVERIFIABLE_IDENTITY_HEADERS = [
  'forwarded',
  'true-client-ip',
  'cf-connecting-ip',
  'fastly-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-original-forwarded-for',
] as const;

let warnedInvalidSetting = false;

/** Whether DISABLE_LOCAL_TRUST switches locality off. Unrecognised values fail
 *  closed (disabled) with a one-time warning, since a typo in a security
 *  switch must not leave the shortcuts open. */
export function isLocalTrustDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DISABLE_LOCAL_TRUST_ENV];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'false' || value === '0' || value === 'no' || value === 'off') return false;
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true;
  if (!warnedInvalidSetting) {
    warnedInvalidSetting = true;
    console.warn(`[security] ${DISABLE_LOCAL_TRUST_ENV}=${JSON.stringify(raw)} is not true/false; treating it as true (local-machine trust disabled).`);
  }
  return true;
}

/** Boot-time advice: TRUST_PROXY says a reverse proxy is in front, and a
 *  proxy that adds no forwarding header (a bare `proxy_pass` with
 *  `proxy_http_version 1.1`) is indistinguishable from a local user. Returns
 *  the warning to log, or null when nothing needs saying. */
export function localTrustStartupWarning(trustProxy: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!trustProxy || env[DISABLE_LOCAL_TRUST_ENV] !== undefined) return null;
  return `[security] TRUST_PROXY is set but ${DISABLE_LOCAL_TRUST_ENV} is not. If every client reaches this server through the reverse proxy, ` +
    `set ${DISABLE_LOCAL_TRUST_ENV}=true so no request is treated as coming from this machine (setup without the code, Ollama open-loopback, desktop shortcuts). ` +
    `Set ${DISABLE_LOCAL_TRUST_ENV}=false to keep them and silence this warning.`;
}

/** Strict IPv4 dotted quad: four 0-255 octets, no leading zeros. */
function isIPv4(addr: string): boolean {
  const parts = addr.split('.');
  return parts.length === 4 && parts.every(p => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

/** IPv6 text form, including an embedded IPv4 tail. Rejects zone ids. */
function isIPv6(addr: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(addr) || !addr.includes(':')) return false;
  let groups = addr;
  let tailGroups = 0;
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return false;
    groups = addr.slice(0, lastColon + 1) + '0';
    tailGroups = 1;
  }
  const halves = groups.split('::');
  if (halves.length > 2) return false;
  const count = (s: string) => (s === '' ? [] : s.split(':'));
  const head = count(halves[0]!);
  const rest = halves.length === 2 ? count(halves[1]!) : [];
  const all = [...head, ...rest];
  if (!all.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return false;
  const total = all.length + tailGroups;
  return halves.length === 2 ? total <= 7 : total === 8;
}

/** A single, well-formed IPv4 or IPv6 address. */
export function isIpAddress(value: string): boolean {
  return isIPv4(value) || isIPv6(value);
}

function normalizeAddress(value: string): string {
  let addr = value.trim().toLowerCase();
  // Node reports IPv4 over a dual-stack socket as "::ffff:127.0.0.1".
  if (addr.startsWith('::ffff:') && isIPv4(addr.slice(7))) addr = addr.slice(7);
  return addr;
}

/** True for 127.0.0.0/8, ::1, and their IPv4-mapped IPv6 forms. */
export function isLoopbackAddress(value: string | undefined | null): boolean {
  const addr = normalizeAddress(value ?? '');
  if (addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true;
  return isIPv4(addr) && addr.startsWith('127.');
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers?.[name];
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'string' ? value : undefined;
}

function hasHeader(req: Request, name: string): boolean {
  return (headerValue(req, name) ?? '').trim() !== '';
}

/** Host header names a local user can type for this machine. A proxy that
 *  forwards the public Host, and a DNS-rebinding page, both fail this. */
function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host.trim()}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '[::]') return true;
  if (hostname.startsWith('[') && hostname.endsWith(']')) return isLoopbackAddress(hostname.slice(1, -1));
  return isIPv4(hostname) && hostname.startsWith('127.');
}

export function isLocalRequest(req: Request): boolean {
  if (isLocalTrustDisabled()) return false;
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  if (req.httpVersion === '1.0') return false;
  if (!isLoopbackHostHeader(headerValue(req, 'host'))) return false;

  const proxied = PROXY_MARKER_HEADERS.some(name => hasHeader(req, name));
  if (!proxied) return true;

  // Rule 4: proxied. Establish the client through TRUST_PROXY or refuse.
  if (UNVERIFIABLE_IDENTITY_HEADERS.some(name => hasHeader(req, name))) return false;
  if (!hasHeader(req, 'x-forwarded-for')) return false;

  const trustSetting = req.app?.get?.('trust proxy') as unknown;
  if (!trustSetting || trustSetting === true) return false;

  const entries = (headerValue(req, 'x-forwarded-for') ?? '').split(',').map(s => s.trim());
  if (!entries.every(isIpAddress)) return false;

  // req.ip: walking from the socket peer, the first hop TRUST_PROXY does not
  // trust. Express computes it from the same `trust proxy` setting.
  const client = req.ip;
  if (!client || !isLoopbackAddress(client)) return false;

  const realIp = headerValue(req, 'x-real-ip');
  if (realIp !== undefined && realIp.trim() !== '') {
    const stated = realIp.trim();
    if (!isIpAddress(stated)) return false;
    if (normalizeAddress(stated) !== normalizeAddress(client)) return false;
  }

  return true;
}
