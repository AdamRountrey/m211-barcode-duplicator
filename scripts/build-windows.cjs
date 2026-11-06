// Build from installed dependencies only. No dependency downloads or broad project copy.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EXPECTED_VERSION, EXPECTED_SHA256, sha256, patchBundle } = require('./prepare-sdk.cjs');

const APP_NAME = 'M211 Barcode Copy';
const APP_FILES = [
  'main.cjs', 'preload.cjs', 'index.html', 'styles.css', 'renderer.js',
  'barcode.js', 'scan-queue.js', 'sdk-media.js', 'leading-space.js',
  'duplicate-history.js', 'package.json',
];
const BARCODE_RUNTIME = 'dist/barcodes/JsBarcode.code128.min.js';
const BARCODE_LICENSE = 'MIT-LICENSE.txt';

function requireFile(file) {
  if (!fs.statSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`);
  return file;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(requireFile(file), 'utf8'));
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function assertSafeStaging(root, dist, stage) {
  // These targets are fixed by this script, never supplied by the command line.
  if (!samePath(dist, path.join(root, 'dist')) || !samePath(stage, path.join(dist, 'win-unpacked'))) {
    throw new Error('Refusing to recreate a staging path outside this project dist directory.');
  }
  for (const directory of [dist, stage]) {
    if (!fs.existsSync(directory)) continue;
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory() ||
        !samePath(fs.realpathSync(directory), directory)) {
      throw new Error(`Refusing to recreate redirected staging directory: ${directory}`);
    }
  }
}

function validateVendor(root) {
  const upstream = path.join(root, 'node_modules', '@bradycorporation', 'brady-web-sdk');
  const sourceDist = path.join(upstream, 'dist');
  const vendor = path.join(root, 'vendor', 'brady-web-sdk');
  const packageInfo = readJson(path.join(upstream, 'package.json'));
  const expectedBundle = patchBundle(fs.readFileSync(requireFile(path.join(sourceDist, 'bundle.js'))), packageInfo.version);
  const provenance = readJson(path.join(vendor, 'provenance.json'));
  if (provenance.package !== '@bradycorporation/brady-web-sdk' || provenance.version !== EXPECTED_VERSION ||
      provenance.upstreamSha256 !== EXPECTED_SHA256 || provenance.generatedSha256 !== sha256(expectedBundle) ||
      provenance.prepareCommand !== 'node scripts/prepare-sdk.cjs') {
    throw new Error('Vendor provenance does not match the reviewed SDK adaptation. Run npm run prepare:sdk.');
  }

  const sourceEntries = fs.readdirSync(sourceDist, { withFileTypes: true });
  if (sourceEntries.some(entry => !entry.isFile())) throw new Error('Unexpected upstream SDK asset type.');
  const names = [...sourceEntries.map(entry => entry.name), 'LICENSE.md', 'provenance.json', 'README.md'].sort();
  const vendorEntries = fs.readdirSync(vendor, { withFileTypes: true });
  if (vendorEntries.some(entry => !entry.isFile()) ||
      JSON.stringify(vendorEntries.map(entry => entry.name).sort()) !== JSON.stringify(names)) {
    throw new Error('Unexpected or missing vendor SDK files. Regenerate the reviewed vendor directory.');
  }

  for (const entry of sourceEntries) {
    const expected = entry.name === 'bundle.js' ? expectedBundle : fs.readFileSync(path.join(sourceDist, entry.name));
    const actual = fs.readFileSync(path.join(vendor, entry.name));
    if (sha256(actual) !== sha256(expected)) throw new Error(`Vendor SDK hash mismatch: ${entry.name}`);
  }
  if (!fs.readFileSync(path.join(vendor, 'LICENSE.md')).equals(fs.readFileSync(path.join(upstream, 'LICENSE.md')))) {
    throw new Error('The vendor Brady license differs from the upstream license.');
  }
  return { directory: vendor, files: names, version: packageInfo.version };
}

function findCompiler() {
  const candidates = process.env.INNO_ISCC ? [process.env.INNO_ISCC] : [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  ];
  const compiler = candidates.find(candidate => candidate && path.isAbsolute(candidate) && fs.existsSync(candidate));
  if (!compiler) throw new Error('Inno Setup compiler not found. Set INNO_ISCC to its absolute ISCC.exe path, or use --stage-only.');
  return requireFile(compiler);
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function buildWindows({ stageOnly = false } = {}) {
  if (process.platform !== 'win32') throw new Error('This build uses the installed Windows Electron runtime and must run on Windows.');
  const root = fs.realpathSync(path.resolve(__dirname, '..'));
  const dist = path.join(root, 'dist');
  const stage = path.join(dist, 'win-unpacked');
  const appDirectory = path.join(stage, 'resources', 'app');
  const runtime = path.join(root, 'node_modules', 'electron', 'dist');
  const barcode = path.join(root, 'node_modules', 'jsbarcode');
  const manifest = readJson(path.join(root, 'package.json'));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Installer version must have three numeric components.');
  if (manifest.main !== 'main.cjs') throw new Error('Unexpected application entry point.');

  // Complete preflight before replacing any previously staged application.
  APP_FILES.forEach(name => requireFile(path.join(root, name)));
  const vendor = validateVendor(root);
  const barcodeInfo = readJson(path.join(barcode, 'package.json'));
  requireFile(path.join(barcode, BARCODE_RUNTIME));
  requireFile(path.join(barcode, BARCODE_LICENSE));
  const executable = fs.readFileSync(requireFile(path.join(runtime, 'electron.exe')));
  const peOffset = executable.length >= 64 ? executable.readUInt32LE(0x3c) : -1;
  if (peOffset < 0 || peOffset + 6 > executable.length || executable.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000' ||
      executable.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error('The installed Electron runtime is not a Windows x64 executable.');
  }
  requireFile(path.join(runtime, 'LICENSE'));
  requireFile(path.join(runtime, 'LICENSES.chromium.html'));
  const electronInfo = readJson(path.join(root, 'node_modules', 'electron', 'package.json'));
  const runtimeVersion = fs.readFileSync(requireFile(path.join(runtime, 'version')), 'utf8').trim().replace(/^v/, '');
  if (runtimeVersion !== electronInfo.version || electronInfo.version !== manifest.dependencies.electron ||
      barcodeInfo.version !== manifest.dependencies.jsbarcode) {
    throw new Error('Installed Electron or JsBarcode version differs from the pinned application dependency.');
  }
  const installer = requireFile(path.join(root, 'installer', 'm211-barcode-copy.iss'));
  const compiler = stageOnly ? null : findCompiler();
  assertSafeStaging(root, dist, stage);
  fs.mkdirSync(dist, { recursive: true });
  // Verify the resolved absolute target immediately before the only recursive delete.
  assertSafeStaging(root, dist, stage);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.cpSync(runtime, stage, {
    recursive: true,
    filter: source => !samePath(source, path.join(runtime, 'resources', 'default_app.asar')),
  });
  fs.renameSync(path.join(stage, 'electron.exe'), path.join(stage, `${APP_NAME}.exe`));
  for (const name of APP_FILES) copyFile(path.join(root, name), path.join(appDirectory, name));
  for (const name of vendor.files) copyFile(path.join(vendor.directory, name), path.join(appDirectory, 'vendor', 'brady-web-sdk', name));
  for (const name of [BARCODE_RUNTIME, BARCODE_LICENSE]) {
    copyFile(path.join(barcode, name), path.join(appDirectory, 'node_modules', 'jsbarcode', name));
  }
  fs.writeFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), [
    `${APP_NAME} ${manifest.version} - third-party software notices`,
    '',
    `Electron ${electronInfo.version}: see LICENSE and LICENSES.chromium.html in this directory.`,
    `JsBarcode ${barcodeInfo.version}: MIT license; see resources/app/node_modules/jsbarcode/MIT-LICENSE.txt.`,
    `Brady Web SDK ${vendor.version}: proprietary Brady license; see resources/app/vendor/brady-web-sdk/LICENSE.md.`,
    'Brady SDK dependencies retain their bundled *.LICENSE.txt notices.',
    'The application-local Brady adaptation and its source hashes are described in the vendor README.md and provenance.json.',
    'Third-party components remain subject to their respective licenses; an application source license does not replace them.',
    '',
  ].join('\r\n'));
  console.log(`Staged ${APP_NAME} ${manifest.version}: ${stage}`);
  if (!stageOnly) {
    const result = spawnSync(compiler, [`/DAppVersion=${manifest.version}`, `/DSourceDir=${stage}`, `/O${dist}`, installer], {
      cwd: root, stdio: 'inherit', shell: false, windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Inno Setup failed with exit status ${result.status}.`);
    const output = requireFile(path.join(dist, `M211-Barcode-Copy-Setup-${manifest.version}.exe`));
    console.log(`Installer ready: ${output}`);
  }
  return { stage, version: manifest.version };
}

module.exports = { APP_FILES, assertSafeStaging, validateVendor, buildWindows };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--stage-only') || args.length > 1) throw new Error('Usage: node scripts/build-windows.cjs [--stage-only]');
    buildWindows({ stageOnly: args.includes('--stage-only') });
  } catch (error) {
    console.error(`Windows build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
