import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import adapter from '../scripts/prepare-sdk.cjs';

const { EXPECTED_VERSION, EXPECTED_SHA256, ORIGINAL_FLAG, PATCHED_FLAG,
  ORIGINAL_COMMAND, PATCHED_COMMAND,
  sha256, patchBundle, prepareSdk } = adapter;
const root = fileURLToPath(new URL('..', import.meta.url));
const sdk = path.join(root, 'node_modules', '@bradycorporation', 'brady-web-sdk');
const upstream = fs.readFileSync(path.join(sdk, 'dist', 'bundle.js'));
const upstreamText = upstream.toString('utf8');

test('reviewed SDK version and original source content are pinned', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'))).version, EXPECTED_VERSION);
  assert.equal(sha256(upstream), EXPECTED_SHA256);
  assert.equal(upstreamText.split(ORIGINAL_FLAG).length - 1, 1);
  assert.equal(upstreamText.split(ORIGINAL_COMMAND).length - 1, 1);
});

test('adaptation makes exactly the two reviewed trailer changes', () => {
  const generated = patchBundle(upstream, EXPECTED_VERSION).toString('utf8');
  assert.equal(generated.split(PATCHED_FLAG).length - 1, 1);
  assert.equal(generated.split(PATCHED_COMMAND).length - 1, 1);
  assert.equal(generated.includes(ORIGINAL_FLAG), false);
  assert.equal(generated.includes(ORIGINAL_COMMAND), false);
  assert.equal(generated.replace(PATCHED_FLAG, ORIGINAL_FLAG)
    .replace(PATCHED_COMMAND, ORIGINAL_COMMAND), upstreamText);
});

test('unexpected version, changed input and already adapted input fail closed', () => {
  assert.throws(() => patchBundle(upstream, '3.3.4'), /unreviewed version/);
  assert.throws(() => patchBundle(Buffer.concat([upstream, Buffer.from('\n')]), EXPECTED_VERSION), /SHA256 mismatch/);
  assert.throws(() => patchBundle(patchBundle(upstream, EXPECTED_VERSION), EXPECTED_VERSION), /SHA256 mismatch/);
});

test('locally generated copy matches reproducible adaptation and records provenance', () => {
  const output = path.join(root, 'vendor', 'brady-web-sdk');
  const generated = fs.readFileSync(path.join(output, 'bundle.js'));
  assert.deepEqual(generated, patchBundle(upstream, EXPECTED_VERSION));
  const provenance = JSON.parse(fs.readFileSync(path.join(output, 'provenance.json')));
  assert.equal(provenance.upstreamSha256, EXPECTED_SHA256);
  assert.equal(provenance.generatedSha256, sha256(generated));
  for (const name of fs.readdirSync(path.join(sdk, 'dist')).filter(name => name !== 'bundle.js')) {
    assert.deepEqual(fs.readFileSync(path.join(output, name)), fs.readFileSync(path.join(sdk, 'dist', name)), name);
  }
  assert.deepEqual(fs.readFileSync(path.join(output, 'LICENSE.md')), fs.readFileSync(path.join(sdk, 'LICENSE.md')));
});

test('regeneration preserves source bytes and is deterministic', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'm211-sdk-test-'));
  try {
    const first = prepareSdk(root, temporary);
    const before = fs.readFileSync(path.join(temporary, 'bundle.js'));
    const second = prepareSdk(root, temporary);
    assert.equal(first.generatedSha256, second.generatedSha256);
    assert.deepEqual(fs.readFileSync(path.join(temporary, 'bundle.js')), before);
    assert.equal(sha256(fs.readFileSync(path.join(sdk, 'dist', 'bundle.js'))), EXPECTED_SHA256);
  } finally {
    // The target is the exact directory created above; never remove a computed parent.
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('an output directory inside the installed SDK is refused', () => {
  assert.throws(() => prepareSdk(root, path.join(sdk, 'dist')), /must not modify/);
  assert.equal(sha256(fs.readFileSync(path.join(sdk, 'dist', 'bundle.js'))), EXPECTED_SHA256);
});

test('actual adapted M211 constructor defaults on and disables only for explicit false', () => {
  const source = patchBundle(upstream, EXPECTED_VERSION).toString('utf8');
  const match = source.match(/this\.printerModel==M\.M211\?\((.*?)\):this\.printerModel==M\.i7500/);
  assert.ok(match, 'Pinned M211 constructor branch exists.');
  for (const [value, expected] of [[undefined, true], [true, true], [false, false], [0, true], [null, true]]) {
    const context = { model: { printOptions: { printTrailer: value } } };
    vm.runInNewContext(`(function(){ ${match[1]}; }).call(model);`, context, { timeout: 1000 });
    assert.equal(context.model.printTrailer, expected);
    assert.equal(context.model.xUPI, 203);
    assert.equal(context.model.yUPI, 203);
    assert.equal(context.model.sendOnePageAtATime, true);
  }
});

test('adapted M211 constructor and page generator explicitly switch trailer on and off per job', () => {
  // Exercise both actual adapted methods; stub only unrelated packet commands.
  const source = patchBundle(upstream, EXPECTED_VERSION).toString('utf8');
  const constructor = source.match(/this\.printerModel==M\.M211\?\((.*?)\):this\.printerModel==M\.i7500/);
  assert.ok(constructor, 'Pinned M211 constructor branch exists.');
  const start = source.indexOf('printPageStart(e,t,n,r){');
  const end = source.indexOf('printPageEnd(', start);
  assert.ok(start >= 0 && end > start);
  const method = source.slice(start, end);
  const trailerStart = source.indexOf('static sendSTXW(e,t){');
  const trailerEnd = source.indexOf('static sendXCURS(', trailerStart);
  assert.ok(trailerStart >= 0 && trailerEnd > trailerStart);
  const trailerMethod = source.slice(trailerStart, trailerEnd).replace(/^static /, '');
  const requests = [
    { model: 'M211', enabled: undefined, expected: [2, 87, 1] },
    { model: 'M211', enabled: false, expected: [2, 87, 0] },
    { model: 'M211', enabled: true, expected: [2, 87, 1] },
    { model: 'M211', enabled: false, expected: [2, 87, 0] },
    { model: 'M211', enabled: true, expected: [2, 87, 1] },
    { model: 'M511', enabled: false, expected: [] },
    { model: 'M511', enabled: true, expected: [2, 87, 1] },
    { model: 'M511', enabled: false, expected: [] },
  ];
  const context = { requests, page: { m_OverallPageWidth: 0.46, m_OverallPageHeight: 1 } };
  vm.runInNewContext(`
    const M = { M211: 'M211', M511: 'M511' };
    const Ve = { EndOfJob: 0, Never: 2 };
    const noOp = bytes => bytes;
    const Qe = { ${trailerMethod}, sendStxM:noOp, sendLabelPageSize:noOp,
      sendSTXA:noOp, sendSTXQ:noOp, sendSTXa:noOp, sendSTXI:noOp,
      sendXCURS:noOp, sendYCURS:noOp };
    const generator = { ${method} };
    const initializeM211 = function(){ ${constructor[1]}; };
    results = requests.map(request => {
      const flags = {
        printerModel: request.model,
        printOptions: { printTrailer: request.enabled, copies: 1, cutOption: Ve.EndOfJob },
        printTrailer: request.enabled, sendOnePageAtATime: false,
        bitmaps: [{}], xUPI: 300, yUPI: 300
      };
      if (flags.printerModel === M.M211) initializeM211.call(flags);
      const bytes = [];
      generator.printPageStart(bytes, flags, 1, page);
      return bytes;
    });
  `, context, { timeout: 1000 });
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    assert.deepEqual(Array.from(context.results[index]), request.expected,
      `Job ${index + 1}: ${request.model} printTrailer=${request.enabled}`);
  }
});
