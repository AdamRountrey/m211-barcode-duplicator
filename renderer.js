import { DEFAULT_SETTINGS, drawBarcode } from './barcode.js';
import { ScanQueue } from './scan-queue.js';
import { inspectMedia, printableWidthMm } from './sdk-media.js';
import { m211LeadingTrim } from './leading-space.js';
import { DuplicateHistory } from './duplicate-history.js';

const $ = id => document.getElementById(id);
const SETTINGS_KEY = 'barcode-copy-settings-v1';
const HISTORY_KEY = 'barcode-copy-history-v1';
const fields = ['moduleDots', 'barcodeHeightMm', 'textSizePt', 'textGapMm', 'marginLeftMm', 'marginRightMm', 'marginTopMm', 'marginBottomMm'];
const sample = '000123456789';
let sdk, connecting = false, connectedBefore = false, lastValue = '', selectedName = '';
let previewLayout = null, lastSummary = '', lastCompletedId = 0, lastUncertainId = 0;
let queueState = { paused: false, pending: [], active: null, uncertain: [], completedCount: 0, lastCompleted: null };
const activity = [];
let duplicateHistory = new DuplicateHistory(), pendingDuplicate = null;
let historyRestoreWarning = '', historySaveWarning = '';

function log(message, detail = {}) {
  activity.push(`${new Date().toLocaleTimeString()}  ${message}`);
  $('activity').textContent = activity.slice(-35).join('\n');
  window.desktop.log({ message, ...detail });
}
function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
  log(message);
}
function scanStatus(message, error = false) {
  $('scan-status').textContent = message;
  $('scan-status').classList.toggle('error', error);
}
function connected() { return sdk?.isConnected() === true; }
function isM211() { return /^M211(?:$|[-\s])/i.test(String(sdk?.printerModel || sdk?.printerName || selectedName)); }
function canSend() { return connected() && isM211() && !connecting; }
function hasOpenDialog() { return Boolean(document.querySelector('dialog[open]')); }
function controls() {
  const up = connected();
  const dialogOpen = hasOpenDialog();
  $('connect').disabled = !sdk || up || connecting;
  $('disconnect').disabled = !up || connecting || Boolean(queueState.active);
  $('print').disabled = dialogOpen || !canSend() || !previewLayout || !currentValue() || Boolean(queueState.active);
  $('scan').disabled = dialogOpen;
  $('duplicate-confirm').disabled = !pendingDuplicate || !canSend();
  $('clear-history').disabled = dialogOpen || (!duplicateHistory.size && !historyRestoreWarning && !historySaveWarning);
  $('badge').textContent = up ? 'Connected' : connecting ? 'Connecting' : 'Disconnected';
  $('badge').classList.toggle('connected', up);
  $('queue-toggle').textContent = queueState.paused ? 'Resume queue' : 'Pause queue';
  $('queue-toggle').disabled = queueState.paused && !canSend();
  $('clear-queue').disabled = queueState.pending.length === 0;
}
function renderHistory() {
  $('history-count').textContent = `${duplicateHistory.size} barcode${duplicateHistory.size === 1 ? '' : 's'} remembered`;
  $('history-warning').textContent = [historyRestoreWarning, historySaveWarning].filter(Boolean).join(' ');
  $('history-warning').hidden = !historyRestoreWarning && !historySaveWarning;
}
function restoreHistory() {
  try {
    const saved = localStorage.getItem(HISTORY_KEY);
    duplicateHistory = new DuplicateHistory(saved === null ? [] : JSON.parse(saved));
  } catch {
    historyRestoreWarning = 'Saved duplicate history could not be read. Earlier labels may not be detected; labels printed during this session are still remembered.';
  }
  renderHistory();
}
function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(duplicateHistory));
    historySaveWarning = '';
  } catch {
    historySaveWarning = 'Duplicate history could not be saved. Protection still works in this session, but these changes may be lost when the app closes.';
  }
  renderHistory();
}
function currentValue() { return $('scan').value || lastValue; }
function readSettings() {
  const tapeWidthMm = Number($('tape-width').value);
  const settings = { ...DEFAULT_SETTINGS, dpi: 203, printableWidthMm: printableWidthMm(tapeWidthMm) };
  for (const name of fields) settings[name] = $(name).value === '' ? NaN : Number($(name).value);
  return { ...settings, tapeWidthMm, saveTape: $('save-tape').checked };
}
function restoreSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!saved) return;
    // Apply the requested minimum side margins once, keeping all other choices.
    if (saved.version !== 2) { saved.marginLeftMm = 0; saved.marginRightMm = 0; saved.saveTape = true; }
    if ([6.35, 9.525, 12.7, 19.05].includes(saved.tapeWidthMm)) $('tape-width').value = String(saved.tapeWidthMm);
    for (const name of fields) if (Number.isFinite(saved[name])) $(name).value = String(saved[name]);
    if (typeof saved.autoPrint === 'boolean') $('auto-print').checked = saved.autoPrint;
    if (typeof saved.saveTape === 'boolean') $('save-tape').checked = saved.saveTape;
  } catch { log('Saved settings could not be restored; using defaults.'); }
}
function saveSettings() {
  const settings = readSettings();
  if (fields.some(name => !Number.isFinite(settings[name]))) return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, autoPrint: $('auto-print').checked, version: 2 }));
  } catch { log('Settings could not be saved; current settings remain usable in this session.'); }
}
function checkGeometry(settings) {
  const media = inspectMedia(sdk, settings.tapeWidthMm);
  if (connected() && !media.layoutSupported) throw new Error('Use ordinary continuous tape for this barcode layout. The detected cartridge has a different label format.');
  if (connected() && media.dimensionsMatch === false) {
    throw new Error(`Set Tape width to ${media.detectedTapeWidthMm.toFixed(2)} mm to match the printer’s reported dimensions and preserve exact barcode sizing.`);
  }
  return media;
}
function leadingTrim(canvas, layout) {
  const media = {
    ...inspectMedia(sdk, layout.settings.tapeWidthMm),
    orientation: sdk?.orientation,
    isDieCut: sdk?.mediaIsDieCut,
    metadataKnown: Boolean(sdk?.supplyName && Number(sdk?.supplyWidth) > 0),
  };
  return m211LeadingTrim(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), layout, media, sdk?.rotation);
}
function preview() {
  try {
    const settings = readSettings();
    const value = currentValue();
    const media = inspectMedia(sdk, settings.tapeWidthMm);
    $('media-note').textContent = connected() ? media.warnings.join(' ') : 'Choose the width of the continuous tape loaded in the printer.';
    checkGeometry(settings);
    previewLayout = drawBarcode($('preview'), value || sample, settings);
    $('preview').hidden = false;
    $('preview').setAttribute('aria-label', `Code 128 barcode with readable text ${value || sample}`);
    $('preview-kind').textContent = value ? 'Code 128' : 'Example';
    const leadingTrimMm = leadingTrim($('preview'), previewLayout) * 25.4 / settings.dpi;
    const totalLengthMm = previewLayout.lengthMm - leadingTrimMm + (settings.saveTape ? 0.435 : 0.87) * 25.4;
    $('layout-info').textContent = `${previewLayout.lengthMm.toFixed(1)} mm content · estimated ${totalLengthMm.toFixed(1)} mm cut length · ${settings.moduleDots} dot bars. ${settings.saveTape ? `Trailing blank removed.${leadingTrimMm > 0 ? ` Another ${leadingTrimMm.toFixed(1)} mm saved at the leading edge.` : ''}` : 'Leading and trailing edges included.'}`;
    $('layout-error').hidden = true;
  } catch (error) {
    previewLayout = null;
    $('preview').hidden = true;
    $('layout-error').textContent = error.message;
    $('layout-error').hidden = false;
    $('layout-info').textContent = 'Adjust the settings before printing.';
  }
  controls();
}

async function sendJob(job) {
  if (!canSend()) throw new Error('Printer disconnected before submission. Check the printer before trying this label again.');
  checkGeometry(job.settings);
  let image = new Image();
  image.src = job.dataUrl;
  await image.decode();
  // The M211's fixed leader already supplies the barcode's left quiet zone.
  // Trim only duplicate white columns, preserving every ink pixel and user margin.
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const leadingTrimDots = leadingTrim(canvas, job.layout);
  if (leadingTrimDots > 0) {
    const cropped = context.getImageData(leadingTrimDots, 0, canvas.width - leadingTrimDots, canvas.height);
    canvas.width -= leadingTrimDots;
    context.putImageData(cropped, 0, 0);
    image = new Image(); image.src = canvas.toDataURL('image/png'); await image.decode();
  }
  if (!canSend()) throw new Error('Printer disconnected before submission.');
  checkGeometry(job.settings);
  sdk.setCopies(1);
  sdk.setCutOption(0);
  // The pinned local SDK adaptation explicitly sends the M211 trailer setting on every page.
  if (!sdk.printOptions || typeof sdk.printOptions !== 'object') throw new Error('This SDK does not expose the expected print options.');
  sdk.printOptions.printTrailer = !job.settings.saveTape;
  log('Submitting one Code 128 label.', { characters: job.value.length, width: image.width, height: image.height, leadingTrimDots, saveTape: job.settings.saveTape, trailerCommand: sdk.printOptions.printTrailer ? 'STX W 1' : 'STX W 0' });
  const result = await sdk.printBitmap(image);
  if (!result) {
    const message = sdk.message && !/Initialized|Connected/i.test(sdk.message) ? String(sdk.message) : 'The printer did not confirm printing. Check the printer and loaded tape before trying again.';
    throw new Error(message);
  }
  return true;
}
function renderQueue(snapshot) {
  queueState = snapshot;
  // Commit the confirmed value synchronously before another scan can be handled.
  if (snapshot.lastCompleted && snapshot.lastCompleted.id !== lastCompletedId) {
    lastCompletedId = snapshot.lastCompleted.id;
    if (duplicateHistory.recordSuccess(snapshot.lastCompleted.job.value)) saveHistory();
    log('Printer confirmed one barcode label.');
  }
  $('queue-count').textContent = `${snapshot.pending.length} waiting · ${snapshot.completedCount} printed`;
  const problem = snapshot.uncertain.at(-1);
  if (snapshot.paused) $('queue-status').textContent = snapshot.pauseReason;
  else if (snapshot.active) $('queue-status').textContent = `Printing ${snapshot.active.job.value}`;
  else if (snapshot.lastCompleted) $('queue-status').textContent = `Printed ${snapshot.lastCompleted.job.value}. Ready for the next scan.`;
  else $('queue-status').textContent = 'Ready for your first scan.';
  $('queue-status').classList.toggle('error', snapshot.paused && Boolean(problem));
  $('jobs').replaceChildren();
  const rows = [];
  if (problem) rows.push([problem, 'Check result']);
  if (snapshot.active) rows.push([snapshot.active, 'Printing']);
  rows.push(...snapshot.pending.slice(0, 5).map(item => [item, 'Waiting']));
  if (snapshot.lastCompleted) rows.push([snapshot.lastCompleted, 'Printed']);
  for (const [item, label] of rows) {
    const li = document.createElement('li');
    const value = document.createElement('code'); value.textContent = item.job.value;
    const state = document.createElement('span'); state.textContent = label;
    li.append(value, state);
    if (item.error) li.title = item.error;
    $('jobs').append(li);
  }
  if (problem && problem.id !== lastUncertainId) {
    lastUncertainId = problem.id;
    scanStatus(`Print result needs checking: ${problem.error} This label will not be retried automatically.`, true);
    log('Print result uncertain. Queue paused.', { error: problem.error });
  }
  controls();
}
const queue = new ScanQueue({ send: sendJob, canSend, onChange: renderQueue, maxPending: 50 });

function freezeCapturedJob(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeCapturedJob(child, seen);
  return Object.freeze(value);
}
function enqueueCapturedJob(job) {
  const id = queue.enqueue(job);
  scanStatus(`Accepted label ${id}${queueState.paused ? ' — held in paused queue' : ''}. Ready for the next scan.`);
}
function showDuplicate(job, reason) {
  const messages = {
    printing: 'This barcode is currently printing.',
    queued: 'This barcode is already waiting in the print queue.',
    uncertain: 'A previous print of this barcode has an uncertain result. Check the physical label first.',
    printed: 'This barcode has already been printed.',
  };
  pendingDuplicate = job;
  $('duplicate-value').textContent = job.value;
  $('duplicate-reason').textContent = messages[reason];
  $('duplicate-error').hidden = true;
  $('duplicate-dialog').showModal();
  controls();
  $('duplicate-cancel').focus();
  scanStatus('Duplicate found. Choose Cancel or Print again before scanning another code.');
}
function cancelDuplicate() {
  pendingDuplicate = null;
  $('duplicate-dialog').close();
  scanStatus('Duplicate cancelled. No additional label was queued.');
}
function confirmDuplicate() {
  if (!$('duplicate-dialog').open || !pendingDuplicate) return;
  if (!canSend()) {
    $('duplicate-error').textContent = 'The printer is disconnected. Cancel, reconnect, then try again.';
    $('duplicate-error').hidden = false;
    controls();
    return;
  }
  const job = pendingDuplicate;
  // Consume before enqueueing: repeated clicks cannot enqueue this capture twice.
  pendingDuplicate = null;
  $('duplicate-confirm').disabled = true;
  try {
    enqueueCapturedJob(job);
    $('duplicate-dialog').close();
  } catch (error) {
    pendingDuplicate = job;
    $('duplicate-error').textContent = error.message;
    $('duplicate-error').hidden = false;
    controls();
  }
}
function confirmClearHistory() {
  if (!$('clear-history-dialog').open) return;
  $('clear-history-dialog').close();
  const count = duplicateHistory.clear();
  historyRestoreWarning = '';
  try {
    localStorage.removeItem(HISTORY_KEY);
    historySaveWarning = '';
  } catch {
    historySaveWarning = 'History was cleared for this session, but saved history could not be removed and may return when the app restarts.';
  }
  renderHistory();
  controls();
  scanStatus(`Cleared ${count} remembered barcode${count === 1 ? '' : 's'}. Active, waiting and uncertain labels still trigger duplicate warnings.`);
}
function submit(value, shouldPrint) {
  try {
    if (hasOpenDialog()) return false;
    const settings = readSettings();
    checkGeometry(settings);
    const canvas = document.createElement('canvas');
    const layout = drawBarcode(canvas, value, settings);
    if (shouldPrint) {
      if (!canSend()) throw new Error('Connect the M211 before printing a label.');
      const job = freezeCapturedJob(structuredClone({ value, settings, layout, dataUrl: canvas.toDataURL('image/png'), widthDots: layout.widthDots, heightDots: layout.heightDots }));
      const duplicate = duplicateHistory.find(value, queue.snapshot());
      if (duplicate) showDuplicate(job, duplicate.reason);
      else enqueueCapturedJob(job);
    } else scanStatus('Preview updated. Select Print preview when ready.');
    lastValue = value;
    $('scan').value = '';
    preview();
    return true;
  } catch (error) {
    scanStatus(error.message, true);
    preview();
    return false;
  }
}
function focusScanner() { if (!hasOpenDialog()) $('scan').focus({ preventScroll: true }); }
for (const id of ['duplicate-dialog', 'clear-history-dialog']) {
  $(id).addEventListener('close', () => {
    if (id === 'duplicate-dialog') pendingDuplicate = null;
    controls();
    focusScanner();
  });
  $(id).addEventListener('cancel', event => {
    event.preventDefault();
    if (id === 'duplicate-dialog') cancelDuplicate();
    else $(id).close();
  });
}
$('duplicate-cancel').addEventListener('click', cancelDuplicate);
$('duplicate-confirm').addEventListener('click', event => {
  // Keyboard activation is handled explicitly below, never by a scanner suffix.
  if (event.detail > 0) confirmDuplicate();
});
$('clear-history').addEventListener('click', () => {
  if (hasOpenDialog()) return;
  $('clear-history-dialog').showModal();
  controls();
  $('clear-history-cancel').focus();
});
$('clear-history-cancel').addEventListener('click', () => $('clear-history-dialog').close());
$('clear-history-confirm').addEventListener('click', event => {
  if (event.detail > 0) confirmClearHistory();
});
function handleDecisionKey(event) {
  const duplicateOpen = $('duplicate-dialog').open;
  const clearOpen = $('clear-history-dialog').open;
  if (!duplicateOpen && !clearOpen) return;
  if (!['Enter', ' ', 'Escape'].includes(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type !== 'keydown' || event.repeat || event.isComposing) return;
  if (event.key === 'Escape') {
    if (duplicateOpen) cancelDuplicate();
    else $('clear-history-dialog').close();
  } else if (event.key === 'Enter' && event.ctrlKey && !event.altKey && !event.metaKey) {
    if (duplicateOpen) confirmDuplicate();
    else confirmClearHistory();
  }
}
document.addEventListener('keydown', handleDecisionKey, true);
document.addEventListener('keyup', handleDecisionKey, true);
$('scan').addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === 'Tab') && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
    event.preventDefault();
    if (event.repeat || !$('scan').value) return;
    if (!submit($('scan').value, $('auto-print').checked)) $('scan').select();
  }
});
$('scan').addEventListener('input', preview);
for (const event of ['focus', 'blur']) $('scan').addEventListener(event, () => {
  const focused = document.activeElement === $('scan');
  $('focus-state').textContent = focused ? 'Scanner ready' : 'Click to scan';
  $('focus-state').classList.toggle('ready', focused);
});
$('focus-scan').addEventListener('click', focusScanner);
$('print').addEventListener('click', () => {
  if (queueState.active || $('print').disabled) return;
  submit(currentValue(), true);
  focusScanner();
});
for (const name of [...fields, 'tape-width']) $(name).addEventListener('input', () => { preview(); saveSettings(); });
$('auto-print').addEventListener('change', () => { saveSettings(); focusScanner(); });
$('save-tape').addEventListener('change', () => { preview(); saveSettings(); });
$('reset-settings').addEventListener('click', () => {
  for (const name of fields) $(name).value = String(DEFAULT_SETTINGS[name]);
  $('tape-width').value = '12.7';
  $('save-tape').checked = true;
  preview(); saveSettings();
});
$('queue-toggle').addEventListener('click', () => {
  try { queueState.paused ? queue.resume() : queue.pause('Queue paused. Scans will be held until you resume.'); }
  catch (error) { scanStatus(error.message, true); }
  focusScanner();
});
$('clear-queue').addEventListener('click', () => {
  const count = queue.clearPending();
  scanStatus(`Cleared ${count} waiting label${count === 1 ? '' : 's'}. Any active print will finish.`);
  focusScanner();
});

function refresh() {
  if (!sdk) return;
  const up = connected();
  if (up) {
    $('printer').textContent = sdk.printerName || selectedName || 'M211';
    $('connection-info').textContent = `${sdk.supplyName || 'Cartridge not identified'}${sdk.batteryLevelPercentage == null ? '' : ` · Battery ${sdk.batteryLevelPercentage}%`}`;
    const summary = JSON.stringify({ model: sdk.printerModel, supply: sdk.supplyName, width: sdk.supplyWidth, status: sdk.status, message: sdk.message });
    if (summary !== lastSummary) { log('Printer status updated.', { printer: JSON.parse(summary) }); lastSummary = summary; }
  } else if (connectedBefore) {
    status('Printer disconnected. Reconnect to continue.', true);
    if (queueState.active || queueState.pending.length) queue.pause('Printer disconnected. Check the current label, reconnect, then resume waiting labels.');
  }
  connectedBefore = up;
  preview();
}
window.desktop.onDevices(devices => {
  $('devices').replaceChildren();
  if (!devices.length) { $('devices').textContent = 'Scanning… No M211 found yet.'; return; }
  for (const device of devices) {
    const button = document.createElement('button'); button.className = 'device';
    const name = document.createElement('span'); name.textContent = device.deviceName;
    const identifier = document.createElement('small'); identifier.textContent = device.deviceId;
    button.append(name, identifier);
    button.addEventListener('click', () => { selectedName = device.deviceName; window.desktop.chooseDevice(device.deviceId); });
    $('devices').append(button);
  }
});
window.desktop.onDiscoveryState(state => {
  $('picker').hidden = !state.active;
  if (state.message) status(state.message);
});
window.desktop.onPairing(details => {
  $('pairing-message').textContent = details.pairingKind === 'confirmPin' ? `Confirm the printer shows PIN ${details.pin}.` : details.pairingKind === 'providePin' ? 'Enter the PIN supplied by the printer.' : 'Confirm pairing with the selected M211.';
  $('pin-label').hidden = details.pairingKind !== 'providePin'; $('pin').value = ''; $('pairing').showModal(); controls();
});
function answerPairing(confirmed) { window.desktop.answerPairing({ confirmed, pin: $('pin').value }); $('pairing').close(); }
$('pair-yes').addEventListener('click', () => answerPairing(true));
$('pair-no').addEventListener('click', () => answerPairing(false));
$('pairing').addEventListener('cancel', () => window.desktop.answerPairing({ confirmed: false }));
$('pairing').addEventListener('close', () => { controls(); focusScanner(); });
$('cancel').addEventListener('click', () => window.desktop.cancelDiscovery());
$('connect').addEventListener('click', async () => {
  if (connecting || connected()) return;
  connecting = true; controls(); $('devices').textContent = 'Scanning…';
  status('Searching for nearby Brady printers…');
  try {
    const result = await sdk.showDiscoveredBleDevices();
    if (result && connected()) {
      if (!isM211()) { await sdk.disconnect(); throw new Error('Select an M211 printer.'); }
      status(queueState.paused ? 'M211 connected. Review the paused queue before resuming.' : 'M211 connected. Scan a barcode to print.');
    } else status(sdk.getConnectionErrorMessage?.() || 'No printer connected. Check that the M211 is on and available.', true);
  } catch (error) { status(`Connection failed: ${error.message}`, true); }
  finally { connecting = false; $('picker').hidden = true; $('pairing').close(); refresh(); if (connected()) focusScanner(); }
});
$('disconnect').addEventListener('click', async () => {
  if (connecting || !connected() || queueState.active) return;
  if (queueState.pending.length) queue.pause('Disconnected. Reconnect, then resume waiting labels.');
  connecting = true; controls();
  try { await sdk.disconnect(); status(connected() ? 'Printer is still connected. Try again.' : 'Disconnected from the M211.', connected()); }
  catch (error) { status(`Disconnect failed: ${error.message}`, true); }
  finally { connecting = false; refresh(); }
});
window.addEventListener('error', event => log('Application error', { message: event.message }));
window.addEventListener('unhandledrejection', event => status(`Application error: ${event.reason?.message || event.reason}`, true));
window.addEventListener('beforeunload', event => {
  if (queueState.active || queueState.pending.length) { event.preventDefault(); event.returnValue = ''; }
});
restoreHistory(); restoreSettings(); preview(); saveSettings(); renderQueue(queue.snapshot()); focusScanner();
try {
  const { default: BradySdk } = await import('./vendor/brady-web-sdk/bundle.js');
  sdk = new BradySdk(() => queueMicrotask(refresh), false);
  if (!navigator.bluetooth) throw new Error('Bluetooth is not available in this Electron runtime.');
  const available = await navigator.bluetooth.getAvailability();
  status(available ? 'Ready. Select Find M211 to connect.' : 'Bluetooth is unavailable. Turn it on or connect an adapter.', !available);
  log('Barcode app ready.', { bluetoothAvailable: available }); controls();
} catch (error) { status(`Could not initialize printer software: ${error.message}`, true); }
