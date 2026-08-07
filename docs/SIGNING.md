# Code signing & release pipeline

Releases are built by `.github/workflows/release.yml` on a `v*` tag:

| OS | Targets | Signer |
|---|---|---|
| windows-latest | `.exe` (NSIS), `.msi` | electron-builder → signtool |
| macos-latest | `.dmg`, `.pkg` | electron-builder → codesign |

## Current mode: SELF-SIGNED (testing only)

When no certificate secrets are configured, the workflow **generates a self-signed certificate in
CI** and signs with it:

- Windows: `New-SelfSignedCertificate -Type CodeSigningCert` → exported PFX → `CSC_LINK`/`CSC_KEY_PASSWORD`.
- macOS: `openssl` cert with the `codeSigning` EKU → `.p12` → `CSC_LINK`/`CSC_KEY_PASSWORD`; notarization disabled.

Installers WILL trigger SmartScreen (Windows) and Gatekeeper (macOS) warnings — expected for
self-signed builds. On macOS: right-click → Open, or `xattr -dr com.apple.quarantine SweepDeck.app`.
The self-signed `.pkg` may be unsigned if the cert type is rejected by `productbuild` — this is a
known limitation and acceptable in testing mode.

## Switching to real certificates

Add these repository secrets — the workflow automatically prefers them:

| Secret | Content |
|---|---|
| `WIN_CSC_LINK` | base64 of your OV/EV code-signing `.pfx` (or an https URL) |
| `WIN_CSC_KEY_PASSWORD` | PFX password |
| `MAC_CSC_LINK` | base64 of your **Developer ID Application** `.p12` |
| `MAC_CSC_KEY_PASSWORD` | P12 password |

For notarized macOS releases also add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
and set `-c.mac.notarize=true` (electron-builder runs `notarytool` automatically). For a signed
`.pkg` you additionally need a **Developer ID Installer** certificate in the same keychain.

## Release procedure

```bash
git tag v0.1.0 && git push origin v0.1.0
# → GHA builds, signs, and attaches .exe/.msi/.dmg/.pkg to a GitHub Release
```
