const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map(part => Number(part));
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;

  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isPrivateIpv6(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === '::1'
    || host.startsWith('fc')
    || host.startsWith('fd')
    || host.startsWith('fe80:');
}

function isLocalCustomProviderHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return LOCAL_HOSTNAMES.has(host);
}

function allowsRemoteCustomProviders(): boolean {
  return process.env.ALLOW_REMOTE_CUSTOM_PROVIDERS === 'true';
}

export function normalizeCustomProviderBaseUrl(rawBaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl.trim());
  } catch {
    throw new Error('baseUrl must be a valid URL');
  }

  const protocol = parsed.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('Custom provider baseUrl must use http or https');
  }

  const hostname = normalizeHostname(parsed.hostname);
  const isLocal = isLocalCustomProviderHost(hostname);

  if (isLocal) {
    return parsed.toString().replace(/\/+$/, '');
  }

  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    throw new Error('Custom provider baseUrl cannot target private, loopback, link-local, or unspecified IP addresses');
  }

  if (!allowsRemoteCustomProviders()) {
    throw new Error('Remote custom provider URLs are disabled by default. Set ALLOW_REMOTE_CUSTOM_PROVIDERS=true to allow remote HTTPS endpoints.');
  }

  if (protocol !== 'https:') {
    throw new Error('Remote custom provider baseUrl must use https');
  }

  return parsed.toString().replace(/\/+$/, '');
}
