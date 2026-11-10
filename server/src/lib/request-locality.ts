import type { Request } from 'express';

// Is this request from a client on this machine?
//
// Locality is an elevation: it exempts first-run setup from the one-time setup
// code, opens Ollama "open-loopback" inference without a key, and hands desktop
// installs a session and key export without a password. So the answer has to
// fail closed.
//
// A loopback socket on its own is not enough. A reverse proxy on the same host
// (Caddy/nginx/Traefik, the documented deployment) connects from 127.0.0.1 for
// every client on the internet. The forwarded headers that proxy adds are not
// enough either, because the client writes part of them. With nginx's usual
// `$proxy_add_x_forwarded_for`, a remote client that sends
// `X-Forwarded-For: 127.0.0.1` reaches us as `127.0.0.1, <real ip>`. Neither
// the first nor the last entry can be taken on faith without knowing how many
// hops in the chain are ours.
//
// The rule:
//  1. The socket peer must be loopback. A forwarded header can never grant
//     locality to a remote socket.
//  2. No client-identity forwarding header: a direct local client. Local.
//  3. Forwarding headers present: the request came through a proxy, and only
//     the operator's TRUST_PROXY setting says which hops are trustworthy.
//     Express walks X-Forwarded-For from the socket peer leftwards, skipping
//     only hops TRUST_PROXY trusts, and stops at the first untrusted address
//     (req.ip). Locality holds only if that address is loopback.
//       - TRUST_PROXY unset/false: nothing is trusted, so a proxied request is
//         never local.
//       - TRUST_PROXY=true trusts every hop, which makes req.ip the left-most
//         entry, the one the client wrote. Never local.
//       - A proxy identity header without X-Forwarded-For (X-Real-IP,
//         Forwarded, ...) cannot be checked through Express's trust chain.
//         Never local.

/** Headers a reverse proxy or CDN uses to name the original client. The
 *  presence of any of them means the socket peer is not the client. */
const CLIENT_IDENTITY_HEADERS = [
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'fastly-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
] as const;

/** True for 127.0.0.0/8, ::1, and their IPv4-mapped IPv6 forms. */
export function isLoopbackAddress(value: string | undefined | null): boolean {
  let addr = (value ?? '').trim().toLowerCase();
  // Node reports IPv4 loopback over a dual-stack socket as "::ffff:127.0.0.1".
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  return !!m && m.slice(1).every(octet => Number(octet) <= 255);
}

function hasHeader(req: Request, name: string): boolean {
  const value = req.headers?.[name];
  if (Array.isArray(value)) return value.some(v => v.trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

export function isLocalRequest(req: Request): boolean {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;

  const proxied = CLIENT_IDENTITY_HEADERS.some(name => hasHeader(req, name));
  if (!proxied) return true;

  // Proxied: only an explicit, bounded trust configuration can name the client.
  const trustSetting = req.app?.get?.('trust proxy') as unknown;
  if (!trustSetting || trustSetting === true) return false;
  if (!hasHeader(req, 'x-forwarded-for')) return false;

  // Express resolves req.ip through `trust proxy fn`: the first address,
  // walking from the socket peer, that TRUST_PROXY does not trust.
  return isLoopbackAddress(req.ip);
}
