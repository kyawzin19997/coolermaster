# HubDeck desktop app

The window uses React and TypeScript. Tauri connects it to the native MasterHUB engine.

## Run and test the editor

From this directory, using Node.js 24 and pnpm 10:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [the browser demo](http://localhost:1460/?demo) to try the editor with sample hardware and profiles. Select a key to open its **Action** and **Appearance** settings under the Action Library. The library keeps its search and open groups as you drop actions. Press Ctrl+K (Command+K on macOS) to focus search, or drag the divider above the properties pane to resize it.

Open **Deck tools** for the Deck Builder, spare modules, layout, and lighting. **Profiles** opens profile management and the guided setup tools.

Use `pnpm test` for frontend tests and `pnpm build` for a production frontend build. Run `pnpm tauri dev` to develop against a connected MasterHUB once the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) are installed.

## Build native installers

On a Windows x64 build host with MSVC and the Windows SDK, run from this directory:

```powershell
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = '-C target-feature=+crt-static'
pnpm exec tauri build --target x86_64-pc-windows-msvc --bundles nsis --config src-tauri/tauri.installers.conf.json -- --locked
```

On a Mac with Xcode command-line tools, run from this directory:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm exec tauri build --target universal-apple-darwin --bundles dmg --config src-tauri/tauri.installers.conf.json -- --locked
```

Find the Windows setup executable under `target/x86_64-pc-windows-msvc/release/bundle/nsis` and the macOS disk image under `target/universal-apple-darwin/release/bundle/dmg`, relative to the repository root. The Windows installer embeds the WebView2 offline runtime and adds a Start menu entry with a desktop shortcut option. The macOS disk image installs HubDeck by dragging it to Applications. Both packages use the same frontend and Rust workspace.

The **Desktop installers** workflow builds both packages as GitHub Actions artifacts. Run it from the repository's Actions tab. The manual build uses the existing ad-hoc macOS signing configuration and produces an unsigned Windows installer, so operating-system publisher checks may appear. Public distribution can use your own signing identities and notarization.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
