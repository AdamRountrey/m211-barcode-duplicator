import test from 'node:test';
import assert from 'node:assert/strict';
import { M211_DPI, printableWidthMm, printableHeightDots, inspectMedia } from '../sdk-media.js';

function printer(overrides = {}) {
  return {
    isConnected: () => true,
    printerModel: 'M211',
    supplyName: 'M21-500-499',
    supplyWidth: 0.5,
    mediaIsDieCut: false,
    orientation: 'Landscape',
    zoneDimensions: [],
    ...overrides,
  };
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }

test('standard M211 continuous-tape widths match installed SDK geometry', () => {
  for (const [tape, printable, dots] of [[6.35, 5.334, 42], [9.525, 8.509, 68], [12.7, 11.684, 93], [19.05, 16.002, 127]]) {
    near(printableWidthMm(tape), printable);
    assert.equal(printableHeightDots(tape), dots);
  }
  assert.equal(M211_DPI, 203);
});

test('head-width limit is applied before the narrow-tape inset', () => {
  near(printableWidthMm(0.65 * 25.4), 0.63 * 25.4);
  near(printableWidthMm(0.63 * 25.4), 0.59 * 25.4);
});

test('invalid manual widths are refused instead of producing zero or huge images', () => {
  for (const width of [undefined, null, '', 0, -1, NaN, Infinity, 1, 20, '12 mm']) {
    assert.throws(() => printableWidthMm(width), RangeError);
  }
  near(printableWidthMm('12.7'), 11.684);
});

test('unrelated printer status fields do not change continuous-tape geometry', () => {
  const result = inspectMedia(printer({ supplyRemainingPercentage: 0, isSupplyValid: false, ribbonRemainingPercent: 0 }), 12.7);
  assert.equal(result.canAttemptPrint, true);
  assert.equal(result.dimensionsMatch, true);
  assert.equal(result.sdkHeightDots, 93);
});

test('media inspection reads only layout and connection properties', () => {
  const sdk = printer();
  for (const key of ['supplyRemainingPercentage', 'ribbonRemainingPercent', 'isSupplyValid']) {
    Object.defineProperty(sdk, key, { get() { throw new Error(`Must not consult ${key}`); } });
  }
  assert.equal(inspectMedia(sdk, 12.7).canAttemptPrint, true);
});

test('unavailable cartridge dimensions retain manual geometry and offer a cartridge check', () => {
  const result = inspectMedia(printer({ supplyName: '', supplyWidth: 0 }), 12.7);
  assert.equal(result.canAttemptPrint, true);
  assert.equal(result.sdkPrintableWidthMm, null);
  assert.equal(result.sdkHeightDots, null);
  assert.equal(result.dimensionsMatch, null);
  assert.equal(result.manualHeightDots, 93);
  assert.ok(result.warnings.some(message => /cartridge/i.test(message) && /Tape width/.test(message)));
});

test('different manual and detected tape widths retain both geometries', () => {
  const result = inspectMedia(printer({ supplyWidth: 0.75 }), 12.7);
  assert.equal(result.canAttemptPrint, true);
  assert.equal(result.dimensionsMatch, false);
  assert.equal(result.manualHeightDots, 93);
  assert.equal(result.sdkHeightDots, 127);
  near(result.printableWidthMm, 11.684);
  near(result.sdkPrintableWidthMm, 16.002);
});

test('die-cut, portrait and special-zone media are flagged before scale assumptions', () => {
  for (const overrides of [
    { mediaIsDieCut: true },
    { orientation: 'Portrait' },
    { zoneDimensions: [{ Type: 'Printable', Width: '5000', Height: '0' }] },
  ]) {
    const result = inspectMedia(printer(overrides), 12.7);
    assert.equal(result.canAttemptPrint, true);
    assert.equal(result.layoutSupported, false);
    assert.equal(result.sdkHeightDots, null);
    assert.ok(result.warnings.length > 0);
  }
});

test('connection and exact supported model determine whether a print may be attempted', () => {
  assert.equal(inspectMedia(printer({ isConnected: () => false }), 12.7).canAttemptPrint, false);
  assert.equal(inspectMedia(printer({ printerModel: 'M511' }), 12.7).canAttemptPrint, false);
  assert.equal(inspectMedia(printer({ printerModel: '', printerName: 'M211-EXAMPLE' }), 12.7).canAttemptPrint, true);
  assert.equal(inspectMedia(printer({ printerModel: 'M211x' }), 12.7).canAttemptPrint, false);
  assert.equal(inspectMedia(undefined, 12.7).canAttemptPrint, false);
  assert.equal(inspectMedia(printer({ isConnected: () => { throw new Error('offline'); } }), 12.7).canAttemptPrint, false);
});
