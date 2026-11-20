# MasterDeck

MasterDeck is a desktop editor for the Cooler Master MasterHUB. Build a workspace around the keys, dial, knobs, faders, and rollers you have. Assign actions, set up profiles for different apps, and see your changes on the deck preview as you work.

[**Download for Windows (.exe)**](https://github.com/kyawzin19997/coolermaster/releases/latest/download/MasterDeck-windows-x64-setup.exe) · [Download for macOS (.dmg)](https://github.com/kyawzin19997/coolermaster/releases/download/v1.3.3/MasterDeck-macOS-Universal.dmg) · [All releases](https://github.com/kyawzin19997/coolermaster/releases)

![MasterDeck desktop app showing the MasterHUB preview, Key Settings, and the Actions list](docs/images/masterdeck-workspace.png)

## Install and connect

- **Windows 10 or 11, x64.** Run the setup file and open MasterDeck from Start. Setup includes the offline WebView2 runtime and can create a desktop shortcut. Use **Updates** in the toolbar to check for a newer Windows release.
- **macOS 12 or newer.** Open the universal DMG and drag MasterDeck into Applications. macOS may ask for first-launch approval in **System Settings → Privacy & Security**. Allow Accessibility if you use actions that type or send shortcuts.

Quit the official MasterHUB app before connecting the hardware. One application controls the deck at a time.

## Set up your deck

1. Open **Deck tools → Getting Started** for guided lessons beside the live deck. **Your Deck, Your Modules** explains what each kind of control can do and opens the layout editor.
2. Open **Profiles** to choose a starter layout or create your own. Click **+** by the page tabs to add a page. Drag **Switch profile** from the Actions panel to a key to jump between profiles.
3. Drag an action onto a key. Dropping a different action replaces the key’s icon and keeps its colors and styling. To assign another gesture, select the key and drag onto **Hold** or **Double press** in **Key Settings**. Open **Appearance** to change the key’s face.
4. To reuse a key, right-click and choose **Copy key**, then **Paste key** on the destination. You can also use Ctrl+C and Ctrl+V on Windows, or Cmd+C and Cmd+V on macOS.
5. Open **Deck tools → Lights and screens** beside the deck preview. Use **Settings → Connections** for OBS Studio, Spotify, Twitch, Streamlabs, and Home Assistant.

**Everyday desk** covers media, editing, mic mute, and a focus timer. **My deck · faders** adds app launchers, a Fun page, and a clock you can double press to switch profiles. **Discord & meetings** groups call shortcuts by app and puts system mic mute on the Music key’s Hold gesture. **OBS streaming** provides scene keys, recording and streaming controls, and Studio Mode and Transition keys. Existing saved profiles keep their assignments.

## Set a screensaver

Open **Deck tools → Screensaver**. Pick a built-in scene, use a deck look, or choose **Add screensaver** to import a GIF, WebP, PNG, or JPEG up to 15 MB. The animation plays in the tab as you browse. Set the idle delay and choose **Apply screensaver** to save your choice. **Preview on the deck** is available if you want to see it across the keys. **Advanced settings** lets you use a different screensaver for each profile and choose what the dial and lights do while it runs. MasterDeck keeps imported media on this computer. When moving a profile to another computer, add the image there and select it again.

## Connect OBS Studio

Open OBS Studio on the same computer. MasterDeck finds the local OBS connection and reconnects when OBS restarts. You can check the connection under **Settings → Connections → OBS Studio**. If MasterDeck shows **Setup needed**, close OBS Studio, choose **Enable connection** in MasterDeck, and reopen OBS. For OBS on another computer or a custom installation, expand **Manual connection**.

In OBS Studio Mode, select a scene key and choose **Preview** to cue a scene or **Program** to switch the live output. The target appears on the deck preview. A key set to Preview requires Studio Mode, so it cannot accidentally switch the live output outside Studio Mode.

## Use a profile on another deck

Open **Profile Settings → Use on another deck → Export**, or export straight from a profile’s three-dot menu. Copy the `.masterdeck` file to the other computer. There, open **Profiles → Import** and pick the file. The package carries actions, pages, and included key pictures. Review plugin requirements, linked apps, credentials, and file paths on the destination. [Profile transfer guide](docs/profile-transfer.md)

## Plugins and phone uploads

Open **Plugins → Install Plugin** to review a compatible plugin package before installing it. Enable it from the installed list to make its actions available. **Upload from Phone** pairs a phone browser using a QR code and desktop approval. You can send profiles, plugins, and images over your local Wi-Fi. [Phone upload guide](docs/phone-uploads.md)

## Work on MasterDeck

The desktop app uses Tauri and Rust, with a React interface. The [contributing guide](CONTRIBUTING.md) covers setup and tests. See the [architecture](ARCHITECTURE.md), [GitHub beginner guide](docs/github-for-beginners.md), and [Windows release guide](docs/windows-release.md) for development and releases.

MasterDeck is independent of Cooler Master and builds on HubDeck by Przemysław Tarkowski. The code is available under the [MIT License](LICENSE) or [Apache License 2.0](LICENSE-APACHE). [License and credits](docs/licensing.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md)
