// Capture the README screenshots from the browser demo with the sample deck and profiles.
// Run against the Vite preview or development server.
//   node scripts/ui/readme-shots.mjs [output-directory]
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const target = process.argv[2] ?? fileURLToPath(new URL("../../docs/images/", import.meta.url));
const url = process.env.MASTERDECK_URL ?? "http://localhost:1460/";
mkdirSync(target, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const open = async (query = "?demo&tests=off") => {
    await page.goto(url + query);
    await page.locator(".dk-stage").waitFor();
    await page.locator(".action-sidebar .library-item").first().waitFor();
  };
  const shot = async (name, selector = page) => {
    await page.waitForTimeout(300);
    await selector.screenshot({ path: path.join(target, `masterdeck-${name}.png`), animations: "disabled" });
  };
  const tools = async (name) => {
    await page.getByRole("button", { name: "Deck tools", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  await open("?demo&tests=off&select=keys.0");
  await page.locator(".chooser-group-head").getByText("OBS", { exact: true }).click();
  await shot("workspace");
  const settings = page.getByRole("complementary", { name: "Key settings" });
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  await settings.getByRole("button", { name: "Full editor" }).click();
  const editor = page.getByRole("region", { name: "Key editor" });
  await editor.getByText("Choose icon or image", { exact: true }).click();
  await editor.getByRole("button", { name: "Use action icon", exact: true }).click();
  await editor.getByRole("button", { name: "Upload image", exact: true }).waitFor();
  await shot("key-editor", editor);
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await tools("Screensaver");
  const saver = page.getByRole("complementary", { name: "Lights and screens", exact: true });
  await saver.getByRole("combobox", { name: "Screensaver", exact: true }).selectOption("aurora");
  await saver.locator(".saver-preview img").waitFor();
  await shot("screensaver");
  await page.locator(".stable-workspace .dk-ctl[data-kind=keys]").first().click();
  await tools("Edit layout");
  await shot("edit-layout");
  await page.locator(".layout-tool").click();
  const profileKey = page.locator(".stable-workspace .dk-ctl[data-kind=keys]").nth(12);
  await page.locator(".action-sidebar").getByRole("button", { name: "Profile Switcher", exact: true }).dragTo(profileKey);
  await page.locator('#action-name[data-action="core.profilePicker"]').waitFor();
  await profileKey.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Profile Switcher", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Profile Switcher", exact: true });
  await shot("profile-switcher", picker);
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".topbar").getByRole("button", { name: "Profiles", exact: true }).click();
  const profiles = page.getByRole("dialog", { name: "Profiles", exact: true });
  await shot("profile-library", profiles);
  const share = profiles.getByRole("button", { name: "Share OBS streaming", exact: true });
  await share.click();
  await shot("profile-share", page.getByRole("dialog", { name: "Share OBS streaming", exact: true }));
  await page.keyboard.press("Escape");
  await profiles.getByRole("button", { name: "Import", exact: true }).click();
  await shot("profile-import", page.getByRole("dialog", { name: "Import a profile", exact: true }));
  await page.goto(url + "?demo&tests=off&panel=plugins");
  await page.getByRole("main", { name: "Plugins", exact: true }).waitFor();
  await shot("installed-plugins");
  await open();
  await page.locator(".topbar").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Connections", exact: true }).click();
  await page.locator(".svc-list").waitFor();
  await shot("connections");
} finally {
  await browser.close();
}
