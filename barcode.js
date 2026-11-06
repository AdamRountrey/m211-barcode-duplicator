// All dimensions are calculated in printer dots before drawing. In particular,
// bars are never scaled to fit the label: their narrow-module width stays whole.
export const DEFAULT_SETTINGS = Object.freeze({
  dpi: 203,
  printableWidthMm: 11.684,
  moduleDots: 2,
  barcodeHeightMm: 5,
  textSizePt: 7,
  textGapMm: 0.5,
  marginLeftMm: 0,
  marginRightMm: 0,
  marginTopMm: 0.5,
  marginBottomMm: 0.5,
});

export class LabelLayoutError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LabelLayoutError';
    this.code = code;
  }
}

function positiveNumber(value, name, { min = 0, max = 1000, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new LabelLayoutError(`${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`, 'SETTING');
  }
  return value;
}

function normalizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  positiveNumber(s.dpi, 'Printer DPI', { min: 72, max: 600, integer: true });
  positiveNumber(s.printableWidthMm, 'Printable tape width', { min: 1, max: 25.4 });
  positiveNumber(s.moduleDots, 'Barcode module width', { min: 1, max: 8, integer: true });
  positiveNumber(s.barcodeHeightMm, 'Barcode height', { min: 0.5, max: 25.4 });
  positiveNumber(s.textSizePt, 'Number size', { min: 2, max: 72 });
  positiveNumber(s.textGapMm, 'Text gap', { max: 25.4 });
  for (const side of ['Left', 'Right', 'Top', 'Bottom']) {
    positiveNumber(s[`margin${side}Mm`], `${side} margin`, { max: 100 });
  }
  return s;
}

export function validateBarcodeValue(value) {
  if (typeof value !== 'string') throw new LabelLayoutError('The barcode must be text so leading zeroes are preserved.', 'VALUE');
  if (!value.length) throw new LabelLayoutError('Scan or enter a barcode first.', 'EMPTY');
  if (value.length > 256) throw new LabelLayoutError('A barcode can contain at most 256 characters.', 'VALUE');
  if (!/^[\x20-\x7e]+$/.test(value)) {
    throw new LabelLayoutError('Use ordinary Code 128 text (printable ASCII). Control characters and GS1 separators are not supported.', 'VALUE');
  }
  return value;
}

function encodeCode128(value, encoder) {
  if (typeof encoder !== 'function') throw new LabelLayoutError('The Code 128 encoder is unavailable.', 'ENCODER');
  const target = {};
  try {
    encoder(target, value, { format: 'CODE128', displayValue: false, width: 1, margin: 0 });
  } catch (error) {
    throw new LabelLayoutError(`Cannot encode this Code 128 value: ${error.message || error}`, 'ENCODER');
  }
  const bits = target.encodings?.flat(Infinity).map(part => part.data || '').join('');
  if (!bits || !/^[01]+$/.test(bits)) throw new LabelLayoutError('The Code 128 encoder returned invalid bar data.', 'ENCODER');
  return bits;
}

function defaultMeasure(value, fontSizeDots) {
  // Tests and callers that do not have a canvas can supply exact font metrics.
  // This conservative fallback is not used by drawBarcode's canvas renderer.
  return { width: value.length * fontSizeDots, actualBoundingBoxAscent: fontSizeDots * 0.8, actualBoundingBoxDescent: fontSizeDots * 0.2 };
}

export function computeBarcodeLayout(value, inputSettings = {}, { encode = globalThis.JsBarcode, measureText = defaultMeasure } = {}) {
  validateBarcodeValue(value);
  const settings = normalizeSettings(inputSettings);
  const { dpi, moduleDots } = settings;
  const toDots = mm => Math.ceil(mm * dpi / 25.4 - 1e-9);
  // Brady floors the M211's across-tape target to whole dots. Matching it here
  // prevents its proportional bitmap fitter from shrinking every barcode bar.
  const heightDots = Math.floor(settings.printableWidthMm / 25.4 * dpi);
  const margins = {
    left: toDots(settings.marginLeftMm), right: toDots(settings.marginRightMm),
    top: toDots(settings.marginTopMm), bottom: toDots(settings.marginBottomMm),
  };
  const barcodeHeight = toDots(settings.barcodeHeightMm);
  const gapDots = toDots(settings.textGapMm);
  const textSizeDots = Math.max(1, Math.round(settings.textSizePt * dpi / 72));
  const metrics = measureText(value, textSizeDots, 'Arial');
  if (!metrics || !Number.isFinite(metrics.width) || metrics.width < 0) {
    throw new LabelLayoutError('Could not measure the barcode text.', 'FONT');
  }
  const ascent = Math.ceil(Number.isFinite(metrics.actualBoundingBoxAscent) ? Math.max(0, metrics.actualBoundingBoxAscent) : textSizeDots * 0.8);
  const descent = Math.ceil(Number.isFinite(metrics.actualBoundingBoxDescent) ? Math.max(0, metrics.actualBoundingBoxDescent) : textSizeDots * 0.2);
  const textHeightDots = Math.max(textSizeDots, ascent + descent);
  const textWidthDots = Math.ceil(Math.max(metrics.width,
    Number.isFinite(metrics.actualBoundingBoxLeft) && Number.isFinite(metrics.actualBoundingBoxRight)
      ? metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight : 0));
  const requiredHeight = margins.top + barcodeHeight + gapDots + textHeightDots + margins.bottom;
  if (requiredHeight > heightDots) {
    throw new LabelLayoutError(`Barcode, numbers and margins need ${(requiredHeight * 25.4 / dpi).toFixed(1)} mm of printable width; only ${settings.printableWidthMm.toFixed(1)} mm is available. Reduce barcode height, number size or vertical margins.`, 'HEIGHT');
  }
  const bits = encodeCode128(value, encode);
  const barcodeWidth = bits.length * moduleDots;
  const quietZoneDots = moduleDots * 10;
  const contentWidthDots = Math.max(barcodeWidth + quietZoneDots * 2, textWidthDots);
  const widthDots = margins.left + contentWidthDots + margins.right;
  if (widthDots > 8192) {
    throw new LabelLayoutError('This label is too long. Reduce barcode width, number size or horizontal margins.', 'LENGTH');
  }
  const barcodeX = margins.left + Math.floor((contentWidthDots - barcodeWidth) / 2);
  const textTop = margins.top + barcodeHeight + gapDots;
  return {
    value, bits, settings, dpi, moduleDots, widthDots, heightDots,
    lengthMm: widthDots * 25.4 / dpi,
    printableWidthMm: heightDots * 25.4 / dpi,
    margins, quietZoneDots,
    quietLeftDots: barcodeX - margins.left,
    quietRightDots: widthDots - margins.right - (barcodeX + barcodeWidth),
    barcode: { x: barcodeX, y: margins.top, width: barcodeWidth, height: barcodeHeight },
    text: {
      value, sizeDots: textSizeDots, widthDots: textWidthDots, heightDots: textHeightDots,
      centerX: margins.left + contentWidthDots / 2,
      baseline: textTop + Math.floor((textHeightDots - ascent - descent) / 2) + ascent,
      top: textTop,
    },
    unusedBottomDots: heightDots - requiredHeight,
  };
}

export function drawBarcode(canvas, value, settings = {}, { encode = globalThis.JsBarcode } = {}) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new LabelLayoutError('The label preview canvas is unavailable.', 'CANVAS');
  const layout = computeBarcodeLayout(value, settings, {
    encode,
    measureText(text, size, font) {
      context.font = `${size}px ${font}`;
      context.textAlign = 'left';
      return context.measureText(text);
    },
  });
  canvas.width = layout.widthDots;
  canvas.height = layout.heightDots;
  context.imageSmoothingEnabled = false;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  for (let index = 0; index < layout.bits.length;) {
    if (layout.bits[index] !== '1') { index++; continue; }
    const start = index;
    while (layout.bits[index] === '1') index++;
    context.fillRect(layout.barcode.x + start * layout.moduleDots, layout.barcode.y,
      (index - start) * layout.moduleDots, layout.barcode.height);
  }
  context.font = `${layout.text.sizeDots}px Arial`;
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  context.fillText(layout.value, layout.text.centerX, layout.text.baseline);
  // The printer is monochrome. Threshold text antialiasing here so the preview
  // represents the same one-bit image sent to the printer, without resizing.
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const color = pixels.data[index] < 128 ? 0 : 255;
    pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = color;
    pixels.data[index + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return layout;
}
