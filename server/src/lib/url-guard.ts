import dns from 'node:dns';
import net from 'node:net';

// Outbound guard for user-supplied custom-provider base URLs (#440).
//
// A custom provider's base_url is the one place an authenticated dashboard
// user controls where the server sends requests. Left unchecked that is an
// SSRF vector: point base_url at a cloud metadata service and the proxy will
// happily fetch IAM credentials and echo them back through the completions
// response path.
//
// Policy, calibrated for a local-first app whose primary documented use case
// is pointing at llama.cpp / Ollama / LM Studio on localhost or the LAN:
//
//   - Cloud metadata addresses and link-local ranges: ALWAYS blocked.
//     (169.254.0.0/16 incl. 169.254.169.254, fe80::/10, Alibaba's
//     100.100.100.200, AWS's fd00:ec2::254, metadata.google.internal.)
//     No legitimate LLM endpoint lives there and this is the actual
//     credential-theft vector.
//   - Loopback and RFC1918/ULA private ranges: allowed by default so
//     existing local setups keep working, but blocked when the operator
//     sets FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS=true (recommended for
//     instances hosted on a VPS where the dashboard is exposed).
//   - Everything else (public addresses): allowed.
//
// Known limitation: hostnames are resolved and classified here, but the
// actual fetch re-resolves DNS, so a hostile authoritative DNS server could
// still rebind between check and use. Pinning the resolved address into the
// dispatcher is the follow-up hardening step; the always-blocked classes
// above are also re-checked at request time (proxyFetch) which narrows the
// window to deliberate rebinding rather than casual misuse.

export type AddressClass = 'metadata' | 'link-local' | 'loopback' | 'private' | 'public';

const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
]);

// Exact metadata addresses that sit outside the link-local range.
const METADATA_ADDRESSES = new Set([
  '100.100.100.200', // Alibaba Cloud IMDS
  'fd00:ec2::254', // AWS IMDSv2 IPv6
]);

function classifyIpv4(ip: string): AddressClass {
  const octets = ip.split('.').map(Number);
  const [a, b] = octets;
  if (METADATA_ADDRESSES.has(ip)) return 'metadata';
  if (a === 169 && b === 254) return ip === '169.254.169.254' ? 'metadata' : 'link-local';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  // CGNAT range; contains Alibaba's metadata address and is never a place a
  // user-facing LLM endpoint is published.
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 0) return 'loopback'; // 0.0.0.0 → "this host"
  return 'public';
}

function classifyIpv6(ip: string): AddressClass {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return classifyIpv4(mapped[1]);
  if (METADATA_ADDRESSES.has(lower)) return 'metadata';
  if (lower === '::1' || lower === '::') return 'loopback';
  const firstHextet = lower.split(':')[0] || '0';
  const value = parseInt(firstHextet.padStart(4, '0'), 16);
  if ((value & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  if ((value & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 (ULA)
  return 'public';
}

export function classifyIp(ip: string): AddressClass {
  const version = net.isIP(ip);
  if (version === 4) return classifyIpv4(ip);
  if (version === 6) return classifyIpv6(ip);
  return 'public';
}

export interface UrlAssessment {
  allowed: boolean;
  reason?: string;
}

export interface AssessOptions {
  // Injectable for tests; defaults to a real DNS lookup.
  resolve?: (hostname: string) => Promise<string[]>;
  // Overrides the env flag; when true, loopback/private addresses are blocked.
  blockPrivate?: boolean;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map(r => r.address);
}

function blockPrivateEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS ?? '');
}

/**
 * Assess whether an outbound custom-provider URL is safe to contact.
 * Never throws on malformed input — a bad URL comes back as {allowed: false}.
 */
export async function assessProviderUrl(rawUrl: string, opts: AssessOptions = {}): Promise<UrlAssessment> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `unsupported protocol ${url.protocol.replace(/:$/, '')}` };
  }

  // WHATWG URL canonicalises decimal/hex/octal IPv4 forms (http://2852039166/
  // parses to hostname 169.254.169.254), so classifying url.hostname covers
  // those encodings too. IPv6 literals arrive bracketed — strip for net.isIP.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (METADATA_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: 'cloud metadata endpoints are not reachable through custom providers' };
  }

  let addresses: string[];
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await (opts.resolve ?? defaultResolve)(hostname);
    } catch {
      // Unresolvable now may resolve later (device not on the LAN yet, DNS
      // hiccup). Saving is harmless — the request-time check runs again.
      return { allowed: true };
    }
    if (addresses.length === 0) return { allowed: true };
  }

  const blockPrivate = opts.blockPrivate ?? blockPrivateEnabled();
  for (const address of addresses) {
    const cls = classifyIp(address);
    if (cls === 'metadata') {
      return { allowed: false, reason: `resolves to a cloud metadata address (${address})` };
    }
    if (cls === 'link-local') {
      return { allowed: false, reason: `resolves to a link-local address (${address})` };
    }
    if (blockPrivate && (cls === 'loopback' || cls === 'private')) {
      return {
        allowed: false,
        reason: `resolves to a private address (${address}) and FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS is set`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Request-time enforcement: throws when the URL is blocked. Used by
 * proxyFetch for the custom platform so a base_url that slipped into the DB
 * (older install, direct DB edit, DNS change after save) still can't reach a
 * blocked address class.
 */
export async function assertProviderUrlAllowed(rawUrl: string): Promise<void> {
  const verdict = await assessProviderUrl(rawUrl);
  if (!verdict.allowed) {
    throw new Error(`Custom provider URL blocked: ${verdict.reason}`);
  }
}
