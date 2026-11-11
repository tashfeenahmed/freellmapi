// Whether a request reached us from this machine.
//
// The socket peer address is the only value a caller cannot set, so that is what
// decides locality. A forwarded hop can never grant it, but it can withdraw it: the
// deployment this project documents puts a reverse proxy on the same host, which
// makes every request look local at the socket.
//
// X-Forwarded-For is a list that each proxy APPENDS to, so the RIGHT-most hop is the
// one the nearest proxy saw, while everything to its left arrived in the request and
// is caller-controlled. Reading the left-most hop (as this code used to) let a remote
// client send `X-Forwarded-For: 127.0.0.1` through an appending proxy and be treated
// as local.

export const isLoopbackAddress = (value: string | undefined): boolean => {
  let address = (value ?? '').trim();
  // Node reports IPv4 loopback over a dual-stack socket as "::ffff:127.0.0.1".
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (address === '::1') return true;
  // Only a real 127.0.0.0/8 address: four decimal octets, each 0-255.
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  return octets !== null && octets.slice(1).every(octet => Number(octet) <= 255);
};

// The hop appended by the nearest proxy, or '' when the header carries no hop.
export const forwardedPeerAddress = (
  header: string | string[] | undefined,
): string => {
  const hops = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  return hops.length > 0 ? hops[hops.length - 1] : '';
};

export const isLoopbackRequest = (req: {
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}): boolean => {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const forwarded = forwardedPeerAddress(req.headers['x-forwarded-for']);
  // No hop at all: the socket was the client. With a hop, only the proxy's own
  // observation counts, and anything that is not loopback (including a value this
  // module cannot parse, such as an address carrying a port) is refused.
  return forwarded === '' || isLoopbackAddress(forwarded);
};
