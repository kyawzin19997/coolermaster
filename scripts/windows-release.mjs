import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const installer = "MasterDeck-windows-x64-setup.exe";
const shaFile = "SHA256-windows.txt";
const versionPattern = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)";
const workspacePackages = ["hubdeck", "mh-device", "mh-protocol"];
const read = (file) => readFile(resolve(root, file), "utf8");
const write = (file, content) => writeFile(resolve(root, file), content);
const json = (value) => JSON.stringify(value, null, 2) + "\n";

export function githubRepository(value) {
  const ssh = /^git@github\.com:(.+)$/i.exec(value ?? "");
  let path = ssh?.[1];
  if (!path) {
    try {
      const url = new URL(value);
      if (url.host.toLowerCase() === "github.com" && ["https:", "ssh:"].includes(url.protocol) && !url.search && !url.hash) {
        path = url.pathname.slice(1);
      }
    } catch {
      path = value;
    }
  }
  const repo = path?.replace(/\/$/, "").replace(/\.git$/i, "");
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[\w.-]{1,100}$/i.test(repo ?? "") || /\/\.{1,2}$/.test(repo)) {
    throw new Error("Expected a github.com repository (OWNER/REPOSITORY). Set the Git origin to your GitHub repository.");
  }
  return repo;
}

function originRepository() {
  let remote;
  try {
    remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error("No Git origin found. Add your GitHub repository as origin first.");
  }
  return githubRepository(remote);
}

export function releaseVersion(tag) {
  const match = new RegExp(`^v${versionPattern}$`).exec(tag ?? "");
  if (!match || match.slice(1).some((part) => Number(part) > 65535)) {
    throw new Error("Use a stable tag vMAJOR.MINOR.PATCH, with each component between 0 and 65535.");
  }
  return tag.slice(1);
}

function releaseUrls(repo, tag) {
  const base = `https://github.com/${repo}/releases`;
  const latest = `${base}/latest/download`;
  return { all: base, download: `${latest}/${installer}`, feed: `${latest}/latest.json`, asset: `${base}/download/${tag}/${installer}` };
}

async function configureReadme(repo) {
  const urls = releaseUrls(repo);
  const readme = await read("README.md");
  const updated = readme
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/latest\/download\/MasterDeck-windows-x64-setup\.exe/g, urls.download)
    .replace(/(\[All releases\]\()https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\)/g, `$1${urls.all})`)
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/latest(?="><img alt="Latest release")/g, `${urls.all}/latest`)
    .replace(/(img\.shields\.io\/github\/v\/release\/)[^/?\s]+\/[^/?\s]+(?=\?)/g, `$1${repo}`)
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?=\/actions\/workflows\/ci\.yml)/g, `https://github.com/${repo}`)
    .replace(/(img\.shields\.io\/github\/actions\/workflow\/status\/)[^/?\s]+\/[^/?\s]+(?=\/ci\.yml)/g, `$1${repo}`);
  await write("README.md", updated);
  console.log(`Windows download: ${urls.download}`);
}

async function updateVersions(version) {
  const files = ["app/package.json", "app/src-tauri/tauri.conf.json", "Cargo.toml", "Cargo.lock"];
  const [pkg, config, cargo, lock] = await Promise.all(files.map(read));
  const jsConfig = JSON.parse(pkg);
  jsConfig.version = version;
  const versionEntry = (_entry, prefix) => prefix + version;
  const tauri = config.replace(/("version": ")[^"]+/, versionEntry);
  const workspace = cargo.replace(/(\[workspace\.package\]\r?\nversion = ")[^"]+/, versionEntry);
  const lockVersions = lock.replace(/(name = "(?:hubdeck|mh-device|mh-protocol)"\r?\nversion = ")[^"]+/g, versionEntry);
  const contents = [json(jsConfig), tauri, workspace, lockVersions];
  assertVersions(contents, version);
  await Promise.all(files.map((file, index) => write(file, contents[index])));
}

function assertVersions([pkg, config, cargo, lock], version) {
  const entries = [
    ["app/package.json", JSON.parse(pkg).version],
    ["app/src-tauri/tauri.conf.json", JSON.parse(config).version],
    ["Cargo.toml", /\[workspace\.package\]\s+version = "([^"]+)"/.exec(cargo)?.[1]],
    ...workspacePackages.map((name) => [
      `Cargo.lock (${name})`,
      new RegExp(`name = "${name}"\\s+version = "([^"]+)"`).exec(lock)?.[1],
    ]),
  ];
  for (const [file, actual] of entries) {
    if (actual !== version) throw new Error(`${file} must have version ${version}; found ${actual ?? "none"}. Run release:prepare first.`);
  }
}

export function releaseNotes(changelog, version) {
  const sections = changelog.split(/^## /m).slice(1);
  const section = sections.find((part) => part.split(/\r?\n/, 1)[0].trim().split(/\s/)[0] === version);
  const notes = section?.slice(section.indexOf("\n") + 1).trim();
  if (!section?.includes("\n") || !notes) throw new Error(`Add release notes under "## ${version}" in CHANGELOG.md.`);
  return notes;
}

async function check(tag, repo) {
  const version = releaseVersion(tag);
  assertVersions(await Promise.all(["app/package.json", "app/src-tauri/tauri.conf.json", "Cargo.toml", "Cargo.lock"].map(read)), version);
  const notes = releaseNotes(await read("CHANGELOG.md"), version);
  if (!(await read("README.md")).includes(releaseUrls(repo).download)) {
    throw new Error("README Windows download points to another repository. Run release:configure with the correct Git origin before tagging.");
  }
  return notes;
}

function decodeTauriPublicKey(value) {
  const encoded = value?.trim();
  const [comment, key] = Buffer.from(encoded ?? "", "base64").toString().split(/\r?\n/);
  const packet = Buffer.from(key ?? "", "base64");
  if (!comment.startsWith("untrusted comment: ") || packet.length !== 42 || packet.subarray(0, 2).toString() !== "Ed") {
    throw new Error("Set TAURI_UPDATER_PUBLIC_KEY to the contents of the Tauri signer's .pub file.");
  }
  return { encoded, packet };
}

async function configureUpdater(repo, file) {
  const { encoded } = decodeTauriPublicKey(process.env.TAURI_UPDATER_PUBLIC_KEY);
  await write(file, json({
    plugins: { updater: { pubkey: encoded, endpoints: [releaseUrls(repo).feed] } },
  }));
}

export async function verifyInstaller(file, signature, publicKey) {
  const { packet } = decodeTauriPublicKey(publicKey);
  const [, encoded, comment, global] = Buffer.from(signature, "base64").toString().split(/\r?\n/);
  const signed = Buffer.from(encoded ?? "", "base64");
  const globalSignature = Buffer.from(global ?? "", "base64");
  const prefix = "trusted comment: ";
  if (signed.length !== 74 || signed.subarray(0, 2).toString() !== "ED" || !signed.subarray(2, 10).equals(packet.subarray(2, 10)) ||
      !comment?.startsWith(prefix) || globalSignature.length !== 64) {
    throw new Error("Installer signature is invalid or was made with a different updater key.");
  }
  const header = await open(file);
  try {
    const magic = Buffer.alloc(2);
    await header.read(magic, 0, 2, 0);
    if (magic.toString() !== "MZ") throw new Error("Expected a Windows installer executable.");
  } finally {
    await header.close();
  }
  // Minisign's current format signs a BLAKE2b-512 digest and separately signs the trusted comment.
  const publicObject = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: packet.subarray(10).toString("base64url") }, format: "jwk" });
  const payloadSignature = signed.subarray(10);
  const payload = createHash("blake2b512");
  const checksum = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    payload.update(chunk);
    checksum.update(chunk);
  }
  const trusted = Buffer.concat([payloadSignature, Buffer.from(comment.slice(prefix.length))]);
  if (!verify(null, payload.digest(), publicObject, payloadSignature) || !verify(null, trusted, publicObject, globalSignature)) {
    throw new Error("The Windows installer failed updater signature verification.");
  }
  return checksum.digest("hex");
}

async function stage(tag, repo, bundleFolder, stagingFolder) {
  const notes = await check(tag, repo);
  const names = (await readdir(bundleFolder)).filter((name) => name.endsWith("-setup.exe"));
  if (names.length !== 1) throw new Error("Expected exactly one NSIS installer in the build output.");
  const source = resolve(bundleFolder, names[0]);
  const signature = (await readFile(`${source}.sig`, "utf8")).trim();
  const checksum = await verifyInstaller(source, signature, process.env.TAURI_UPDATER_PUBLIC_KEY);
  await mkdir(stagingFolder, { recursive: true });
  await Promise.all([
    copyFile(source, resolve(stagingFolder, installer)),
    writeFile(resolve(stagingFolder, `${installer}.sig`), `${signature}\n`),
    writeFile(resolve(stagingFolder, shaFile), `${checksum}  ${installer}\n`),
    writeFile(resolve(stagingFolder, "notes.md"), `${notes}\n`),
    writeFile(resolve(stagingFolder, "latest.json"), json({
      version: releaseVersion(tag),
      notes,
      platforms: { "windows-x86_64": { signature, url: releaseUrls(repo, tag).asset } },
    })),
  ]);
  console.log(`Verified ${installer} (SHA-256 ${checksum}) and staged GitHub release assets.`);
}

async function main([command, arg, second]) {
  switch (command) {
    case "configure":
      await configureReadme(originRepository());
      break;
    case "prepare": {
      const version = releaseVersion(arg?.startsWith("v") ? arg : `v${arg}`);
      const repo = originRepository();
      await updateVersions(version);
      await configureReadme(repo);
      console.log(`Prepared ${version}. Add its changelog entry, run release:check v${version}, then commit and tag.`);
      break;
    }
    case "check":
      await check(arg ?? process.env.GITHUB_REF_NAME, githubRepository(process.env.GITHUB_REPOSITORY ?? originRepository()));
      console.log("Release tag, application versions, changelog and download URL agree.");
      break;
    case "updater-config":
      if (!arg) throw new Error("Provide an output path for the Tauri updater configuration.");
      await configureUpdater(githubRepository(process.env.GITHUB_REPOSITORY), arg);
      break;
    case "stage":
      if (!arg || !second) throw new Error("Provide the NSIS build folder and the release staging folder.");
      await stage(process.env.GITHUB_REF_NAME, githubRepository(process.env.GITHUB_REPOSITORY), arg, second);
      break;
    default:
      throw new Error("Use configure, prepare, check, updater-config or stage.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Windows release: ${error.message}`);
    process.exitCode = 1;
  });
}
