import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, parseVersion, IN_FLIGHT } from './msstore-gate.mjs';

test('holds while a submission is on its way to the Store', () => {
  for (const status of IN_FLIGHT) {
    const verdict = decide({ pendingStatus: status, liveVersion: '0.16.38.0', candidate: '0.16.46' });
    assert.equal(verdict.publish, false, status);
    assert.match(verdict.reason, /cancel/);
  }
});

test('replaces drafts and failed submissions', () => {
  for (const status of ['PendingCommit', 'CommitFailed', 'PreProcessingFailed', 'CertificationFailed', 'ReleaseFailed', 'PublishFailed', 'Canceled']) {
    assert.equal(decide({ pendingStatus: status, liveVersion: '0.16.38.0', candidate: '0.16.46' }).publish, true, status);
  }
});

test('publishes when nothing is pending and the candidate is newer', () => {
  assert.equal(decide({ pendingStatus: null, liveVersion: '0.16.38.0', candidate: '0.16.45' }).publish, true);
  assert.equal(decide({ pendingStatus: null, liveVersion: null, candidate: '0.16.45' }).publish, true);
});

test('does not resend a version the Store already has', () => {
  assert.equal(decide({ pendingStatus: null, liveVersion: '0.16.45.0', candidate: 'v0.16.45' }).publish, false);
  assert.equal(decide({ pendingStatus: null, liveVersion: '0.16.46.0', candidate: '0.16.45' }).publish, false);
});

test('refuses a candidate that does not parse', () => {
  assert.equal(decide({ pendingStatus: null, liveVersion: '0.16.38.0', candidate: 'main' }).publish, false);
});

test('parses tags and four-part Store versions', () => {
  assert.deepEqual(parseVersion('v0.16.45'), [0, 16, 45]);
  assert.deepEqual(parseVersion('0.16.38.0'), [0, 16, 38]);
  assert.equal(parseVersion('0.16'), null);
});

test('leaves a waiting draft of the same version alone', () => {
  assert.equal(decide({ pendingStatus: 'PendingCommit', pendingVersion: '0.16.45.0', liveVersion: '0.16.38.0', candidate: '0.16.45' }).publish, false);
  assert.equal(decide({ pendingStatus: 'PendingCommit', pendingVersion: '0.16.45.0', liveVersion: '0.16.38.0', candidate: '0.16.46' }).publish, true);
});
