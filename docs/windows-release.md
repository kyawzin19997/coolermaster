# MasterDeck Windows releases

The Windows release runs on `windows-latest` and builds the existing Tauri desktop app with the same frontend used by the browser demo. It produces a per-user NSIS setup for Windows 10/11 x64 with offline WebView2, the MasterDeck icon, a Start menu entry, a desktop shortcut option, and an uninstaller. The manual **Desktop installers** workflow can also build a universal macOS DMG as an Actions artifact.

## One-time GitHub setup

1. Use a GitHub repository with Actions enabled. For anyone to download the installer and for in-app update checks to work without GitHub credentials, the repository must be public. This project's release repository is [kyawzin19997/coolermaster](https://github.com/kyawzin19997/coolermaster).
2. From a checkout with the correct GitHub `origin`, run `node scripts/windows-release.mjs configure`. This updates the README download URL and release links using that remote. Commit any README changes.
3. Install the locked frontend dependencies, then generate a password-protected Tauri signing key **outside the checkout**. Run these from the repository root in PowerShell.

   ```powershell
   pnpm --dir app install --frozen-lockfile
   $key = Join-Path $env:USERPROFILE 'hubdeck-updater.key'
   pnpm --dir app exec tauri signer generate --write-keys $key
   ```

4. Under **Settings → Secrets and variables → Actions**, add the following values. The workflow uses the built-in `GITHUB_TOKEN` to publish. A separate access token is unnecessary.

   | Type | Name | Value |
   | --- | --- | --- |
   | Repository secret | `TAURI_SIGNING_PRIVATE_KEY` | Entire contents of `hubdeck-updater.key` |
   | Repository secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password used when generating the key |
   | Repository variable | `TAURI_UPDATER_PUBLIC_KEY` | Entire contents of `hubdeck-updater.key.pub` |

   Keep a protected backup of the private key and password. Reuse that key for every update. A release signed with a different key cannot update existing installations, which must install a new trusted setup manually. Keep private keys and passwords out of Git.

## Validate before the first public release

Push the source and workflow files to `main` and check that **CI** passes. To test packaging before setting up release keys, run **Actions → Desktop installers → Run workflow**. Its Windows artifact is an unsigned preview with updates disabled. You can also build the same type of preview locally.

```powershell
pnpm --dir app install --frozen-lockfile
pnpm --dir app run build:windows
```

The local installer will be in `target/x86_64-pc-windows-msvc/release/bundle/nsis/`. A local build requires the Rust MSVC toolchain and Visual Studio C++ Build Tools with a Windows SDK. The installer contains the runtime end users need.

## Publish the first version

From the repository root, run the preparation command, add a `## 1.0.0` section with the release notes to `CHANGELOG.md`, then validate and commit.

```powershell
git switch main
node scripts/windows-release.mjs prepare 1.0.0
# Edit CHANGELOG.md before executing the following commands.
node scripts/windows-release.mjs check v1.0.0
git add README.md CHANGELOG.md Cargo.toml Cargo.lock app/package.json app/src-tauri/tauri.conf.json
git commit -m "Prepare MasterDeck v1.0.0"
git push origin main
```

After CI passes and the Actions key settings are in place, push the version tag.

```powershell
git tag -a v1.0.0 -m "MasterDeck v1.0.0"
git push origin refs/tags/v1.0.0
```

The [Windows release workflow](../.github/workflows/release.yml) verifies that the tag, app versions, README, and changelog agree. It installs dependencies from the lockfiles, builds the x64 installer, checks the updater signature, and tests the install, shortcuts, executable launch, and uninstall. A separate job with `contents: write` publishes the specific tag and all of its assets together. The tag can fail without making a release public. A release with that tag is left intact if the job is rerun. If an interrupted asset upload leaves an incomplete draft, review it and delete the draft in GitHub Releases before rerunning the failed publish job. Keep its tag.

- [Download for Windows](https://github.com/kyawzin19997/coolermaster/releases/latest/download/MasterDeck-windows-x64-setup.exe)
- [All releases](https://github.com/kyawzin19997/coolermaster/releases)

The direct link becomes available after the first successful release. Each release also includes the installer signature, `SHA256-windows.txt`, and `latest.json`. The metadata points to the installer attached to its specific tag.

## Publish future updates

Repeat the same commands with an increasing version. Use `1.0.1` for a patch or `1.1.0` for new features. The workflow only publishes stable `vMAJOR.MINOR.PATCH` tags. Keep published tags and their assets immutable so existing links and updates continue to work.

Select **Updates** in the toolbar to open the Updates page and check immediately. MasterDeck can check in the background with **Check for updates at start** enabled. The update goes ahead only when the user chooses **Install and restart**. Failed checks or downloads leave the running app in place. To exercise the full update path on a clean Windows machine, install the older EXE, open **Updates**, and choose **Install and restart**. To test offline behavior, disconnect first and use **Check for updates**.

## Windows code signing

The required Tauri signature verifies update downloads against the public key embedded in MasterDeck. It does not give Windows an Authenticode publisher identity. The current workflow does not configure Authenticode, and SmartScreen may flag the installer. To add a trusted publisher signature, configure a Windows code-signing certificate or managed signing service using Tauri's Windows bundler configuration. Authenticode signing must happen before the Tauri updater signature is made, because it changes the installer bytes. [Tauri updater documentation](https://v2.tauri.app/plugin/updater/) · [Tauri Windows signing documentation](https://v2.tauri.app/distribute/sign/windows/)
