import { setGlobalDispatcher, EnvHttpProxyAgent, Agent } from 'undici';
import { SocksClient } from 'socks';
import tls from 'node:tls';

let initialized = false;

export function initProxy(): void {
  if (initialized) return;
  initialized = true;

  const allProxy = process.env.ALL_PROXY || process.env.all_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;

  const proxyUrl = allProxy || httpsProxy || httpProxy;
  if (!proxyUrl) return;

  const parsed = new URL(proxyUrl);
  const scheme = parsed.protocol.replace(':', '').toLowerCase();

  if (scheme === 'http' || scheme === 'https') {
    setGlobalDispatcher(new EnvHttpProxyAgent({
      httpProxy: allProxy || httpProxy,
      httpsProxy: allProxy || httpsProxy,
    }));
    console.log(`[proxy] Using HTTP proxy: ${proxyUrl}`);
  } else if (scheme.startsWith('socks')) {
    const socksType = scheme === 'socks4' ? 4 : 5;
    setGlobalDispatcher(new Agent({
      connect: (opts, callback) => {
        const isHttps = opts.protocol === 'https:';
        const defaultPort = isHttps ? 443 : 80;
        SocksClient.createConnection({
          proxy: {
            host: parsed.hostname,
            port: Number(parsed.port),
            type: socksType,
          },
          command: 'connect',
          destination: {
            host: opts.hostname,
            port: Number(opts.port) || defaultPort,
          },
        })
          .then(({ socket }) => {
            if (isHttps) {
              const tlsSocket = tls.connect({
                socket,
                host: opts.hostname,
                servername: opts.servername || opts.hostname,
              });
              tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
              tlsSocket.once('error', (err) => callback(err, null));
            } else {
              callback(null, socket);
            }
          })
          .catch((err) => callback(err, null));
      },
    }));
    console.log(`[proxy] Using SOCKS proxy: ${proxyUrl}`);
  }
}
