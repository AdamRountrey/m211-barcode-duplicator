import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_SETTINGS } from '../barcode.js';
import { DuplicateHistory } from '../duplicate-history.js';
import { ScanQueue } from '../scan-queue.js';

const HISTORY_KEY = 'barcode-copy-history-v1';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const renderer = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

// Run the actual renderer, including its startup and registered event handlers.
// Only the final vendor SDK import is excluded: no browser, Bluetooth or printer
// exists here. Barcode rasterization is covered separately by barcode.test.js.
function createApp({ saved = new Map(), storageFails = false, print = async () => true } = {}) {
  const storage = new Map(saved);
  const documentListeners = new Map();
  const elements = new Map();
  const printed = [];
  const register = (map, name, callback) => map.set(name, [...(map.get(name) || []), callback]);
  let document;
  function element(tagName, id = '') {
    const listeners = new Map();
    return {
      id, tagName: tagName.toUpperCase(), value: '', checked: false, disabled: false,
      hidden: false, open: false, textContent: '', classList: { toggle() {} },
      addEventListener(name, callback) { register(listeners, name, callback); },
      dispatch(name, event = {}) { for (const callback of listeners.get(name) || []) callback(event); },
      setAttribute() {}, replaceChildren() {}, append() {}, select() {},
      focus() { document.activeElement = this; },
      showModal() { this.open = true; },
      close() { if (this.open) { this.open = false; this.dispatch('close'); } },
      getContext() { return { getImageData() { return {}; }, drawImage() {} }; },
      toDataURL() { return `captured:${JSON.stringify(this.rendered)}`; },
    };
  }
  for (const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[2], element(match[1], match[2]));
  }
  document = {
    activeElement: null,
    getElementById: id => elements.get(id),
    createElement: tag => element(tag),
    querySelector: () => [...elements.values()].find(item => item.tagName === 'DIALOG' && item.open),
    addEventListener(name, callback) { register(documentListeners, name, callback); },
  };
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (elements.has(key)) elements.get(key).value = String(value);
  }
  elements.get('tape-width').value = '12.7';
  elements.get('auto-print').checked = true;
  elements.get('save-tape').checked = true;
  const localStorage = {
    getItem(key) { if (storageFails) throw new Error('Storage unavailable'); return storage.get(key) ?? null; },
    setItem(key, value) { if (storageFails) throw new Error('Storage unavailable'); storage.set(key, value); },
    removeItem(key) { if (storageFails) throw new Error('Storage unavailable'); storage.delete(key); },
  };
  const printer = {
    online: true, printerModel: 'M211', printOptions: {},
    isConnected() { return this.online; }, setCopies() {}, setCutOption() {},
    async printBitmap(image) { printed.push(image.src); return print(image); },
  };
  const context = vm.createContext({
    console, structuredClone, DEFAULT_SETTINGS, DuplicateHistory, ScanQueue,
    document, localStorage, testPrinter: printer,
    window: { desktop: { log() {}, onDevices() {}, onDiscoveryState() {}, onPairing() {} }, addEventListener() {} },
    Image: class { constructor() { this.width = 100; this.height = 93; } async decode() {} },
    printableWidthMm: () => 11.684,
    inspectMedia: () => ({ warnings: [], layoutSupported: true, dimensionsMatch: true }),
    m211LeadingTrim: () => 0,
    drawBarcode(canvas, value, settings) {
      canvas.width = 100; canvas.height = 93;
      canvas.rendered = { value, settings: { ...settings } };
      return { value, settings, widthDots: 100, heightDots: 93, lengthMm: 12.5 };
    },
  });
  const importBoundary = renderer.search(/\ntry\s*\{\s*const\s+\{\s*default:\s*BradySdk\s*\}\s*=\s*await import/);
  assert.ok(importBoundary > 0, 'Locate the vendor initialization boundary before running renderer code.');
  const appSource = renderer.slice(0, importBoundary).replace(/^import .*;\r?\n/gm, '');
  const run = source => vm.runInContext(source, context, { timeout: 1000 });
  run(appSource);
  run('sdk = testPrinter; controls();');
  function key(keyValue, options = {}) {
    const event = {
      key: keyValue, type: 'keydown', ctrlKey: false, altKey: false, metaKey: false,
      repeat: false, isComposing: false, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...options,
    };
    for (const callback of documentListeners.get(event.type) || []) {
      callback(event);
      if (event.stopped) break;
    }
    if (!event.stopped) document.activeElement?.dispatch(event.type, event);
    return event;
  }
  return {
    run, printer, storage, printed, key,
    element: id => elements.get(id),
    snapshot: () => run('queue.snapshot()'),
    find: value => run(`duplicateHistory.find(${JSON.stringify(value)}, queue.snapshot())`),
    click(id, detail = 1) {
      const target = elements.get(id);
      if (!target.disabled) target.dispatch('click', { detail });
    },
    scan(value) {
      const input = elements.get('scan');
      assert.equal(input.disabled, false, 'Scanner must be enabled before supplying another value.');
      input.value = value; input.focus(); input.dispatch('input'); key('Enter');
    },
    setStorageFailure(value) { storageFails = value; },
  };
}

test('confirmed print history survives renderer restart with exact barcode identity', async () => {
  const app = createApp({ saved: new Map([[HISTORY_KEY, '["0001"," AbC "]']]) });
  assert.deepEqual(app.find('0001'), { reason: 'printed' });
  assert.equal(app.find('1'), null);
  assert.equal(app.find('abc'), null);
  app.scan('00002');
  await settle();
  assert.equal(app.printed.length, 1);
  assert.deepEqual(JSON.parse(app.storage.get(HISTORY_KEY)), ['0001', ' AbC ', '00002']);
  const restarted = createApp({ saved: app.storage });
  restarted.scan('00002');
  assert.equal(restarted.element('duplicate-dialog').open, true);
  assert.equal(restarted.printed.length, 0);
});

test('preview-only scans stay unblocked, but Print preview warns and Cancel prints nothing', () => {
  const app = createApp({ saved: new Map([[HISTORY_KEY, '["0001"]']]) });
  app.element('auto-print').checked = false;
  app.scan('0001');
  assert.equal(app.element('duplicate-dialog').open, false);
  app.click('print');
  assert.equal(app.element('duplicate-dialog').open, true);
  assert.equal(app.element('duplicate-value').textContent, '0001');
  app.click('duplicate-cancel');
  assert.equal(app.element('duplicate-dialog').open, false);
  assert.equal(app.snapshot().pending.length, 0);
  assert.equal(app.printed.length, 0);
});

test('duplicate confirmation queues the captured settings once even after settings change', () => {
  const app = createApp({ saved: new Map([[HISTORY_KEY, '["0001"]']]) });
  app.run('queue.pause();');
  app.scan('0001');
  const originalWidth = Number(app.element('moduleDots').value);
  app.element('moduleDots').value = String(originalWidth + 1);
  app.element('moduleDots').dispatch('input');
  assert.equal(app.run('Object.isFrozen(pendingDuplicate.settings)'), true);
  app.click('duplicate-confirm');
  app.run('confirmDuplicate();');
  assert.equal(app.snapshot().pending.length, 1);
  assert.equal(app.snapshot().pending[0].job.settings.moduleDots, originalWidth);
  assert.equal(app.snapshot().pending[0].job.value, '0001');
  assert.equal(app.element('duplicate-dialog').open, false);
});

test('scanner Enter and Space cannot confirm, focus stays in the dialog and Escape cancels', () => {
  const app = createApp({ saved: new Map([[HISTORY_KEY, '["0001"]']]) });
  app.run('queue.pause();');
  app.scan('0001');
  assert.equal(app.element('scan').disabled, true);
  app.run('focusScanner();');
  assert.equal(app.run('document.activeElement.id'), 'duplicate-cancel');
  for (const type of ['keydown', 'keyup']) for (const key of ['Enter', ' ']) {
    assert.equal(app.key(key, { type }).defaultPrevented, true);
  }
  app.click('duplicate-confirm', 0); // Keyboard-generated button click.
  assert.equal(app.snapshot().pending.length, 0);
  assert.equal(app.element('duplicate-dialog').open, true);
  app.key('Escape');
  assert.equal(app.element('duplicate-dialog').open, false);
  assert.equal(app.element('scan').disabled, false);
  app.scan('0001');
  app.key('Enter', { ctrlKey: true });
  assert.equal(app.snapshot().pending.length, 1);
});

test('a disconnected confirmation enqueues nothing and repeated confirmation cannot double-print', () => {
  const app = createApp({ saved: new Map([[HISTORY_KEY, '["0001"]']]) });
  app.run('queue.pause();');
  app.scan('0001');
  app.printer.online = false;
  app.run('confirmDuplicate();');
  assert.equal(app.snapshot().pending.length, 0);
  assert.equal(app.element('duplicate-error').hidden, false);
  app.printer.online = true;
  app.run('confirmDuplicate(); confirmDuplicate();');
  assert.equal(app.snapshot().pending.length, 1);
  assert.equal(app.printed.length, 0);
});

test('clearing persisted history retains active, waiting and uncertain duplicate protection', async () => {
  const active = deferred();
  let attempts = 0;
  const app = createApp({ saved: new Map([[HISTORY_KEY, '["known"]']]),
    print: () => ++attempts === 1 ? false : active.promise });
  app.scan('uncertain');
  await settle();
  app.scan('active');
  app.run('queue.resume();');
  app.scan('waiting');
  app.click('clear-history');
  assert.equal(app.key('Enter').defaultPrevented, true);
  assert.deepEqual(app.find('known'), { reason: 'printed' });
  app.click('clear-history-confirm');
  assert.equal(app.storage.has(HISTORY_KEY), false);
  assert.equal(app.find('known'), null);
  assert.deepEqual(app.find('uncertain'), { reason: 'uncertain' });
  assert.deepEqual(app.find('active'), { reason: 'printing' });
  assert.deepEqual(app.find('waiting'), { reason: 'queued' });
  app.run('queue.clearPending();');
  assert.equal(app.find('waiting'), null);
  active.resolve(false);
  await settle();
});

test('failed and cancelled jobs are not added to persistent successful history', async () => {
  const app = createApp({ print: async () => false });
  app.run('queue.pause();');
  app.scan('cancelled');
  app.run('queue.clearPending(); queue.resume();');
  app.scan('failed');
  await settle();
  assert.equal(app.run('duplicateHistory.size'), 0);
  assert.equal(app.storage.has(HISTORY_KEY), false);
  assert.equal(app.find('cancelled'), null);
  assert.deepEqual(app.find('failed'), { reason: 'uncertain' });
});

test('unavailable storage leaves visible warnings and working session protection', async () => {
  const app = createApp({ storageFails: true });
  assert.equal(app.element('history-warning').hidden, false);
  app.scan(' 003 ');
  await settle();
  assert.deepEqual(app.find(' 003 '), { reason: 'printed' });
  assert.equal(app.element('history-warning').hidden, false);
  assert.equal(app.storage.has(HISTORY_KEY), false);
  app.click('clear-history');
  app.click('clear-history-confirm');
  assert.equal(app.run('duplicateHistory.size'), 0);
  assert.equal(app.element('history-warning').hidden, false);
});

test('corrupt stored history warns without aborting startup or accepting malformed records', () => {
  for (const saved of ['{invalid', '["valid",12]', '{"value":"0001"}', 'null']) {
    const app = createApp({ saved: new Map([[HISTORY_KEY, saved]]) });
    assert.equal(app.element('history-warning').hidden, false);
    assert.equal(app.run('duplicateHistory.size'), 0);
    assert.equal(app.element('scan').disabled, false);
  }
});
