import { describe, it, expect, afterEach } from 'vitest';
import { classifyIp, assessProviderUrl } from '../../lib/url-guard.js';

// SSRF guard for user-supplied custom-provider base URLs (#440). Metadata and
// link-local targets must never be reachable; loopback/private stay allowed by
// default (local Ollama / LM Studio is the app's primary documented use case)
// and flip to blocked under FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS.

afterEach(() => {
  delete process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS;
});

describe('classifyIp', () => {
  it('classifies cloud metadata addresses', () => {
    expect(classifyIp('169.254.169.254')).toBe('metadata');
    expect(classifyIp('100.100.100.200')).toBe('metadata'); // Alibaba IMDS
    expect(classifyIp('fd00:ec2::254')).toBe('metadata'); // AWS IMDS IPv6
  });

  it('classifies link-local ranges', () => {
    expect(classifyIp('169.254.0.1')).toBe('link-local');
    expect(classifyIp('fe80::1')).toBe('link-local');
  });

  it('classifies loopback', () => {
    expect(classifyIp('127.0.0.1')).toBe('loopback');
    expect(classifyIp('127.8.8.8')).toBe('loopback');
    expect(classifyIp('::1')).toBe('loopback');
    expect(classifyIp('0.0.0.0')).toBe('loopback');
  });

  it('classifies private ranges', () => {
    expect(classifyIp('10.13.13.1')).toBe('private');
    expect(classifyIp('172.16.0.1')).toBe('private');
    expect(classifyIp('172.31.255.255')).toBe('private');
    expect(classifyIp('192.168.1.20')).toBe('private');
    expect(classifyIp('100.64.0.1')).toBe('private'); // CGNAT
    expect(classifyIp('fc00::1')).toBe('private'); // ULA
    expect(classifyIp('fd12:3456::1')).toBe('private');
  });

  it('classifies public addresses and IPv4-mapped IPv6', () => {
    expect(classifyIp('8.8.8.8')).toBe('public');
    expect(classifyIp('172.32.0.1')).toBe('public'); // just past 172.16/12
    expect(classifyIp('2606:4700::1111')).toBe('public');
    expect(classifyIp('::ffff:169.254.169.254')).toBe('metadata'); // mapped
    expect(classifyIp('::ffff:8.8.8.8')).toBe('public');
  });

  it('classifies IPv4-mapped IPv6 in hex form (what the WHATWG URL parser emits)', () => {
    // new URL('http://[::ffff:169.254.169.254]/').hostname === '[::ffff:a9fe:a9fe]'
    // — the dotted form never reaches classifyIp from a URL, only this one.
    expect(classifyIp('::ffff:a9fe:a9fe')).toBe('metadata'); // 169.254.169.254
    expect(classifyIp('::ffff:7f00:1')).toBe('loopback'); // 127.0.0.1
    expect(classifyIp('::ffff:a00:1')).toBe('private'); // 10.0.0.1
    expect(classifyIp('::ffff:808:808')).toBe('public'); // 8.8.8.8
    expect(classifyIp('0:0:0:0:0:ffff:a9fe:a9fe')).toBe('metadata'); // uncompressed
  });

  it('classifies NAT64, IPv4-compatible, and alternate-spelling metadata addresses', () => {
    expect(classifyIp('64:ff9b::a9fe:a9fe')).toBe('metadata'); // NAT64 → 169.254.169.254
    expect(classifyIp('64:ff9b::808:808')).toBe('public'); // NAT64 → 8.8.8.8
    expect(classifyIp('::a9fe:a9fe')).toBe('metadata'); // deprecated v4-compatible form
    expect(classifyIp('192.0.0.192')).toBe('metadata'); // Oracle Cloud legacy IMDS
    expect(classifyIp('fd00:0ec2:0:0:0:0:0:0254')).toBe('metadata'); // AWS IMDS, uncompressed
  });
});

describe('assessProviderUrl', () => {
  it('always blocks cloud metadata targets', async () => {
    const aws = await assessProviderUrl('http://169.254.169.254/latest/meta-data/');
    expect(aws.allowed).toBe(false);
    expect(aws.reason).toMatch(/metadata/);

    const gcp = await assessProviderUrl('http://metadata.google.internal/computeMetadata/v1/');
    expect(gcp.allowed).toBe(false);
    expect(gcp.reason).toMatch(/metadata/);
  });

  it('blocks decimal-encoded metadata IPs (URL canonicalisation)', async () => {
    // 2852039166 === 169.254.169.254 — WHATWG URL normalises integer hosts.
    const verdict = await assessProviderUrl('http://2852039166/latest/meta-data/');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/metadata/);
  });

  it('blocks bracketed IPv4-mapped metadata literals end to end', async () => {
    // The parser rewrites this hostname to the hex form ::ffff:a9fe:a9fe.
    const verdict = await assessProviderUrl('http://[::ffff:169.254.169.254]/latest/meta-data/');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/metadata/);
  });

  it('blocks hostnames that resolve to metadata or link-local addresses', async () => {
    const verdict = await assessProviderUrl('http://innocent.example.com/v1', {
      resolve: async () => ['169.254.169.254'],
    });
    expect(verdict.allowed).toBe(false);

    const linkLocal = await assessProviderUrl('http://innocent.example.com/v1', {
      resolve: async () => ['1.2.3.4', 'fe80::1'],
    });
    expect(linkLocal.allowed).toBe(false);
  });

  it('allows loopback and private LAN targets by default (local Ollama)', async () => {
    expect((await assessProviderUrl('http://localhost:11434/v1', { resolve: async () => ['127.0.0.1'] })).allowed).toBe(true);
    expect((await assessProviderUrl('http://127.0.0.1:8080/v1')).allowed).toBe(true);
    expect((await assessProviderUrl('http://192.168.1.20:11434/v1')).allowed).toBe(true);
  });

  it('blocks loopback and private targets under FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS', async () => {
    process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS = 'true';
    expect((await assessProviderUrl('http://127.0.0.1:8080/v1')).allowed).toBe(false);
    expect((await assessProviderUrl('http://192.168.1.20:11434/v1')).allowed).toBe(false);
    expect((await assessProviderUrl('http://10.0.0.5:3000/v1')).allowed).toBe(false);
    // Metadata stays blocked, public stays allowed.
    expect((await assessProviderUrl('http://169.254.169.254/')).allowed).toBe(false);
    const pub = await assessProviderUrl('https://api.example.com/v1', { resolve: async () => ['93.184.216.34'] });
    expect(pub.allowed).toBe(true);
  });

  it('allows public URLs', async () => {
    const verdict = await assessProviderUrl('https://api.example.com/v1', {
      resolve: async () => ['93.184.216.34'],
    });
    expect(verdict.allowed).toBe(true);
  });

  it('rejects non-http(s) protocols and malformed URLs', async () => {
    expect((await assessProviderUrl('ftp://example.com/v1')).allowed).toBe(false);
    expect((await assessProviderUrl('file:///etc/passwd')).allowed).toBe(false);
    expect((await assessProviderUrl('not a url')).allowed).toBe(false);
  });

  it('lets unresolvable hostnames through (checked again at request time)', async () => {
    const verdict = await assessProviderUrl('http://my-offline-box.lan:11434/v1', {
      resolve: async () => { throw new Error('ENOTFOUND'); },
    });
    expect(verdict.allowed).toBe(true);
  });
});
