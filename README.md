# M211 Barcode Copy

A standalone Windows app that copies a scanned Code 128 value onto Brady M211 label tape, with readable text below the barcode.

## Install and use

[Download the Windows installer from the latest release](https://github.com/AdamRountrey/m211-barcode-duplicator/releases/latest), run it, then open **M211 Barcode Copy** from the Start menu. Installation is per user and does not need administrator access. The installer includes Electron; end users do not need Node.js or a web browser.

1. Power on the M211 and select **Find M211**.
2. Select the width of the continuous tape actually loaded.
3. Connect a USB scanner in keyboard mode, configured to send an **Enter or Tab suffix**.
4. Keep **Scan a barcode** focused and scan. Automatic printing queues one label with the scanned value and readable text.

Disable automatic printing to preview first, then select **Print preview**. Configure the scanner to send only the barcode data, without prefixes or symbology identifiers. The app preserves leading zeros, case and spaces. It supports printable ASCII Code 128 data; it rejects control characters, GS1 control sequences and non-ASCII text instead of silently changing them. It recreates the encoded value, not the source label's graphics.

Windows 10/11 x64, working Bluetooth and a Brady M211 are required. The scanner uses USB; the printer connection is Bluetooth. If a phone owns the printer connection, close Express Labels there, hold the M211 power button for five seconds to release ownership, then reconnect.

## Duplicate warnings

A barcode already printed, currently printing, waiting in the queue, or associated with an uncertain print prompts before another copy is queued. Choose **Cancel** or deliberately select **Print again**. Normal Enter/Space keystrokes cannot confirm these dialogs; **Ctrl+Enter** confirms and **Escape** cancels.

Successfully printed values are remembered locally across restarts. **Clear history** asks for confirmation and removes remembered successes. Active, queued and uncertain labels still trigger warnings during that session. If local storage cannot be read or saved, the app shows a warning.

History starts with prints made by this version on this computer; it cannot detect labels printed elsewhere or by earlier versions. Barcode history is stored as plain text in the local app profile. Clear it when it is no longer needed.

## Label settings

Adjust bar width (whole 203-DPI printer dots), bar height, text size, text gap and each margin. Labels grow in length to fit the value. A layout too tall for the tape is rejected. Continuous ¼, ⅜, ½ and ¾ inch tape is supported; die-cut and special-zone media are not.

**Save tape** removes the approximately 11 mm trailing allowance. With verified M211 geometry, it also uses the fixed physical leader as part of the barcode quiet zone; the default bar width can save another 2.5 mm. The printer's approximately 11 mm mechanical leading allowance remains. The cut-length display is an estimate. Barcode quiet zones and printed pixels are preserved.

Settings persist and apply to future scans. A queued label retains the settings captured when it was scanned, including while a duplicate confirmation is open.

## Print queue

Up to 50 labels may wait while another prints. Pause holds waiting jobs; Clear waiting removes jobs that have not started. A failed or uncertain print pauses the queue. Inspect the physical output before reprinting: **Resume queue never retries the uncertain job**. Waiting jobs and uncertain results do not survive closing the app.

## Build from source

Use Windows x64, Node.js 24.12 or later, and pnpm 11.25.0. Review the [Brady SDK license](https://sdk.bradyid.com/licences/) before installing or using that dependency.

```powershell
pnpm install --frozen-lockfile
node node_modules/electron/install.js
pnpm prepare:sdk
pnpm check
pnpm test
pnpm start
```

The explicit Electron installation step downloads the runtime; the pinned Electron package does not install it automatically. `Launch-M211.cmd` also starts a prepared development checkout.

The generated `vendor/brady-web-sdk/` directory is excluded from Git. `prepare:sdk` derives it from the pinned official npm dependency, verifies its version and SHA-256, and applies the local trailer-toggle adaptation used by Save tape. Upstream notices and provenance are retained.

Install [Inno Setup 6](https://jrsoftware.org/isdl.php), then build:

```powershell
# Set this only if the compiler is not in a standard installation directory.
$env:INNO_ISCC = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
pnpm build:win
```

Output: `dist/M211-Barcode-Copy-Setup-0.3.1.exe`. `pnpm package:win` prepares `dist/win-unpacked/` without compiling an installer. The build uses an explicit file allowlist and verifies the SDK assets; it excludes settings, history, logs, development tools and tests.

Release installers are unsigned. Generated SDK files and build output are excluded from Git; release installers include the required runtime components and their license notices. Third-party components remain subject to their respective terms. See [third-party notices](THIRD-PARTY-NOTICES.md).

## Data and checks

Installed settings, duplicate history and Bluetooth ownership are stored under `%APPDATA%\M211 Barcode Copy\`. Diagnostics are under its `logs\` directory. Uninstall retains this profile. Development uses `.app-data/` and `logs/` in the checkout, a separate profile.

Resources load locally, the renderer is sandboxed with context isolation, remote navigation is blocked, and Brady analytics are disabled. The app captures scanner input only while its own field is focused. It does not install a global keyboard hook.

`pnpm test` covers barcode geometry and independent ZXing decoding, print queue behavior, media geometry, leading-space trimming, SDK adaptation, persistent duplicate history and renderer confirmation flows. These automated checks use simulated printer boundaries and do not consume tape.

This is an independent utility, not an official Brady product. No general license for the application source is granted in this repository; third-party components retain their own licenses.
