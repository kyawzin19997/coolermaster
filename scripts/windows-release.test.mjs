import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { githubRepository, releaseNotes, releaseVersion, verifyInstaller } from "./windows-release.mjs";

test("uses the same GitHub repository with HTTPS, SSH and Actions", () => {
  for (const remote of [
    "https://github.com/DeckCreator/my-deck.git",
    "git@github.com:DeckCreator/my-deck.git",
    "ssh://git@github.com/DeckCreator/my-deck.git",
    "DeckCreator/my-deck",
  ]) {
    assert.equal(githubRepository(remote), "DeckCreator/my-deck");
  }
  assert.throws(() => githubRepository("https://github.com.example.org/owner/repo"), /github.com repository/);
  assert.throws(() => githubRepository("owner/repo/releases"), /github.com repository/);
});

test("accepts stable installer versions that fit Windows version fields", () => {
  assert.equal(releaseVersion("v1.0.0"), "1.0.0");
  for (const invalid of ["1.0.0", "v01.0.0", "v1.0.0-rc.1", "v1.0.0.1", "v65536.0.0"]) {
    assert.throws(() => releaseVersion(invalid), /stable tag/);
  }
});

test("takes Markdown notes for precisely the tagged version", () => {
  const changelog = "# Changelog\r\n\r\n## 1.10.0\r\n\r\nNew.\r\n\r\n## 1.1.0\r\n\r\n- Fix A\r\n\r\n## 1.0.0\r\n";
  assert.equal(releaseNotes(changelog, "1.1.0"), "- Fix A");
  assert.throws(() => releaseNotes(changelog, "1.0.0"), /Add release notes/);
  assert.throws(() => releaseNotes(changelog, "1.2.0"), /Add release notes/);
});

test("accepts a matching Minisign installer and rejects changed payloads, keys and comments", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "hubdeck-release-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "MasterDeck-setup.exe");
  const bytes = Buffer.from("MZ example installer");
  const keys = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("12345678");
  const trusted = "timestamp:0\tfile:MasterDeck-setup.exe";
  const publicKey = (key) => {
    const packet = Buffer.concat([Buffer.from("Ed"), keyId, Buffer.from(key.export({ format: "jwk" }).x, "base64url")]);
    return Buffer.from(`untrusted comment: test\n${packet.toString("base64")}\n`).toString("base64");
  };
  const payload = sign(null, createHash("blake2b512").update(bytes).digest(), keys.privateKey);
  const global = sign(null, Buffer.concat([payload, Buffer.from(trusted)]), keys.privateKey);
  const packet = Buffer.concat([Buffer.from("ED"), keyId, payload]).toString("base64");
  const signature = (comment) => Buffer.from(`untrusted comment: test\n${packet}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64");
  await writeFile(file, bytes);
  assert.equal(await verifyInstaller(file, signature(trusted), publicKey(keys.publicKey)), createHash("sha256").update(bytes).digest("hex"));
  const otherKey = generateKeyPairSync("ed25519").publicKey;
  await assert.rejects(verifyInstaller(file, signature(trusted), publicKey(otherKey)), /signature verification/);
  await assert.rejects(verifyInstaller(file, signature("changed comment"), publicKey(keys.publicKey)), /signature verification/);
  await writeFile(file, "MZ changed installer");
  await assert.rejects(verifyInstaller(file, signature(trusted), publicKey(keys.publicKey)), /signature verification/);
});
