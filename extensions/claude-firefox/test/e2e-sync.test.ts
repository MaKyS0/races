// Two devices, one Google account: on device A Claude saves a memory note during a chat; device B signs in to the same
// Google Drive and gets the note and the conversation, and a new conversation there starts with the note in Claude's memory.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
// @ts-expect-error the repository's Chromium launcher (scripts/browser.mjs) has no type declarations
import { launch } from '../../../scripts/browser.mjs';
import { startHarness, openDevice, firstUserText, toolResults } from './harness';

let h: Awaited<ReturnType<typeof startHarness>>, browser: Browser;
before(async () => {
  h = await startHarness((body) => {
    const first = firstUserText(body), done = toolResults(body).length > 0;
    if (/Запомни/.test(first)) return done ? { blocks: [{ text: 'Запомнил.' }], stop: 'end_turn' }
      : { blocks: [{ tool: 'remember', input: { text: 'Город пользователя: Казань' } }], stop: 'tool_use' };
    if (/Где я живу/.test(first)) return { blocks: [{ text: /Казань/.test(JSON.stringify(body.system)) ? 'В Казани.' : 'Не знаю.' }], stop: 'end_turn' };
    return { blocks: [{ text: '?' }], stop: 'end_turn' };
  });
  browser = await launch();
});
after(async () => { await browser?.close(); h?.close(); });

const deviceStore = () => ({ apiKey: 'sk-ant-test', baseURL: h.base, googleClientId: 'cid.apps.googleusercontent.com', googleClientSecret: 'sec', googleEndpoints: h.google });

async function signIn(page: Page) {
  await page.click('#gear');
  await page.click('#gLogin');
  await page.waitForFunction(() => /me@gmail\.com: синхронизировано/.test(document.getElementById('syncState')!.textContent!), null, { timeout: 15000 });
  await page.screenshot({ path: 'artifacts/sync-settings.png', fullPage: true });
  await page.click('#cancel');
}
async function chat(page: Page, text: string, expect: string) {
  await page.fill('#input', text);
  await page.click('#send');
  await page.waitForFunction((t) => document.querySelector('#send:not([hidden])') && document.getElementById('log')!.innerText.includes(t), expect, { timeout: 15000 });
}

test('memory and conversations follow the Google account to another device', async () => {
  // ---- device A
  const A = await openDevice(browser, h.base, deviceStore());
  await signIn(A.page);
  const auth = new URL(await A.page.evaluate(() => (window as any).__opened[0]));
  assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(auth.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/drive.appdata');
  await chat(A.page, 'Запомни: я живу в Казани', 'Запомнил.');
  assert.match(await A.page.textContent('#log') ?? '', /Запоминаю: «Город пользователя: Казань»/);
  // the note is in device A's memory list, and the change reaches Drive (sync runs a few seconds after a change)
  await A.page.click('#mem');
  assert.match(await A.page.textContent('#noteList') ?? '', /Город пользователя: Казань/);
  await A.page.screenshot({ path: 'artifacts/sync-memory.png' });
  await A.page.click('#memory .close');
  await A.page.waitForFunction(() => true);
  for (let i = 0; i < 80 && !/Казань[\s\S]*Запомнил/.test(h.drive.content ?? ''); i++) await new Promise((r) => setTimeout(r, 100));
  const file = JSON.parse(h.drive.content!);
  assert.equal(file.notes[0].text, 'Город пользователя: Казань');
  assert.equal(file.conversations[0].title, 'Запомни: я живу в Казани');
  assert.equal(file.settings.apiKey, undefined);               // the API key is not synced unless the user turns it on
  assert.deepEqual(A.errors, []);

  // ---- device B: same Google account
  const B = await openDevice(browser, h.base, deviceStore());
  await signIn(B.page);
  await B.page.click('#hist');
  assert.match(await B.page.textContent('#convList') ?? '', /Запомни: я живу в Казани/);
  await B.page.screenshot({ path: 'artifacts/sync-history.png' });
  await B.page.click('#convList li .main');
  await B.page.waitForFunction(() => document.getElementById('log')!.innerText.includes('Запомнил.'));
  await B.page.click('#mem');
  assert.match(await B.page.textContent('#noteList') ?? '', /Город пользователя: Казань/);
  await B.page.click('#memory .close');
  // a new conversation on B starts with the synced memory
  await B.page.click('#new');
  await chat(B.page, 'Где я живу?', 'В Казани.');
  const last = h.requests[h.requests.length - 1];
  assert.match(JSON.stringify(last.body.system), /<memory>\\n\[\w+\] Город пользователя: Казань/);
  assert.deepEqual(B.errors, []);

  // ---- deleting the note on B removes it on A after A syncs
  await B.page.click('#mem');
  await B.page.click('#noteList li .del');
  await B.page.click('#memory .close');
  for (let i = 0; i < 80 && JSON.parse(h.drive.content!).notes.some((n: any) => !n.deleted); i++) await new Promise((r) => setTimeout(r, 100));
  await A.page.click('#gear');
  await A.page.click('#gSync');
  await A.page.waitForFunction(() => /синхронизировано/.test(document.getElementById('syncState')!.textContent!));
  await A.page.click('#cancel');
  await A.page.click('#mem');
  await A.page.waitForFunction(() => /Память пуста/.test(document.getElementById('noteList')!.textContent!));
});
