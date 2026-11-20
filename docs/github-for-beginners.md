# MasterDeck on GitHub

Your project lives in [kyawzin19997/coolermaster](https://github.com/kyawzin19997/coolermaster). Git keeps the history of your files. GitHub stores that history online and builds and hosts the Windows installer. Codex can edit and test the app in the checkout on your computer.

## The pages you will use

| Page | What to look for |
| --- | --- |
| [Code](https://github.com/kyawzin19997/coolermaster) | The files and README for the `main` branch. |
| [Actions](https://github.com/kyawzin19997/coolermaster/actions) | Builds and tests. Open a run, then open the failed step to read its log. |
| [Releases](https://github.com/kyawzin19997/coolermaster/releases) | Published versions, release notes, and downloads. |
| [Download for Windows](https://github.com/kyawzin19997/coolermaster/releases/latest/download/MasterDeck-windows-x64-setup.exe) | The latest Windows installer. This is the link to share with users. |
| [Download for macOS](https://github.com/kyawzin19997/coolermaster/releases/download/v1.2.2/MasterDeck-macOS-Universal.dmg) | The universal disk image for MasterDeck 1.2.2. |

A **commit** saves a group of changes in Git. A **push** sends commits to GitHub. The **main** branch is your normal line of work. A **tag** such as `v1.0.1` names the exact commit GitHub should build and publish. You only need a tag when you want a public installer.

## Open the project on another computer

Install Git, Node.js, and pnpm, then open PowerShell in your projects folder. If you already have the project open in Codex, use that same folder.

```powershell
git clone https://github.com/kyawzin19997/coolermaster.git
Set-Location coolermaster
pnpm --dir app install --frozen-lockfile
```

Open the `coolermaster` folder in Codex and describe the change you want. Ask Codex to test it and show you the changed files. For desktop builds on Windows, see the prerequisites in the Windows release guide, included as `docs/windows-release.md` in the source.

## Save changes without releasing them

Run these commands after you have reviewed the changes. `git status` shows what Codex edited. Add the files you intend to send.

```powershell
git status
git diff
# Replace README.md with the file you edited.
git add -- README.md
git commit -m "Describe what changed"
git push origin main
```

Git may open GitHub in your browser the first time you push. Sign in to your own account and approve the prompt. Keep passwords and access tokens out of chat and out of Git.

## Publish the next Windows installer

For a bug fix after `1.2.1`, use `1.2.2`. For new features, use `1.3.0`. Start on `main` and run the preparation command. Add a matching `## 1.2.2` heading and a short summary of what users will notice to `CHANGELOG.md`.

```powershell
git switch main
node scripts/windows-release.mjs prepare 1.2.2
# Add the 1.2.2 release notes in CHANGELOG.md.
node scripts/windows-release.mjs check v1.2.2
git add README.md CHANGELOG.md Cargo.toml Cargo.lock app/package.json app/src-tauri/tauri.conf.json
git commit -m "Prepare MasterDeck v1.2.2"
git push origin main
```

Wait for the **CI** run for that commit to pass under Actions. Then tag the same commit and push the tag.

```powershell
git tag -a v1.2.2 -m "MasterDeck v1.2.2"
git push origin refs/tags/v1.2.2
```

Watch **Windows release** in Actions. When it passes, open **Releases** and download `MasterDeck-windows-x64-setup.exe`. The existing Download for Windows link will serve the latest release automatically. Users already running a GitHub Windows build can select **Updates** in the toolbar, then choose **Install and restart** if MasterDeck finds a new release.

## Add a Mac download to a release

1. Open **Actions → Desktop installers → Run workflow**. Select `macos` under **Installer to build** and enter the published tag, such as `v1.2.2`, under **Git branch or tag to package**.
2. After the build passes, open the run and download **MasterDeck-macOS-Universal** under **Artifacts**. Extract the ZIP. Keep the `.dmg` filename and rename `SHA256.txt` to `SHA256-macos.txt`.
3. Open the same version under **Releases**, choose **Edit**, attach the disk image and its checksum, then save. Update the macOS download links in the README to point to that version's disk image.

## If a release fails

Open the failed run under **Actions** and copy the relevant error from the failed step. You can give that error to Codex. If a runner had a temporary failure, use **Re-run failed jobs**. If the source needs a fix, make a normal commit and prepare a new version. Keep published tags and their installers in place so users can still download the version they installed.

The updater uses a signing key to verify downloads. Keep the original signing key and its password for future updates. There is no need to regenerate them for each release. The Windows release guide explains the three GitHub Actions settings and the separate Windows Authenticode certificate option.
