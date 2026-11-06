import test from 'node:test';
import assert from 'node:assert/strict';
import { DuplicateHistory } from '../duplicate-history.js';
import { ScanQueue } from '../scan-queue.js';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function trackedQueue(history, send) {
  return new ScanQueue({
    send: async job => {
      const success = await send(job);
      if (success === true) history.recordSuccess(job.value);
      return success;
    },
  });
}

test('rapid duplicate scans are found during printing and while queued before promises settle', async () => {
  const history = new DuplicateHistory();
  const first = deferred();
  const queue = trackedQueue(history, () => first.promise);
  assert.equal(history.find('00001234', queue.snapshot()), null);
  queue.enqueue({ value: '00001234' });
  queue.enqueue({ value: 'another' });
  assert.deepEqual(history.find('00001234', queue.snapshot()), { reason: 'printing' });
  assert.deepEqual(history.find('another', queue.snapshot()), { reason: 'queued' });
  assert.equal(history.size, 0);
  assert.equal(queue.snapshot().pending.length, 1);
  first.resolve(true);
  await settle();
  assert.equal(queue.snapshot().completedCount, 2);
  assert.deepEqual(history.find('00001234', queue.snapshot()), { reason: 'printed' });
  assert.deepEqual(history.find('another', queue.snapshot()), { reason: 'printed' });
});

test('all confirmed successful values remain detectable after later jobs finish', async () => {
  const history = new DuplicateHistory();
  const queue = trackedQueue(history, async () => true);
  queue.enqueue({ value: 'first' });
  queue.enqueue({ value: 'second' });
  await settle();
  assert.equal(queue.snapshot().lastCompleted.job.value, 'second');
  assert.deepEqual(history.find('first', queue.snapshot()), { reason: 'printed' });
  assert.deepEqual(history.find('second', queue.snapshot()), { reason: 'printed' });
  assert.equal(history.find('new', queue.snapshot()), null);
});

test('an uncertain print remains a warning without becoming a successful history entry', async () => {
  const history = new DuplicateHistory();
  const queue = trackedQueue(history, async () => false);
  queue.enqueue({ value: 'maybe-printed' });
  await settle();
  assert.equal(history.size, 0);
  assert.deepEqual(history.find('maybe-printed', queue.snapshot()), { reason: 'uncertain' });
  const snapshot = queue.snapshot();
  history.clear();
  assert.deepEqual(history.find('maybe-printed', snapshot), { reason: 'uncertain' });
  assert.equal(snapshot.uncertain.length, 1);
  assert.equal(queue.snapshot().paused, true);
});

test('clearing pending jobs releases unprinted values without altering an active job', async () => {
  const history = new DuplicateHistory();
  const first = deferred();
  const queue = trackedQueue(history, () => first.promise);
  queue.enqueue({ value: 'active' });
  queue.enqueue({ value: 'cancelled' });
  const oldSnapshot = queue.snapshot();
  assert.deepEqual(history.find('cancelled', oldSnapshot), { reason: 'queued' });
  queue.clearPending();
  assert.equal(history.find('cancelled', queue.snapshot()), null);
  assert.deepEqual(history.find('active', queue.snapshot()), { reason: 'printing' });
  assert.equal(oldSnapshot.pending.length, 1, 'Finding duplicates does not mutate snapshots.');
  first.resolve(true);
  await settle();
  assert.equal(history.find('cancelled', queue.snapshot()), null);
});

test('matching is exact for leading zeros, case and whitespace in history and queue', () => {
  const values = ['00123', 'AbC', ' 123 ', '123 ', ' 123'];
  const history = new DuplicateHistory(values);
  for (const value of values) assert.deepEqual(history.find(value), { reason: 'printed' });
  for (const value of ['123', 'abc', 'ABC', 'AbC ']) assert.equal(history.find(value), null);
  const snapshot = { pending: [{ job: { value: '0004' } }] };
  assert.deepEqual(history.find('0004', snapshot), { reason: 'queued' });
  assert.equal(history.find('4', snapshot), null);
  assert.throws(() => history.find(123), TypeError);
  assert.throws(() => history.recordSuccess(123), TypeError);
});

test('live queue states take precedence over old successful history', () => {
  const history = new DuplicateHistory(['same']);
  const item = Object.freeze({ job: Object.freeze({ value: 'same' }) });
  const snapshot = Object.freeze({ active: item,
    pending: Object.freeze([item]), uncertain: Object.freeze([item]) });
  assert.deepEqual(history.find('same', snapshot), { reason: 'printing' });
  assert.deepEqual(history.find('same', { ...snapshot, active: null }), { reason: 'queued' });
  assert.deepEqual(history.find('same', { ...snapshot, active: null, pending: [] }), { reason: 'uncertain' });
  assert.deepEqual(history.find('same', { active: null, pending: [], uncertain: [] }), { reason: 'printed' });
});

test('optional history import/export preserves strings without sharing mutable storage', () => {
  const imported = ['0001', 'abc', '0001'];
  const history = new DuplicateHistory(imported);
  imported.push('not-recorded');
  assert.equal(history.size, 2);
  assert.equal(history.recordSuccess('0001'), false);
  assert.equal(history.recordSuccess('0002'), true);
  const exported = history.toJSON();
  exported.push('also-not-recorded');
  assert.equal(history.find('not-recorded'), null);
  assert.equal(history.find('also-not-recorded'), null);
  const restored = new DuplicateHistory(JSON.parse(JSON.stringify(history)));
  assert.deepEqual(restored.toJSON(), ['0001', 'abc', '0002']);
  assert.equal(restored.clear(), 3);
  assert.equal(restored.size, 0);
  assert.equal(restored.find('0001'), null);
  assert.equal(history.size, 3);
  assert.throws(() => new DuplicateHistory('0001'), TypeError);
  assert.throws(() => new DuplicateHistory(['0001', 1]), TypeError);
});
