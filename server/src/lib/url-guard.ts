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
// Related: proxyFetch refuses HTTP redirects from custom providers outright —
// following one would re-request the Location target without re-running this
// guard, so a public base_url answering 302 → an internal address would
// otherwise defeat every check in this file.
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

// Exact IPv4 metadata addresses that sit outside the link-local range.
const METADATA_ADDRESSES = new Set([
  '100.100.100.200', // Alibaba Cloud IMDS
  '192.0.0.192', // Oracle Cloud legacy IMDS
]);

// AWS IMDSv2 IPv6 (fd00:ec2::254) as its eight expanded hextets, so every
// spelling (compressed, uncompressed, zero-padded) matches.
const AWS_IMDS_V6 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254];

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

/**
 * Expand an IPv6 literal into its eight 16-bit hextets. Handles `::`
 * compression, an embedded dotted-IPv4 tail (::ffff:169.254.169.254), and
 * zone ids. Returns null for anything that isn't a well-formed address.
 */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  if (s.indexOf('.', lastColon) !== -1) {
    // Dotted-IPv4 tail → fold into the last two hextets.
    const octets = s.slice(lastColon + 1).split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    s = s.slice(0, lastColon + 1)
      + ((octets[0] << 8) | octets[1]).toString(16) + ':'
      + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
  const groups = [...head, ...new Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function classifyIpv6(ip: string): AddressClass {
  const hextets = expandIpv6(ip);
  // net.isIP already vetted the input, so this branch is unreachable in
  // practice — but an unparseable address must not classify as public.
  if (!hextets) return 'link-local';
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  const embedded = `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0) {
    // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (deprecated IPv4-compatible,
    // which also covers :: and ::1 → 0.0.0.0 / 0.0.0.1 → loopback). The
    // WHATWG URL parser canonicalises mapped literals to the HEX form —
    // http://[::ffff:169.254.169.254]/ parses to hostname ::ffff:a9fe:a9fe —
    // so classification must go through the expanded hextets; a dotted-form
    // string match never fires on URL-sourced hostnames.
    if (h5 === 0xffff || h5 === 0) return classifyIpv4(embedded);
  }
  // NAT64 well-known prefix (64:ff9b::/96) — a NAT64 gateway would route
  // this straight to the embedded IPv4.
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return classifyIpv4(embedded);
  }
  if (AWS_IMDS_V6.every((h, i) => h === hextets[i])) return 'metadata';
  if ((h0 & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  if ((h0 & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 (ULA)
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
