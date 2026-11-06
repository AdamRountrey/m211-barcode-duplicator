import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { computeBarcodeLayout, drawBarcode, validateBarcodeValue } from '../barcode.js';

const require = createRequire(import.meta.url);
const JsBarcode = require('jsbarcode');
const { Code128Reader, BitArray } = require('@zxing/library');
const measureText = (value, size) => ({ width: value.length * size * 0.6, actualBoundingBoxAscent: size * 0.75, actualBoundingBoxDescent: size * 0.25 });
const layout = (value, settings = {}) => computeBarcodeLayout(value, settings, { encode: JsBarcode, measureText });

test('leading zeroes and printable characters remain the exact encoded and readable value', () => {
  for (const value of ['0000123456', '0000', 'AB-001/2', ' 1234 ']) {
    const rendered = layout(value);
    assert.equal(rendered.value, value);
    assert.equal(rendered.text.value, value);
    const expected = {};
    JsBarcode(expected, value, { format: 'CODE128' });
    assert.equal(rendered.bits, expected.encodings[0].data);
  }
  assert.notEqual(layout('00001234').bits, layout('1234').bits);
  assert.throws(() => validateBarcodeValue(1234), /must be text/);
});

test('narrow bars stay on whole dots and quiet zones never fall below ten modules', () => {
  for (const moduleDots of [1, 2, 3, 8]) {
    const result = layout('001234567890', { moduleDots, marginLeftMm: 0, marginRightMm: 0 });
    assert.equal(result.barcode.width, result.bits.length * moduleDots);
    assert.ok(result.quietLeftDots >= 10 * moduleDots);
    assert.ok(result.quietRightDots >= 10 * moduleDots);
    assert.ok(result.widthDots >= result.barcode.width + 20 * moduleDots);
    assert.ok(Number.isInteger(result.barcode.x));
    assert.ok(Number.isInteger(result.barcode.y));
  }
  assert.throws(() => layout('1234', { moduleDots: 1.5 }), /whole number/);
});

test('independent ZXing reader recovers the exact scan from the rendered bar row', () => {
  for (const value of ['0000123456', '0000', 'AB-001/2', ' A-123 + 09 ', '98765432109876543210', 'Punct:!@#$%()']) {
    for (const moduleDots of [1, 2, 3]) {
      const result = layout(value, { moduleDots });
      const row = new BitArray(result.widthDots);
      for (let index = 0; index < result.bits.length; index++) {
        if (result.bits[index] === '1') {
          for (let dot = 0; dot < moduleDots; dot++) row.set(result.barcode.x + index * moduleDots + dot);
        }
      }
      const decoded = new Code128Reader().decodeRow(result.barcode.y, row, new Map());
      assert.equal(decoded.getText(), value, `round trip for ${JSON.stringify(value)} at ${moduleDots} dots/module`);
    }
  }
});

test('independent horizontal margins remain outside the required quiet zones', () => {
  const result = layout('12345678', { marginLeftMm: 1, marginRightMm: 3 });
  assert.equal(result.margins.left, 8);
  assert.equal(result.margins.right, 24);
  assert.equal(result.barcode.x, 8 + result.quietZoneDots);
  assert.equal(result.widthDots - (result.barcode.x + result.barcode.width), 24 + result.quietZoneDots);
});

test('height and vertical margins protect the human-readable line from clipping', () => {
  const result = layout('12345678', { marginTopMm: 1, marginBottomMm: 2, barcodeHeightMm: 4 });
  assert.equal(result.barcode.y, 8);
  assert.equal(result.margins.bottom, 16);
  assert.ok(result.text.top >= result.barcode.y + result.barcode.height);
  assert.ok(result.text.top + result.text.heightDots + result.margins.bottom <= result.heightDots);
  assert.throws(() => layout('12345678', { barcodeHeightMm: 10 }), /Reduce barcode height/);
  assert.throws(() => layout('12345678', { marginBottomMm: 10 }), /Reduce barcode height/);
});

test('longer codes grow label length instead of shrinking barcode modules', () => {
  const short = layout('1234');
  const long = layout('1234567890'.repeat(10));
  assert.ok(long.widthDots > short.widthDots);
  assert.equal(long.heightDots, short.heightDots);
  assert.equal(long.moduleDots, short.moduleDots);
  assert.equal(long.barcode.width, long.bits.length * 2);
});

test('canvas across-tape height matches Brady integer-dot target without downstream shrinking', () => {
  assert.equal(layout('123456', { printableWidthMm: 0.63 * 25.4 }).heightDots, 127);
  assert.equal(layout('123456', { printableWidthMm: 0.46 * 25.4 }).heightDots, 93);
});

test('invalid text and nonfinite or negative settings fail before printing', () => {
  for (const value of ['', '0123\n', '0123\t', 'A\u001dB', 'é', '１２３']) assert.throws(() => layout(value));
  for (const setting of [NaN, Infinity, -1, '7', null]) assert.throws(() => layout('1234', { textSizePt: setting }));
  assert.throws(() => layout('1234', { marginLeftMm: -0.1 }));
  assert.throws(() => layout('1234', { printableWidthMm: 0 }));
  assert.throws(() => layout('1234', { dpi: 203.5 }));
});

test('large text extends the label without intruding into barcode quiet zones', () => {
  const result = computeBarcodeLayout('12', { barcodeHeightMm: 2, textSizePt: 18, printableWidthMm: 16 }, {
    encode: JsBarcode,
    measureText: () => ({ width: 500, actualBoundingBoxAscent: 38, actualBoundingBoxDescent: 10 }),
  });
  assert.ok(result.widthDots >= 500 + result.margins.left + result.margins.right);
  assert.ok(result.quietLeftDots >= result.quietZoneDots);
  assert.ok(result.quietRightDots >= result.quietZoneDots);
});

test('drawing uses binary full-height bar runs and prints the exact readable text', () => {
  const rectangles = [];
  const texts = [];
  let pixelData;
  const context = {
    measureText(value) { return measureText(value, Number.parseFloat(this.font)); },
    fillRect(...args) { rectangles.push({ color: this.fillStyle, args }); },
    fillText(...args) { texts.push(args); },
    getImageData(_x, _y, width, height) {
      pixelData = { data: new Uint8ClampedArray(width * height * 4).fill(200) };
      return pixelData;
    },
    putImageData(data) { assert.equal(data, pixelData); },
  };
  const canvas = { getContext: () => context };
  const result = drawBarcode(canvas, '00012345', {}, { encode: JsBarcode });
  assert.equal(canvas.width, result.widthDots);
  assert.equal(canvas.height, result.heightDots);
  assert.equal(context.imageSmoothingEnabled, false);
  assert.deepEqual(texts, [['00012345', result.text.centerX, result.text.baseline]]);
  assert.deepEqual(rectangles[0], { color: '#fff', args: [0, 0, result.widthDots, result.heightDots] });
  const reconstructed = Array(result.bits.length).fill('0');
  for (const { color, args: [x, y, width, height] } of rectangles.slice(1)) {
    assert.equal(color, '#000');
    assert.equal(y, result.barcode.y);
    assert.equal(height, result.barcode.height);
    assert.equal(width % result.moduleDots, 0);
    assert.ok([x, y, width, height].every(Number.isInteger));
    reconstructed.fill('1', (x - result.barcode.x) / result.moduleDots, (x - result.barcode.x + width) / result.moduleDots);
  }
  assert.equal(reconstructed.join(''), result.bits);
  assert.ok(pixelData.data.every(byte => byte === 255));
});
