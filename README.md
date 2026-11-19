# MasterDeck

Desktop control software for the Cooler Master MasterHUB. MasterDeck supports LCD keys, the dial, knobs, faders, rollers, and the base lighting. Profiles and device settings are stored locally.

[Download for Windows](https://github.com/kyawzin19997/coolermaster/releases/latest/download/MasterDeck-windows-x64-setup.exe) · [Download for macOS](https://github.com/kyawzin19997/coolermaster/releases/download/v1.1.0/MasterDeck-macOS-Universal.dmg) · [Releases and checksums](https://github.com/kyawzin19997/coolermaster/releases)

## Install

On Windows, run the x64 setup and open MasterDeck from Start. Setup includes an offline WebView2 installer and offers a desktop shortcut. On macOS, open the universal DMG and drag MasterDeck into Applications. The Mac app uses an ad hoc signature and may require approval in **System Settings → Privacy & Security**. On macOS, allow Accessibility if you use hotkeys or typing.

Quit the official MasterHUB app before connecting the deck. Only one application can drive the hardware at a time.

## Use the deck editor

- Drag an action from **Actions** directly onto a key to assign **Press**. Select a key to drop an action on **Hold** or **Double press** and edit the selected trigger's settings.
- Select a key to open **Key settings** beside the deck. Use **Appearance** to change the key’s face. Profiles, pages, and local import/export are available from the profile controls.
- Select **Updates** in the toolbar to check for the latest Windows release. MasterDeck installs an update when you choose **Install and restart**.
- Open **Lighting** for base brightness, profile edge color, music sync, and scenes. Advanced effects, presets, screen brightness, and the screensaver remain available there.
- Configure OBS, Spotify, Twitch, Streamlabs, Home Assistant, and other integrations under **Settings → Connections**. Local diagnostic export is in **Settings → Diagnostics**.

## Work on the source

The React/Vite interface lives in `app/src`, the Tauri/Rust desktop app in `app/src-tauri`, and the MasterHUB protocol and transport in `crates`. Install Node.js, pnpm, Rust, and the Tauri prerequisites for your system.

```powershell
pnpm --dir app install --frozen-lockfile
pnpm --dir app test
pnpm --dir app build
cargo test --locked --workspace
pnpm --dir app tauri dev
```

For a browser-only simulator, run `pnpm --dir app dev` and open `http://localhost:1460/?demo`. The simulator uses fixture data and does not access hardware. [Windows release guide](docs/windows-release.md) · [GitHub beginner guide](docs/github-for-beginners.md) · [Architecture](ARCHITECTURE.md)

## Attribution

MasterDeck is based on HubDeck by Przemysław Tarkowski. See [NOTICE](NOTICE.md), [MIT](LICENSE-MIT), and [Apache 2.0](LICENSE-APACHE). MasterDeck is independent of Cooler Master. Cooler Master and MasterHUB are used to identify compatible hardware.
