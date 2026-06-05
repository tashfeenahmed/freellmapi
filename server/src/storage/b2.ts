import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

type B2Config = {
  endpoint: string;
  region: string;
  bucket: string;
  keyId: string;
  applicationKey: string;
};

export type StorageStatus = {
  configured: boolean;
  backend: string;
  bucket?: string;
  objectKey?: string;
  message: string;
};

export function getDbObjectKey(): string {
  return process.env.B2_DB_OBJECT_KEY ?? process.env.LITESTREAM_DB_OBJECT_KEY ?? 'db/freellmapi.sqlite';
}

export function getBackupPrefix(): string {
  return process.env.B2_BACKUP_PREFIX ?? process.env.LITESTREAM_BACKUP_PREFIX ?? 'db/backups/';
}

function inferRegion(endpoint: string): string {
  const match = endpoint.match(/s3\.([a-z0-9-]+)\.backblazeb2\.com/i);
  return process.env.B2_REGION ?? process.env.LITESTREAM_REGION ?? match?.[1] ?? 'us-west-004';
}

function getConfig(): B2Config | null {
  const endpoint = (process.env.B2_ENDPOINT ?? process.env.LITESTREAM_ENDPOINT)?.replace(/\/+$/, '');
  const bucket = process.env.B2_BUCKET ?? process.env.LITESTREAM_BUCKET;
  const keyId = process.env.B2_KEY_ID ?? process.env.LITESTREAM_ACCESS_KEY_ID;
  const applicationKey = process.env.B2_APPLICATION_KEY ?? process.env.LITESTREAM_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !keyId || !applicationKey) return null;
  return { endpoint, region: inferRegion(endpoint), bucket, keyId, applicationKey };
}

function hmac(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encodeKey(key: string): string {
  return key.split('/').map(part => encodeURIComponent(part)).join('/');
}

function signRequest(config: B2Config, method: string, objectKey: string, body: Buffer | string = ''): { url: string; headers: Record<string, string> } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(Buffer.isBuffer(body) ? body : Buffer.from(body));
  const host = new URL(config.endpoint).host;
  const canonicalUri = `/${encodeURIComponent(config.bucket)}/${encodeKey(objectKey)}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${config.applicationKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    url: `${config.endpoint}${canonicalUri}`,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.keyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  };
}

export function getB2StorageStatus(): StorageStatus {
  const objectKey = getDbObjectKey();
  const config = getConfig();
  if (!config) {
    return { configured: false, backend: 'local', objectKey, message: 'Backblaze/Litestream-compatible storage is not fully configured.' };
  }
  return { configured: true, backend: 'backblaze_b2_litestream_env', bucket: config.bucket, objectKey, message: 'Backblaze B2 snapshot storage is configured from existing LITESTREAM_* envs.' };
}

export async function downloadDbSnapshot(targetPath: string, objectKey = getDbObjectKey()): Promise<boolean> {
  const config = getConfig();
  if (!config) return false;
  const signed = signRequest(config, 'GET', objectKey);
  const response = await fetch(signed.url, { method: 'GET', headers: signed.headers });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`B2 restore failed with HTTP ${response.status}`);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(targetPath, bytes);
  return true;
}

export async function uploadDbSnapshot(sourcePath: string, objectKey = getDbObjectKey()): Promise<void> {
  const config = getConfig();
  if (!config) return;
  const body = await fs.readFile(sourcePath);
  const signed = signRequest(config, 'PUT', objectKey, body);
  const response = await fetch(signed.url, {
    method: 'PUT',
    headers: { ...signed.headers, 'content-type': 'application/octet-stream', 'content-length': String(body.length) },
    body,
  });
  if (!response.ok) throw new Error(`B2 snapshot upload failed with HTTP ${response.status}`);
}

export async function uploadTimestampedBackup(sourcePath: string): Promise<string | null> {
  const config = getConfig();
  if (!config) return null;
  const prefix = getBackupPrefix();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const objectKey = `${prefix.replace(/\/+$/, '')}/freellmapi-${stamp}.sqlite`;
  await uploadDbSnapshot(sourcePath, objectKey);
  return objectKey;
}
