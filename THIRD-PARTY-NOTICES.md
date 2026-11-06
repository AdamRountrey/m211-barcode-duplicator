# Third-party software

The application source and third-party components have separate licensing terms.

| Component | Version | License / notices |
| --- | --- | --- |
| Electron | 45.2.3 | MIT; Chromium and other bundled notices in the runtime's `LICENSE` and `LICENSES.chromium.html` |
| JsBarcode | 3.12.3 | MIT; `node_modules/jsbarcode/MIT-LICENSE.txt` |
| Brady Web SDK | 3.3.3 | Proprietary; `node_modules/@bradycorporation/brady-web-sdk/LICENSE.md` and bundled `*.LICENSE.txt` files |
| ZXing JavaScript library | 0.23.0 | Apache-2.0; development/test dependency only |
| Inno Setup | Build tool | See the compiler installation's license; not bundled as a compiler with the application |

Brady's [SDK agreement](https://sdk.bradyid.com/licences/) permits integration for connecting and printing to Brady printers and imposes separate modification and distribution restrictions. This repository does not grant rights to Brady software. The app's preparation script generates an adapted SDK locally; review the agreement before using or redistributing that adaptation.

SDK binaries, installed dependencies and compiled installers are excluded from Git history. Downloadable Windows installers include the required runtime components and preserve the SDK license, asset notices, provenance and adaptation description, as well as Electron and JsBarcode notices.

Brady and M211 are names of their respective owner. This independent application is not endorsed by Brady.
