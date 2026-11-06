/**
 * Count fully opaque, pure-white raster columns that can be removed from one
 * edge. Used only after the print renderer has produced its final RGBA bitmap.
 * Any non-white color or non-opaque alpha stops trimming, including text pixels.
 * The returned count always leaves at least one column and never mutates data.
 */
export function calculateLeadingTrim(data, width, height, maxTrimDots, edge = 'left') {
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
    throw new TypeError('RGBA data must be a Uint8Array or Uint8ClampedArray.');
  }
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError('Raster width and height must be positive safe integers.');
  }
  const expectedLength = width * height * 4;
  if (!Number.isSafeInteger(expectedLength) || data.length !== expectedLength) {
    throw new RangeError('RGBA data length must equal width × height × 4.');
  }
  if (!Number.isSafeInteger(maxTrimDots) || maxTrimDots < 0) {
    throw new RangeError('Maximum trim must be a nonnegative safe integer.');
  }
  if (edge !== 'left' && edge !== 'right') {
    throw new RangeError('Trim edge must be left or right.');
  }

  const limit = Math.min(maxTrimDots, width - 1);
  for (let trim = 0; trim < limit; trim++) {
    const x = edge === 'left' ? trim : width - 1 - trim;
    for (let y = 0; y < height; y++) {
      const offset = (y * width + x) * 4;
      if (data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255 || data[offset + 3] !== 255) {
        return trim;
      }
    }
  }
  return limit;
}

/**
 * Credit the M211's known 10 mm hardware leading space against redundant white
 * raster columns. The caller supplies verified raw metadata as additional media
 * fields; uncertain media, scaling or rotation always leaves the raster intact.
 * Outer user padding is retained separately from the credited quiet-zone space.
 */
export function m211LeadingTrim(imageData, layout, media, rotation) {
  if (layout?.settings?.saveTape !== true || media?.canAttemptPrint !== true ||
      media.layoutSupported !== true || media.dimensionsMatch !== true ||
      media.metadataKnown !== true || media.orientation !== 'Landscape' ||
      media.isDieCut !== false || rotation !== 0 ||
      !imageData || media.sdkHeightDots !== imageData.height) return 0;

  const margin = layout.margins?.left;
  if (!Number.isSafeInteger(margin) || margin < 0 ||
      !Number.isSafeInteger(layout.quietZoneDots) || layout.quietZoneDots < 0 ||
      !Number.isFinite(layout.dpi) || layout.dpi <= 0) return 0;

  const maxCredit = Math.min(layout.quietZoneDots, Math.floor(10 * layout.dpi / 25.4));
  if (!Number.isSafeInteger(maxCredit + margin)) return 0;
  const whiteColumns = calculateLeadingTrim(imageData.data, imageData.width, imageData.height,
    maxCredit + margin, 'left');
  return Math.max(0, whiteColumns - margin);
}
