#!/usr/bin/env node
// Decides whether a Microsoft Store submission may go out now (#2103).
//
// `msstore publish` DELETES the pending submission before it creates a new one.
// Store certification takes one to three days and we tag a release most days,
// so every new tag cancelled the submission still in certification: the Store
// stayed on 0.16.38 while GitHub reached 0.16.45. This gate asks Partner Center
// first and holds the upload while a submission is on its way to the Store.
// The scheduled `msstore-catchup` workflow sends the newest release once the
// Store is free again, so a held version is not lost.
//
// Usage: node msstore-gate.mjs [candidate-version]
// Env: MSSTORE_TENANT_ID, MSSTORE_CLIENT_ID, MSSTORE_CLIENT_SECRET,
//      MSSTORE_APP_ID (default 9PBN6G8K2B7F), GITHUB_OUTPUT (optional).
// Writes to GITHUB_OUTPUT: publish=true|false, pending_status, live_version, reason.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Submission states that mean "this one is still on its way to the Store".
// Replacing it cancels it. Every other state is safe to replace: PendingCommit
// is an uncommitted draft, the *Failed states will never ship, and a pending
// submission that is Published/Canceled is over.
export const IN_FLIGHT = new Set([
  'CommitStarted',
  'PreProcessing',
  'Certification',
  'Release',
  'PendingPublication',
  'Publishing',
]);

/** "0.16.45" or "0.16.45.0" → [0,16,45]; null when it does not parse. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(String(text ?? '').trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * pendingStatus / pendingVersion: the pending submission, or null when there is none.
 * liveVersion / candidate: version strings, or null when unknown / not given.
 */
export function decide({ pendingStatus, pendingVersion, liveVersion, candidate }) {
  if (pendingStatus && IN_FLIGHT.has(pendingStatus)) {
    return { publish: false, reason: `a submission${pendingVersion ? ` of ${pendingVersion}` : ""} is in ${pendingStatus}; replacing it would cancel it` };
  }
  const live = parseVersion(liveVersion);
  const next = parseVersion(candidate);
  if (candidate && !next) return { publish: false, reason: `candidate version "${candidate}" does not parse` };
  // MSSTORE_SUBMIT=draft leaves an uncommitted draft for a person to submit;
  // re-uploading the same version over it on every scheduled run helps no one.
  const pending = parseVersion(pendingVersion);
  if (pendingStatus === 'PendingCommit' && pending && next && compareVersions(next, pending) <= 0) {
    return { publish: false, reason: `a draft with ${pendingVersion} is waiting in Partner Center` };
  }
  if (live && next && compareVersions(next, live) <= 0) {
    return { publish: false, reason: `the Store already has ${liveVersion}, not older than ${candidate}` };
  }
  return { publish: true, reason: pendingStatus ? `the pending submission is ${pendingStatus}, safe to replace` : 'no submission in progress' };
}

const API = 'https://manage.devcenter.microsoft.com/v1.0/my';

async function token(env) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.MSSTORE_CLIENT_ID,
    client_secret: env.MSSTORE_CLIENT_SECRET,
    resource: 'https://manage.devcenter.microsoft.com',
  });
  const res = await fetch(`https://login.microsoftonline.com/${env.MSSTORE_TENANT_ID}/oauth2/token`, { method: 'POST', body });
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function get(path, auth) {
  const res = await fetch(`${API}/${path}`, { headers: { Authorization: `Bearer ${auth}` } });
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
  return res.json();
}

/** Highest package version in a submission. */
function submissionVersion(submission) {
  const versions = (submission.applicationPackages ?? [])
    .filter((p) => p.fileStatus !== 'PendingDelete')
    .map((p) => parseVersion(p.version))
    .filter(Boolean)
    .sort(compareVersions);
  return versions.length ? versions.at(-1).join('.') : null;
}

export async function readStore(env = process.env) {
  const appId = env.MSSTORE_APP_ID || '9PBN6G8K2B7F';
  const auth = await token(env);
  const app = await get(`applications/${appId}`, auth);
  let pendingStatus = null;
  let pendingVersion = null;
  if (app.pendingApplicationSubmission?.id) {
    const id = app.pendingApplicationSubmission.id;
    pendingStatus = (await get(`applications/${appId}/submissions/${id}/status`, auth)).status ?? null;
    pendingVersion = submissionVersion(await get(`applications/${appId}/submissions/${id}`, auth));
  }
  let liveVersion = null;
  if (app.lastPublishedApplicationSubmission?.id) {
    liveVersion = submissionVersion(await get(`applications/${appId}/submissions/${app.lastPublishedApplicationSubmission.id}`, auth));
  }
  return { pendingStatus, pendingVersion, liveVersion };
}

async function main() {
  for (const name of ['MSSTORE_TENANT_ID', 'MSSTORE_CLIENT_ID', 'MSSTORE_CLIENT_SECRET']) {
    if (!process.env[name]) throw new Error(`${name} is not set`);
  }
  const candidate = process.argv[2] || null;
  const store = await readStore();
  const verdict = decide({ ...store, candidate });
  console.log(`Store: live ${store.liveVersion ?? 'unknown'}; pending ${store.pendingVersion ?? '-'} (${store.pendingStatus ?? 'none'}); candidate ${candidate ?? '-'}`);
  console.log(`${verdict.publish ? 'Publish' : 'Hold'}: ${verdict.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, [
      `publish=${verdict.publish}`,
      `pending_status=${store.pendingStatus ?? ''}`,
      `pending_version=${store.pendingVersion ?? ''}`,
      `live_version=${store.liveVersion ?? ''}`,
      `reason=${verdict.reason}`,
    ].join('\n') + '\n');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::msstore gate: ${err.message}`);
    process.exit(1);
  });
}
