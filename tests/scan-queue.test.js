import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanQueue } from '../scan-queue.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const job = (value, extra = {}) => ({ value, dataUrl: `data:image/png;base64,${value}`, ...extra });

test('serializes rapid scans and retains repeated codes as separate one-copy jobs', async () => {
  const first = deferred(), second = deferred(), third = deferred();
  const gates = [first, second, third];
  const sent = [];
  let concurrent = 0, maxConcurrent = 0;
  const queue = new ScanQueue({ send: async captured => {
    const gate = gates[sent.length];
    sent.push(captured.value);
    maxConcurrent = Math.max(maxConcurrent, ++concurrent);
    const result = await gate.promise;
    concurrent--;
    return result;
  } });
  const ids = [queue.enqueue(job('00001234')), queue.enqueue(job('00001234')), queue.enqueue(job('0020'))];
  assert.deepEqual(ids, [1, 2, 3]);
  assert.deepEqual(sent, ['00001234']);
  assert.equal(queue.snapshot().pending.length, 2);
  first.resolve(true); await settle();
  assert.deepEqual(sent, ['00001234', '00001234']);
  second.resolve(true); await settle();
  assert.deepEqual(sent, ['00001234', '00001234', '0020']);
  third.resolve(true); await settle();
  assert.equal(maxConcurrent, 1);
  assert.equal(queue.snapshot().completedCount, 3);
  assert.equal(queue.snapshot().active, null);
});

test('false result pauses pending jobs; resume never retries the uncertain job', async () => {
  const failed = deferred();
  const sent = [];
  const queue = new ScanQueue({ send: async captured => {
    sent.push(captured.value);
    return sent.length === 1 ? failed.promise : true;
  } });
  queue.enqueue(job('first'));
  queue.enqueue(job('next'));
  failed.resolve(false); await settle();
  assert.deepEqual(sent, ['first']);
  assert.equal(queue.snapshot().paused, true);
  assert.equal(queue.snapshot().uncertain[0].job.value, 'first');
  assert.equal(queue.snapshot().pending[0].job.value, 'next');
  queue.resume(); await settle();
  assert.deepEqual(sent, ['first', 'next']);
  assert.equal(queue.snapshot().completedCount, 1);
  assert.equal(queue.snapshot().uncertain.length, 1);
  queue.resume(); await settle();
  assert.deepEqual(sent, ['first', 'next']);
});

test('disconnect during a write holds later scans until explicit resume after reconnect', async () => {
  const first = deferred();
  const sent = [];
  let connected = true;
  const queue = new ScanQueue({ canSend: () => connected, send: async captured => {
    sent.push(captured.value);
    return sent.length === 1 ? first.promise : true;
  } });
  queue.enqueue(job('001'));
  queue.enqueue(job('002'));
  connected = false;
  queue.pause('Connection lost.');
  first.reject(new Error('GATT disconnected')); await settle();
  assert.throws(() => queue.enqueue(job('003')), /Connect/);
  assert.throws(() => queue.resume(), /Reconnect/);
  connected = true;
  await settle();
  assert.deepEqual(sent, ['001']);
  queue.resume(); await settle();
  assert.deepEqual(sent, ['001', '002']);
  assert.equal(queue.snapshot().uncertain[0].error, 'GATT disconnected');
});

test('captures original barcode and layout independently of future settings edits', async () => {
  const sent = [];
  const queue = new ScanQueue({ send: async captured => { sent.push(captured); return true; } });
  queue.pause();
  const original = job('00001', { settings: { moduleDots: 2, marginLeftMm: 1 } });
  queue.enqueue(original);
  original.value = '99999'; original.dataUrl = 'changed'; original.settings.moduleDots = 6;
  assert.throws(() => { queue.snapshot().pending[0].job.settings.moduleDots = 3; }, TypeError);
  queue.resume(); await settle();
  assert.equal(sent[0].value, '00001');
  assert.equal(sent[0].dataUrl, 'data:image/png;base64,00001');
  assert.equal(sent[0].settings.moduleDots, 2);
});

test('clearing waiting labels never cancels or repeats an in-flight label', async () => {
  const first = deferred();
  const sent = [];
  const queue = new ScanQueue({ send: async captured => { sent.push(captured.value); return first.promise; } });
  queue.enqueue(job('active'));
  queue.enqueue(job('discarded'));
  assert.equal(queue.clearPending(), 1);
  assert.equal(queue.snapshot().active.job.value, 'active');
  first.resolve(true); await settle();
  assert.deepEqual(sent, ['active']);
  assert.equal(queue.snapshot().completedCount, 1);
});

test('pause/resume while a write is in flight cannot start a concurrent print', async () => {
  const first = deferred();
  const sent = [];
  const queue = new ScanQueue({ send: async captured => {
    sent.push(captured.value); return sent.length === 1 ? first.promise : true;
  } });
  queue.enqueue(job('active')); queue.enqueue(job('waiting'));
  queue.pause(); queue.resume();
  assert.deepEqual(sent, ['active']);
  first.resolve(true); await settle();
  assert.deepEqual(sent, ['active', 'waiting']);
});

test('bounded queue refuses extra scans without dropping accepted labels', async () => {
  const queue = new ScanQueue({ send: async () => true, maxPending: 2 });
  queue.pause();
  queue.enqueue(job('a')); queue.enqueue(job('b'));
  assert.throws(() => queue.enqueue(job('c')), /2 waiting/);
  assert.deepEqual(queue.snapshot().pending.map(item => item.job.value), ['a', 'b']);
  queue.resume(); await settle();
  assert.equal(queue.snapshot().completedCount, 2);
});

test('availability lost between successful jobs pauses without sending the next', async () => {
  let connected = true;
  const sent = [];
  const first = deferred();
  const queue = new ScanQueue({ canSend: () => connected, send: async captured => {
    sent.push(captured.value); return first.promise;
  } });
  queue.enqueue(job('first')); queue.enqueue(job('next'));
  connected = false; first.resolve(true); await settle();
  assert.equal(queue.snapshot().paused, true);
  assert.equal(queue.snapshot().completedCount, 1);
  assert.equal(queue.snapshot().pending.length, 1);
  assert.deepEqual(sent, ['first']);
});
