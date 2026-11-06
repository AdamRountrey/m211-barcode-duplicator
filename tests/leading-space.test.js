import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { calculateLeadingTrim, m211LeadingTrim } from '../leading-space.js';
import { computeBarcodeLayout } from '../barcode.js';

const require = createRequire(import.meta.url);
const JsBarcode = require('jsbarcode');
const { BitArray, Code128Reader } = require('@zxing/library');

function white(width, height) { return new Uint8ClampedArray(width * height * 4).fill(255); }
function pixel(data, width, x, y, rgba) { data.set(rgba, (y * width + x) * 4); }

function validMedia(height) {
  return {
    canAttemptPrint: true, layoutSupported: true, dimensionsMatch: true,
    metadataKnown: true, orientation: 'Landscape', isDieCut: false, sdkHeightDots: height,
  };
}
function trimFixture() {
  const image = { data: white(150, 5), width: 150, height: 5 };
  const layout = { settings: { saveTape: true }, dpi: 203, quietZoneDots: 20, margins: { left: 8 } };
  pixel(image.data, 150, 28, 1, [0, 0, 0, 255]);
  return { image, layout, media: validMedia(5) };
}

test('left trim stops at black barcode or text pixels on any raster row', () => {
  const data = white(12, 5);
  pixel(data, 12, 7, 0, [0, 0, 0, 255]);
  pixel(data, 12, 3, 4, [0, 0, 0, 255]);
  const original = data.slice();
  assert.equal(calculateLeadingTrim(data, 12, 5, 10, 'left'), 3);
  assert.deepEqual(data, original);
});

test('right trim counts from the requested edge and preserves the first marked column', () => {
  const data = white(12, 3);
  pixel(data, 12, 2, 1, [0, 0, 0, 255]);
  pixel(data, 12, 8, 2, [0, 0, 0, 255]);
  assert.equal(calculateLeadingTrim(data, 12, 3, 12, 'left'), 2);
  assert.equal(calculateLeadingTrim(data, 12, 3, 12, 'right'), 3);
});

test('trim never exceeds its cap even when more white columns exist', () => {
  const data = white(12, 2);
  pixel(data, 12, 7, 1, [0, 0, 0, 255]);
  assert.equal(calculateLeadingTrim(data, 12, 2, 2, 'left'), 2);
  assert.equal(calculateLeadingTrim(data, 12, 2, 0, 'left'), 0);
  assert.equal(calculateLeadingTrim(data, 12, 2, 3, 'right'), 3);
});

test('pure-white and single-column images always retain at least one column', () => {
  for (const edge of ['left', 'right']) {
    assert.equal(calculateLeadingTrim(white(5, 3), 5, 3, 999, edge), 4);
    assert.equal(calculateLeadingTrim(white(1, 3), 1, 3, 999, edge), 0);
  }
});

test('any nonwhite channel or partial transparency protects the entire column', () => {
  for (const rgba of [[254, 255, 255, 255], [255, 254, 255, 255], [255, 255, 254, 255], [255, 255, 255, 254], [255, 255, 255, 0]]) {
    const data = white(5, 2);
    pixel(data, 5, 0, 1, rgba);
    assert.equal(calculateLeadingTrim(data, 5, 2, 4, 'left'), 0);
    assert.equal(calculateLeadingTrim(data, 5, 2, 4, 'right'), 4);
  }
});

test('Uint8Array data and omitted edge work without mutation', () => {
  const data = new Uint8Array(4 * 2 * 4).fill(255);
  pixel(data, 4, 2, 1, [0, 0, 0, 255]);
  const original = data.slice();
  assert.equal(calculateLeadingTrim(data, 4, 2, 10), 2);
  assert.deepEqual(data, original);
});

test('invalid raster types, geometry, caps and edges fail explicitly', () => {
  const data = white(4, 2);
  for (const invalid of [null, [], new Float32Array(32), new DataView(new ArrayBuffer(32))]) {
    assert.throws(() => calculateLeadingTrim(invalid, 4, 2, 2), TypeError);
  }
  for (const width of [0, -1, 1.5, NaN, Infinity, '4', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculateLeadingTrim(data, width, 2, 2), RangeError);
  }
  for (const height of [0, -1, 1.5, NaN, Infinity, '2']) {
    assert.throws(() => calculateLeadingTrim(data, 4, height, 2), RangeError);
  }
  assert.throws(() => calculateLeadingTrim(data, 3, 2, 2), /data length/);
  assert.throws(() => calculateLeadingTrim(data, Number.MAX_SAFE_INTEGER, 2, 2), /data length/);
  for (const cap of [-1, 0.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculateLeadingTrim(data, 4, 2, cap), RangeError);
  }
  for (const edge of ['top', '', 0, null]) {
    assert.throws(() => calculateLeadingTrim(data, 4, 2, 2, edge), /left or right/);
  }
});

test('M211 compensation credits only quiet-zone whitespace and preserves user left margin', () => {
  const { image, layout, media } = trimFixture();
  const before = image.data.slice();
  const trim = m211LeadingTrim(image, layout, media, 0);
  assert.equal(trim, 20);
  assert.equal(28 - trim, layout.margins.left);
  assert.deepEqual(image.data, before);
});

test('human-readable ink nearer the edge limits M211 trimming without losing padding', () => {
  const { image, layout, media } = trimFixture();
  pixel(image.data, image.width, 13, 4, [0, 0, 0, 255]);
  assert.equal(m211LeadingTrim(image, layout, media, 0), 5);
  pixel(image.data, image.width, 7, 4, [0, 0, 0, 255]);
  assert.equal(m211LeadingTrim(image, layout, media, 0), 0);
});

test('M211 leading credit is capped by both the quiet zone and the 10 mm physical header', () => {
  const { image, layout, media } = trimFixture();
  image.data.fill(255);
  assert.equal(m211LeadingTrim(image, layout, media, 0), 20);
  layout.quietZoneDots = 100;
  assert.equal(m211LeadingTrim(image, layout, media, 0), 79);
  assert.ok(m211LeadingTrim(image, layout, media, 0) <= Math.floor(10 * 203 / 25.4));
});

test('M211 trim is skipped for unsupported, disconnected, unknown, mismatched or rotated media', () => {
  const { image, layout, media } = trimFixture();
  for (const key of ['canAttemptPrint', 'layoutSupported', 'dimensionsMatch', 'metadataKnown']) {
    assert.equal(m211LeadingTrim(image, layout, { ...media, [key]: false }, 0), 0, key);
    assert.equal(m211LeadingTrim(image, layout, { ...media, [key]: undefined }, 0), 0, `${key} missing`);
  }
  for (const patch of [{ orientation: 'Portrait' }, { orientation: undefined }, { isDieCut: true }, { isDieCut: undefined }, { sdkHeightDots: 4 }]) {
    assert.equal(m211LeadingTrim(image, layout, { ...media, ...patch }, 0), 0);
  }
  for (const rotation of [90, 180, 270, '0', undefined, null]) assert.equal(m211LeadingTrim(image, layout, media, rotation), 0);
  assert.equal(m211LeadingTrim(image, { ...layout, settings: { saveTape: false } }, media, 0), 0);
  assert.equal(m211LeadingTrim(image, { ...layout, margins: { left: -1 } }, media, 0), 0);
  assert.equal(m211LeadingTrim(image, { ...layout, quietZoneDots: NaN }, media, 0), 0);
  assert.equal(m211LeadingTrim(image, { ...layout, dpi: 0 }, media, 0), 0);
  assert.equal(m211LeadingTrim(null, layout, media, 0), 0);
});

test('independent ZXing decode preserves payload after raster trim plus physical leading header', () => {
  const values = ['0000123456', 'AB-001/2', ' A-123 + 09 ', '98765432109876543210'];
  for (const value of values) {
    for (const moduleDots of [1, 2, 3, 8]) {
      const layout = computeBarcodeLayout(value, { moduleDots, marginLeftMm: 1, saveTape: true }, {
        encode: JsBarcode,
        measureText: (text, size) => ({ width: text.length * size * 0.6, actualBoundingBoxAscent: size * 0.75, actualBoundingBoxDescent: size * 0.25 }),
      });
      const image = { data: white(layout.widthDots, layout.heightDots), width: layout.widthDots, height: layout.heightDots };
      const y = layout.barcode.y;
      for (let index = 0; index < layout.bits.length; index++) {
        if (layout.bits[index] === '1') {
          for (let dot = 0; dot < moduleDots; dot++) pixel(image.data, image.width, layout.barcode.x + index * moduleDots + dot, y, [0, 0, 0, 255]);
        }
      }
      const trim = m211LeadingTrim(image, layout, validMedia(image.height), 0);
      const physicalHeader = Math.floor(10 * layout.dpi / 25.4);
      assert.ok(trim > 0);
      assert.ok(layout.barcode.x - trim >= layout.margins.left);
      assert.ok(physicalHeader + layout.barcode.x - trim >= layout.quietZoneDots);
      const row = new BitArray(physicalHeader + image.width - trim);
      for (let x = trim; x < image.width; x++) {
        if (image.data[(y * image.width + x) * 4] < 128) row.set(physicalHeader + x - trim);
      }
      assert.equal(new Code128Reader().decodeRow(y, row, new Map()).getText(), value);
    }
  }
});
