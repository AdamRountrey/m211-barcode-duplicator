/** Geometry used by the installed Brady Web SDK 3.3.3 for plain continuous M211 tape.
 * This module describes geometry without changing SDK or printer state.
 */
export const M211_DPI = 203;
const MM_PER_INCH = 25.4;
const MAX_TAPE_MM = 19.05;
const HEAD_WIDTH_INCHES = 0.63;
const NARROW_TAPE_INSET_INCHES = 0.04;

export function printableWidthMm(tapeWidthMm) {
  const width = Number(tapeWidthMm);
  if (!Number.isFinite(width) || width <= NARROW_TAPE_INSET_INCHES * MM_PER_INCH || width > MAX_TAPE_MM + 1e-8) {
    throw new RangeError('Tape width must be greater than 1.016 mm and no greater than 19.05 mm.');
  }
  const inches = width / MM_PER_INCH;
  // Brady applies the inset only when tape fits entirely inside the printhead width.
  return (inches > HEAD_WIDTH_INCHES ? HEAD_WIDTH_INCHES : inches - NARROW_TAPE_INSET_INCHES) * MM_PER_INCH;
}

export function printableHeightDots(tapeWidthMm) {
  return Math.floor(printableWidthMm(tapeWidthMm) / MM_PER_INCH * M211_DPI + 1e-9);
}

/**
 * Describe layout and transport capabilities.
 * canAttemptPrint expresses connection and supported printer model.
 * Plain continuous Landscape tape is the supported layout in this first version.
 */
export function inspectMedia(sdk, manualTapeWidthMm) {
  const manualWidthMm = Number(manualTapeWidthMm);
  const manualPrintableWidthMm = printableWidthMm(manualWidthMm);
  const warnings = [];
  let connected = false;
  try { connected = sdk?.isConnected?.() === true; } catch { /* Disconnected/failed SDK state. */ }
  const model = String(sdk?.printerModel || sdk?.printerName || '');
  const isM211 = /^M211(?:$|[-\s])/i.test(model);
  const canAttemptPrint = connected && isM211;

  const reportedInches = Number(sdk?.supplyWidth);
  const detectedTapeWidthMm = Number.isFinite(reportedInches) && reportedInches > 0
    ? reportedInches * MM_PER_INCH : null;
  const isDieCut = sdk?.mediaIsDieCut === true;
  const orientation = String(sdk?.orientation || 'Landscape');
  const zoneSource = sdk?.zoneDimensions;
  const zones = Array.isArray(zoneSource) ? zoneSource : zoneSource && typeof zoneSource === 'object' ? Object.values(zoneSource) : [];
  const hasPrintableZones = zones.some(zone => zone?.Type === 'Printable');
  const layoutSupported = !isDieCut && orientation === 'Landscape' && !hasPrintableZones;
  let sdkPrintableWidthMm = null;
  let sdkHeightDots = null;
  if (detectedTapeWidthMm !== null && layoutSupported) {
    try {
      sdkPrintableWidthMm = printableWidthMm(detectedTapeWidthMm);
      sdkHeightDots = printableHeightDots(detectedTapeWidthMm);
    } catch {
      warnings.push('The printer reported a tape width outside the M211 continuous-tape range.');
    }
  }

  if (!sdk?.supplyName || detectedTapeWidthMm === null) {
    warnings.push('Cartridge details are unavailable. Check that the cartridge is seated correctly and Tape width matches the loaded tape.');
  }
  if (isDieCut) warnings.push('This barcode layout currently supports continuous tape, not die-cut labels.');
  if (orientation !== 'Landscape') warnings.push('The detected cartridge uses a different orientation from the continuous landscape barcode layout.');
  if (hasPrintableZones) warnings.push('This cartridge has special printable zones; exact barcode scaling has not been verified for this media.');

  const dimensionsMatch = detectedTapeWidthMm === null ? null : Math.abs(detectedTapeWidthMm - manualWidthMm) < 0.01;
  if (dimensionsMatch === false) {
    warnings.push(`Manual tape width is ${manualWidthMm.toFixed(2)} mm; the printer reports ${detectedTapeWidthMm.toFixed(2)} mm. The SDK uses its reported width when generating the print job.`);
  }
  return {
    connected,
    isM211,
    canAttemptPrint,
    reason: !connected ? 'Connect the M211 before printing.' : !isM211 ? 'Choose an M211 printer.' : '',
    printableWidthMm: manualPrintableWidthMm,
    manualHeightDots: printableHeightDots(manualWidthMm),
    detectedTapeWidthMm,
    sdkPrintableWidthMm,
    sdkHeightDots,
    dimensionsMatch,
    layoutSupported,
    isDieCut,
    warnings,
  };
}
