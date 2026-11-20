# Contributing to MasterDeck

MasterDeck is a desktop controller for the Cooler Master MasterHUB. Contributions should make deck editing easier and preserve existing profiles, bindings, and device behavior.

## Report a problem

Include the MasterDeck version, operating system, and the action or hardware module involved. Describe the steps you took, what you expected, and what happened. For a layout issue, include the module type and slot shown under **Deck tools → Edit layout**. If you attach a diagnostic export from **Settings → Diagnostics**, review it before sharing. [Open a regular issue](https://github.com/kyawzin19997/coolermaster/issues/new) · [Report a vulnerability privately](SECURITY.md)

## Build and test

Install Node.js and pnpm, Rust, and the platform prerequisites for Tauri. Run these commands from the repository root.

```powershell
pnpm --dir app install --frozen-lockfile
pnpm --dir app build
pnpm --dir app test
cargo fmt --all --check
cargo clippy --locked -p masterdeck --all-targets -- -D warnings
cargo test --locked --workspace
pnpm --dir app tauri dev
```

For interface work without a MasterHUB, run `pnpm --dir app dev` and open `http://localhost:1460/?demo`. For hardware changes, include the modules and platform you tested.

## Submit a change

- Keep the pull request focused. Explain what users will notice and how you verified it. Include a screenshot for visible interface changes.
- Put interface strings in `app/src/i18n.ts`. Check keyboard navigation and both themes when editing a shared component.
- Keep HID I/O on device threads. Follow the protocol’s command restrictions and hardware-mode rules. [Device protocol](PROTOCOL.md)
- Keep local profiles, credentials, diagnostics, and assets without redistribution permission out of the checkout.

Changes to the project code use the existing MIT or Apache 2.0 terms. [License and credits](LICENSE.md)
