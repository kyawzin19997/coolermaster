// Walk the window as a user would and check that each click shows what it should: a fresh install's
// tour from its desk check (Fix it goes and comes back, Yes, Skip), a key's editor, Settings and the profile dialog.
// panels never stay over the editor. Runs on any system against the browser demo (`pnpm dev` in
// app/, the vite server on :1460), headless, no focus taken.
//
//   node scripts/ui/flows.mjs [out-dir]        # screenshots of every step land in out-dir
//   CHROMIUM=/path/to/chrome node scripts/ui/flows.mjs   # a browser of your own
//
// Exit code 1 when a step fails. (Owner, 2026-10-13: "testowałeś różne flow klikania?")
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = process.argv[2] || path.join(os.tmpdir(), 'hubdeck-flows');
fs.mkdirSync(out, { recursive: true });
const base = process.env.MASTERDECK_URL || 'http://localhost:1460/';
const actionIcons = JSON.parse(fs.readFileSync(new URL('../../app/src/action-icons.json', import.meta.url), 'utf8'));

/** A browser Playwright downloaded before, when none is given. */
function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright') : path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  for (const dir of fs.readdirSync(cache).filter((d) => d.startsWith('chromium')).sort().reverse()) {
    const stack = [path.join(cache, dir)];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && !p.includes('.app/Contents/Frameworks')) stack.push(p);
        else if (/^(chrome-headless-shell|chrome|Chromium|headless_shell)(\.exe)?$/.test(e.name)) return p;
      }
    }
  }
  return undefined;
}

const browser = await chromium.launch({ executablePath: findChromium() });
const results = [];
let n = 0;

async function step(page, name, check) {
  n += 1;
  let ok = false;
  let note = '';
  try {
    const r = await check();
    // true passes; false or a string (what went wrong) fails
    ok = r === true;
    if (typeof r === 'string') note = r;
  } catch (e) {
    note = String(e.message || e).split('\n')[0];
  }
  const errs = page.hubdeckErrors?.splice(0) ?? [];
  if (errs.length) {
    ok = false;
    note = `${note ? `${note}; ` : ''}script error: ${errs[0]}`;
  }
  const shot = path.join(out, `${String(n).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  results.push({ step: n, name, ok, note });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}. ${name}${note ? ` (${note})` : ''}`);
}

const visible = (page, sel) => page.locator(sel).first().isVisible();

for (const [label, viewport] of [['wide', { width: 1440, height: 900 }], ['half', { width: 960, height: 760 }]]) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5000);
  // a script error in the window is a failure of the step it happens in
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).split('\n')[0]));
  page.hubdeckErrors = errors;
  const profiles = page.getByRole('dialog', { name: 'Profiles', exact: true });
  const profileTab = async (name) => {
    if (!(await profiles.isVisible())) await page.getByRole('button', { name: 'Profiles', exact: true }).click();
    await profiles.getByRole('tab', { name, exact: true }).click();
  };
  const closeProfiles = () => profiles.getByRole('button', { name: 'Close', exact: true }).click();

  await page.goto(`${base}?demo=welcome`);
  await page.waitForSelector('.workspace-guide .workspace-pane-head', { timeout: 15000 });
  const deckStage = page.locator('.stable-workspace .dk-stage');
  const actionPane = page.locator('.stable-workspace .action-sidebar');
  const settingsPicker = page.getByRole('combobox', { name: 'Settings section', exact: true });
  const deckBox = await deckStage.boundingBox();
  const actionBox = await actionPane.boundingBox();
  const layoutStays = async () => JSON.stringify(await deckStage.boundingBox()) === JSON.stringify(deckBox) &&
    JSON.stringify(await actionPane.boundingBox()) === JSON.stringify(actionBox);
  const deckMenu = async (label) => {
    await page.getByRole('button', { name: 'Deck tools', exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };
  await step(page, `${label}: Getting Started keeps the deck and Actions in place`, async () => {
    await page.locator('.workspace-guide').getByRole('button', { name: 'Next', exact: true }).click();
    return await page.getByText('Search Actions on the right', { exact: false }).isVisible() && await layoutStays();
  });
  await step(page, `${label}: the module guide explains each control without moving the deck`, async () => {
    await deckMenu('Your Deck, Your Modules');
    await page.getByRole('combobox', { name: 'Module', exact: true }).selectOption('3');
    return await page.getByText('Use faders for levels', { exact: false }).isVisible() && await layoutStays();
  });
  await step(page, `${label}: Edit layout returns to the module guide with Actions still visible`, async () => {
    await page.locator('.workspace-guide').getByRole('button', { name: 'Edit layout', exact: true }).click();
    if (!await actionPane.isVisible()) return 'Actions disappeared';
    await page.locator('.layout-tool').click();
    return await visible(page, '.workspace-guide') && await layoutStays();
  });
  await step(page, `${label}: the guide closes into the key editor`, async () => {
    await page.locator('.workspace-guide').getByRole('button', { name: 'Close', exact: true }).click();
    return !await visible(page, '.workspace-guide') && await layoutStays();
  });
  await step(page, `${label}: notification appears at the bottom and closes without layout shift`, async () => {
    await page.evaluate(() => window.demoEmit('engine://error', { control: 'OBS', message: 'Connection check message' }));
    const notice = page.locator('.notification-stack .notice').filter({ hasText: 'Connection check message' });
    await notice.waitFor();
    const before = await layoutStays();
    await notice.getByRole('button', { name: 'Dismiss notification' }).click();
    return before && !await notice.isVisible() && await layoutStays();
  });
  await step(page, `${label}: Studio Mode exposes Preview and Program for an OBS scene`, async () => {
    const scene = page.locator('.stable-workspace .dk-ctl[data-kind="keys"]').first();
    await scene.click();
    const target = page.getByRole('combobox', { name: 'Send scene to', exact: true });
    if (await target.isVisible()) return 'Studio target was visible before OBS enabled Studio Mode';
    await page.evaluate(() => window.demoObsStudio(true));
    await target.waitFor();
    if (await target.inputValue() !== 'program') return 'an existing scene key changed its default target';
    await target.selectOption('preview');
    await scene.getByText('Preview', { exact: true }).waitFor();
    await page.evaluate(() => window.demoObsStudio(false));
    return !(await target.isVisible()) && await layoutStays();
  });
  await step(page, `${label}: Switch profile is immediately available to drag`, async () => {
    const row = actionPane.getByRole('button', { name: 'Switch profile', exact: true });
    await row.dragTo(page.locator('.stable-workspace .dk-ctl[data-kind="keys"]').nth(12));
    await page.locator('#action-name[data-action="core.profile"]').waitFor();
    return await layoutStays();
  });
  await step(page, `${label}: repeat drops keep the same action library and search`, async () => {
    const library = page.locator('.action-sidebar');
    const search = library.locator('#library-search');
    const mic = library.getByRole('button', { name: 'Microphone mute', exact: true });
    const ctl = page.locator('.dk-front .dk-ctl[data-kind="keys"]');
    await search.fill('microphone');
    const original = await library.elementHandle();
    for (const index of [9, 10]) {
      await mic.dragTo(ctl.nth(index));
      await page.locator('#action-name[data-action="core.mic"]').waitFor();
      if (await ctl.nth(index).getAttribute('aria-pressed') !== 'true') return `key ${index + 1} was not selected`;
      if (await search.inputValue() !== 'microphone') return 'the action search was reset';
      if (!await library.evaluate((el, before) => el === before, original)) return 'the library remounted';
    }
    return true;
  });
  await step(page, `${label}: replacing an action replaces its custom icon on the deck`, async () => {
    const control = 'keys.11';
    await page.evaluate(async control => {
      const { invoke } = window.__TAURI_INTERNALS__;
      const { active: profile } = await invoke('engine_state');
      await invoke('binding_set', {
        profile, control,
        binding: { action: 'core.hotkey', params: { keys: 'Ctrl+A' }, look: { label: 'Shortcut', icon: 'keyboard', image: 'shortcut.png', fit: 'fill', bg: '#123345' } },
      });
    }, control);
    const key = deckStage.locator('.dk-ctl[data-kind="keys"][data-index="11"]');
    await key.getByText('Shortcut', { exact: true }).waitFor();
    await actionPane.getByRole('button', { name: 'Microphone mute', exact: true }).dragTo(key);
    await page.locator('#action-name[data-action="core.mic"]').waitFor();
    await key.locator(`.dk-screen-content path[d="${actionIcons['core.mic']}"]`).waitFor({ state: 'attached' });
    const look = await page.evaluate(async control => {
      const { invoke } = window.__TAURI_INTERNALS__;
      const { active: id } = await invoke('engine_state');
      const profile = await invoke('profile_get', { id });
      return profile.controls[control].look;
    }, control);
    return look.icon === 'action:core.mic' && look.image === undefined && look.bg === '#123345' && await layoutStays();
  });
  await step(page, `${label}: a key click opens its editor`, async () => {
    await page.locator('.dk-ctl').first().click();
    await page.waitForTimeout(300);
    return visible(page, '.control-inspector .trigger-slot');
  });
  await step(page, `${label}: Settings opens beside the same deck and Actions`, async () => {
    await page.getByRole('button', { name: /^Settings$/ }).first().click();
    await page.waitForTimeout(300);
    return (await visible(page, '.settings-page')) && await layoutStays();
  });
  await step(page, `${label}: Settings sections switch`, async () => {
    for (const section of ['connections', 'plugins', 'backups', 'updates', 'diagnostics', 'general']) {
      await settingsPicker.selectOption(section);
      if (await settingsPicker.inputValue() !== section || !await layoutStays()) return `section ${section} moved the deck or did not open`;
    }
    return true;
  });
  await step(page, `${label}: OBS defaults to automatic local connection`, async () => {
    await settingsPicker.selectOption('connections');
    const obs = page.locator('.svc', { has: page.locator('summary .svc-name', { hasText: /^OBS Studio$/ }) });
    await obs.locator(':scope > summary').click();
    const auto = await obs.getByText('Automatic on this computer', { exact: true }).isVisible();
    const address = obs.getByLabel('OBS WebSocket address');
    if (!auto || await address.isVisible()) return 'expected automatic mode and hidden manual fields';
    await obs.getByText('Manual connection', { exact: true }).click();
    return address.isVisible();
  });
  await step(page, `${label}: Back to the deck`, async () => {
    await page.getByRole('button', { name: /Back to the deck/ }).click();
    await page.waitForTimeout(300);
    return (await visible(page, '.dk-ctl')) && !(await visible(page, '.settings-page'));
  });
  await step(page, `${label}: Lights and screens open beside the deck from Deck tools`, async () => {
    await page.getByRole('button', { name: 'Deck tools', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Lights and screens', exact: true }).click();
    const display = page.getByRole('complementary', { name: 'Lights and screens', exact: true });
    await display.locator('#lights-brightness').waitFor();
    const deck = await page.locator('.deck-area').boundingBox();
    const panel = await display.boundingBox();
    await display.getByRole('button', { name: 'Screens', exact: true }).click();
    await display.locator('#screen-brightness').waitFor();
    return !!deck && !!panel && deck.x + deck.width <= panel.x + 1;
  });
  await step(page, `${label}: Screensavers preview in the tab before applying`, async () => {
    await page.getByRole('button', { name: 'Deck tools', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Screensaver', exact: true }).click();
    const display = page.getByRole('complementary', { name: 'Lights and screens', exact: true });
    const picker = display.getByRole('combobox', { name: 'Screensaver', exact: true });
    await picker.selectOption('aurora');
    const preview = display.locator('.saver-preview img');
    await preview.waitFor();
    const apply = display.getByRole('button', { name: 'Apply screensaver', exact: true });
    if (await apply.isDisabled()) return 'the preview changed the saved screensaver before applying';
    await apply.click();
    await apply.waitFor({ state: 'visible' });
    if (!await apply.isDisabled()) return 'the screensaver was not saved';
    const selected = await picker.inputValue();
    await display.getByText('Advanced settings', { exact: true }).click();
    const scope = display.getByRole('combobox', { name: 'Apply to', exact: true });
    await scope.selectOption('own');
    const ready = selected === 'aurora' && await display.getByRole('button', { name: 'Add screensaver' }).isVisible();
    await display.getByRole('button', { name: 'Close' }).click();
    return ready && await layoutStays();
  });
  await step(page, `${label}: the profile dialog switches between Profiles and Get started`, async () => {
    for (const tab of ['Profiles', 'Get started']) {
      await profileTab(tab);
      await page.waitForTimeout(200);
      const sel = await page.locator('.lib-tabs [role="tab"][aria-selected="true"]').innerText();
      if (!sel.includes(tab)) return `tab ${tab} not selected`;
    }
    await closeProfiles();
    return true;
  });
  await step(page, `${label}: another control's click keeps the editor`, async () => {
    const ctl = page.locator('.dk-ctl');
    await ctl.nth(Math.min(5, (await ctl.count()) - 1)).click();
    const panel = page.locator('.stable-workspace .workspace-key-pane > .control-inspector');
    const deck = await page.locator('.deck-workspace > .center').boundingBox();
    const settings = await panel.boundingBox();
    const actions = await page.locator('.deck-workspace > .editor-sidebar').boundingBox();
    if (!deck || !settings || !actions || settings.x < deck.x + deck.width - 1) return 'key settings must be beside the deck';
    if (actions.width < 240 || actions.height < 200) return 'the Actions panel lost usable space';
    return panel.locator('.trigger-slot').first().isVisible();
  });
  await step(page, `${label}: the right library assigns press, hold and double press independently`, async () => {
    const key = page.locator('.dk-front .dk-ctl[data-kind="keys"]').nth(7);
    await key.click();
    const library = page.locator('.action-sidebar');
    const search = library.locator('#library-search');
    const inspector = page.locator('.control-inspector');
    for (const [trigger, text, name, id] of [
      ['tap', 'Hotkey', 'Hotkey', 'core.hotkey'],
      ['hold', 'microphone', 'Microphone mute', 'core.mic'],
      ['double', 'multimedia', 'Multimedia', 'core.media'],
    ]) {
      await search.fill(text);
      await library.getByRole('button', { name, exact: true }).dragTo(inspector.locator(`[data-trigger="${trigger}"]`));
      await inspector.locator(`#action-name[data-action="${id}"]`).waitFor();
    }
    for (const [trigger, id] of [['tap', 'core.hotkey'], ['hold', 'core.mic'], ['double', 'core.media']]) {
      await inspector.locator(`[data-trigger="${trigger}"] .trigger-choice`).click();
      await inspector.locator(`#action-name[data-action="${id}"]`).waitFor();
    }
    await inspector.getByRole('button', { name: 'Clear Hold', exact: true }).click();
    await inspector.locator('[data-trigger="hold"]').getByText('Drop an action').waitFor();
    if (await inspector.getByText(/Change action|All actions|Already in this profile|Ideas from other deck owners|Module info/i).count()) return 'an old inspector option is still visible';
    return await search.inputValue() === 'multimedia';
  });
  await step(page, `${label}: Settings while a key is picked, then back to the same editor`, async () => {
    await page.getByRole('button', { name: /^Settings$/ }).first().click();
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: /Back to the deck/ }).click();
    await page.waitForTimeout(250);
    return visible(page, '.control-inspector .trigger-slot');
  });
  await step(page, `${label}: the toolbar checks for updates and offers installation`, async () => {
    await page.locator('.topbar-update').click();
    await page.locator('.update-card').getByRole('button', { name: 'Install and restart', exact: true }).waitFor();
    await page.getByRole('button', { name: /Back to the deck/ }).click();
    return visible(page, '.stable-workspace .workspace-key-pane > .control-inspector');
  });
  await step(page, `${label}: Deck Builder opens from Deck tools, a card can be picked, Back returns`, async () => {
    await page.getByRole('button', { name: 'Deck tools', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Deck Builder', exact: true }).click();
    await page.waitForTimeout(500);
    if (!(await visible(page, '.builder-page'))) return 'no builder page';
    if ((await page.locator('.builder-card').count()) < 2) return 'no option cards';
    await page.locator('.builder-card button', { hasText: 'Pick' }).first().click();
    await page.waitForTimeout(300);
    if (!(await page.locator('.builder-step.is-current', { hasText: 'Knob 1' }).isVisible())) return 'Pick did not move on to the knobs';
    const draftKey = page.locator('.builder-canvas .dk-front .dk-ctl[data-kind="keys"]').nth(7);
    await draftKey.click();
    const library = page.locator('.builder-page .action-sidebar');
    await library.locator('#library-search').fill('microphone');
    const settings = page.locator('.builder-body > .control-inspector');
    await library.getByRole('button', { name: 'Microphone mute', exact: true }).dragTo(settings.locator('[data-trigger="hold"]'));
    await settings.locator('#action-name[data-action="core.mic"]').waitFor();
    await page.getByRole('button', { name: /Back to the deck/ }).click();
    await page.locator('.deck-area .dk-front .dk-ctl[data-kind="keys"]').nth(7).click();
    await page.locator('.deck-workspace [data-trigger="hold"]').getByText('Drop an action').waitFor();
    return (await visible(page, '.deck-area')) && !(await visible(page, '.builder-page'));
  });
  await step(page, `${label}: the tour: one question, the parts with Keep, the finale, the end, Exit back to the deck`, async () => {
    await profileTab('Get started');
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: /Show me on my deck/ }).click();
    await page.waitForTimeout(400);
    if (await visible(page, '.tour-desk')) await page.locator('.tour-desk').getByRole('button', { name: 'Yes, make my deck' }).click();
    if (!(await visible(page, '.tour-tiles'))) return 'no question';
    await page.getByRole('button', { name: 'Make my deck' }).click();
    await page.waitForTimeout(500);
    if ((await page.locator('.tour-part').count()) < 4) return 'no parts';
    if (!(await visible(page, '.tour-deck .dk-ctl'))) return 'no deck';
    await page.locator('.tour-part input[type=checkbox]').nth(1).click();
    await page.waitForTimeout(200);
    for (let i = 0; i < 8 && (await page.getByRole('button', { name: 'Next', exact: true }).isVisible()); i++) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.waitForTimeout(200);
    }
    if (!(await visible(page, '.tour-super'))) return 'no finale';
    await page.getByRole('button', { name: 'See my deck' }).click();
    await page.waitForTimeout(300);
    if (!(await visible(page, '.tour-end'))) return 'no end page';
    await page.getByRole('button', { name: /^Exit/ }).click();
    await page.waitForTimeout(300);
    return (await visible(page, '.deck-area')) && !(await visible(page, '.tour-page'));
  });
  // the tour to its end page, from the Get started tab
  const tourToEnd = async () => {
    await profileTab('Get started');
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: /Show me on my deck/ }).click();
    await page.waitForTimeout(400);
    if (await visible(page, '.tour-desk')) await page.locator('.tour-desk').getByRole('button', { name: 'Yes, make my deck' }).click();
    await page.getByRole('button', { name: 'Make my deck' }).click();
    await page.waitForTimeout(500);
    for (let i = 0; i < 8 && (await page.getByRole('button', { name: 'Next', exact: true }).isVisible()); i++) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.waitForTimeout(150);
    }
    await page.getByRole('button', { name: 'See my deck' }).click();
    await page.waitForTimeout(300);
  };
  await step(page, `${label}: Use as my home profile returns to the editor`, async () => {
    await tourToEnd();
    await page.getByRole('button', { name: /Use as my home profile/ }).click();
    await page.locator('.deck-area').waitFor();
    return !(await visible(page, '.tour-page')) && (await visible(page, '.deck-area'));
  });
  await step(page, `${label}: the assistant card sends with Enter, a short consent asks once, then never again`, async () => {
    await page.evaluate(() => localStorage.removeItem('hubdeck.assistantConsent'));
    await profileTab('Get started');
    await page.waitForTimeout(400);
    // examples come from the user's own deck, and only once a tour deck was kept
    if ((await page.locator('.as-examples .chip').count()) > 2) return 'more than two examples';
    await page.locator('#as-know').fill('Use my two free knobs');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    if (!(await page.locator('.as-consent .as-msg', { hasText: 'Use my two free knobs' }).isVisible())) return 'no consent with the message';
    if (await page.locator('.as-starter').count()) return 'Start with buttons are back';
    if (!(await page.locator('.as-consent input[type=checkbox]').isChecked())) return "Don't ask again is not checked";
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    if (!(await page.locator('.as-body > .as-msg.is-user', { hasText: 'Use my two free knobs' }).isVisible()) || (await visible(page, '.as-consent'))) return 'Enter did not send';
    await page.locator('.as-head .icon-btn').click();
    await page.waitForTimeout(300);
    await page.locator('#as-know').fill('A deck for meetings');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const again = (await visible(page, '.as-body > .as-msg.is-user')) && !(await visible(page, '.as-consent'));
    await page.locator('.as-head .icon-btn').click();
    await closeProfiles();
    return again || 'asked again';
  });
  await step(page, `${label}: Ready for your apps lists its profiles, off, and a switch turns one on`, async () => {
    await profileTab('Profiles');
    await page.waitForTimeout(300);
    if (!(await page.locator('.ready-apps .plist-head', { hasText: /Ready for your apps \(3\)/ }).isVisible())) return 'no group';
    // folded until opened (owner's pick A, 2026-10-22)
    if (!(await page.locator('.ready-apps').evaluate((d) => d.open))) await page.locator('.ready-apps > summary').click();
    const sw = page.locator('.ready-apps input[type=checkbox]').first();
    if (await sw.isChecked()) return 'on by default';
    await sw.click();
    await page.waitForTimeout(300);
    const on = await sw.isChecked();
    await sw.click();
    await closeProfiles();
    return on || 'the switch did not turn on';
  });
  await step(page, `${label}: Settings toggles closed from the top bar too`, async () => {
    await page.getByRole('button', { name: /^Settings$/ }).first().click();
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: /^Settings$/ }).first().click();
    await page.waitForTimeout(250);
    return (await visible(page, '.dk-ctl')) && !(await visible(page, '.settings-page'));
  });
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed; screenshots in ${out}`);
process.exit(failed.length ? 1 : 0);
