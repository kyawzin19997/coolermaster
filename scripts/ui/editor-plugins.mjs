import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

// Run against the browser demo; the separate native smoke validates real plugin packages.
const url = process.env.MASTERDECK_URL || "http://localhost:1460/";
const screenshots = process.argv[2];
if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const unexpected = [];
  page.on("pageerror", (error) => unexpected.push(error.message));
  const shot = (name) => screenshots && page.screenshot({ path: path.join(screenshots, name) });
  await page.goto(`${url}?demo&select=keys.0&plugin=local`);
  const settings = page.getByRole("complementary", { name: "Key settings" });
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  await settings.getByRole("button", { name: "Full editor" }).click();
  const editor = page.getByRole("region", { name: "Key editor" });
  const label = editor.getByRole("textbox", { name: "Label", exact: true });
  await label.waitFor();
  assert.equal(await editor.locator(".designer, .icon-picker").count(), 0);
  await editor.getByText("Choose icon or image", { exact: true }).click();
  await editor.getByRole("button", { name: "Use action icon", exact: true }).click();
  const preview = editor.getByRole("img", { name: "Preview of the key" });
  await preview.locator("path").first().waitFor();
  await editor.getByText("Choose icon or image", { exact: true }).click();
  await shot("MasterDeck-Key-Editor-Dark.png");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForTimeout(200);
  await shot("MasterDeck-Key-Editor-Light.png");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.setViewportSize({ width: 960, height: 640 });
  assert.ok(await editor.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
  await label.fill("Intro scene");
  await editor.getByText("Styles and effects", { exact: true }).click();
  await editor.locator(".designer").getByRole("tab", { name: "Background", exact: true }).click();
  await editor.getByText("Position on the key", { exact: true }).click();
  await preview.press("ArrowRight");
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  const look = await page.evaluate(async () => {
    const call = window.__TAURI_INTERNALS__.invoke;
    const { active } = await call("engine_state");
    return (await call("profile_get", { id: active })).controls["keys.0"].look;
  });
  assert.equal(look.label, "Intro scene");
  assert.match(look.icon, /^action:/);
  assert.equal(look.iconDx, 1);
  await page.setViewportSize({ width: 1200, height: 800 });
  console.log("Key editor saved the label, default action glyph and positioning together.");

  await page.locator(".topbar").getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("button", { name: "Install plugin", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review plugin" });
  await review.getByText("Studio Tools", { exact: true }).waitFor();
  await shot("MasterDeck-Plugin-Review.png");
  await review.getByRole("button", { name: "Install", exact: true }).click();
  await review.getByText("Installed and disabled.", { exact: false }).waitFor();
  await review.getByRole("button", { name: "Installed plugins", exact: true }).click();
  const row = page.locator(".installed-plugin").filter({ hasText: "Studio Tools" });
  await row.getByText("Manual install", { exact: false }).waitFor();
  await row.getByText("Disabled", { exact: true }).waitFor();
  await shot("MasterDeck-Installed-Plugins.png");
  await row.getByRole("button", { name: "Enable", exact: true }).click();
  await row.getByRole("button", { name: "Show actions", exact: true }).click();
  const library = page.getByRole("complementary", { name: "Action Library" });
  await library.getByRole("button", { name: "Studio switch", exact: true }).waitFor();
  await page.locator(".topbar").getByRole("button", { name: "Plugins", exact: true }).click();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  await row.getByRole("button", { name: "Enable", exact: true }).waitFor();
  await row.getByRole("button", { name: "Update from file", exact: true }).click();
  await review.getByRole("button", { name: "Install update", exact: true }).click();
  await review.getByRole("button", { name: "Enable", exact: true }).click();
  await review.getByRole("button", { name: "Installed plugins", exact: true }).click();
  await row.getByText(/1\.1\.0/).waitFor();
  await row.getByRole("button", { name: "Uninstall", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Uninstall", exact: true }).click();
  await row.waitFor({ state: "hidden" });
  assert.deepEqual(unexpected, []);
  console.log("Plugin review, manual origin, enable, use, disable, update and removal passed.");

  await page.goto(`${url}?demo&plugin=invalid`);
  await page.locator(".topbar").getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("button", { name: "Install plugin", exact: true }).click();
  await review.getByRole("alert").getByText(/no \.sdPlugin folder/).waitFor();
  assert.equal(await review.getByRole("button", { name: "Install", exact: true }).count(), 0);
  console.log("Invalid archives display an error and cannot be installed.");
} finally {
  await browser.close();
}
