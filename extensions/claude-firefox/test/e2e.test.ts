// End to end in Chromium: the built chat page + background script + the real Anthropic SDK, with a simulated `browser`
// (runtime port, storage, tabs; executeScript runs in a "web page" iframe) and a local mock of the Messages API that
// streams SSE like the real one. Checks the request Claude would get and the whole get_page -> confirm -> click flow.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
// @ts-expect-error the repository's Chromium launcher (scripts/browser.mjs) has no type declarations
import { launch } from '../../../scripts/browser.mjs';
import { startHarness, openDevice, toolResults } from './harness';

let h: Awaited<ReturnType<typeof startHarness>>, browser: Browser;
before(async () => {
  h = await startHarness((body) => {
    const results = toolResults(body);
    if (!results.length) return { blocks: [{ text: 'Смотрю страницу.' }, { tool: 'get_page', input: {} }], stop: 'tool_use' };
    const out = String(results[0].content);
    const id = out.match(/\[(\d+)\] button "Купить"/)?.[1];
    if (id && !/Clicked/.test(out)) return { blocks: [{ tool: 'click', input: { id } }], stop: 'tool_use' };
    return { blocks: [{ text: 'Готово: **нажал «Купить»**.' }], stop: 'end_turn' };
  });
  browser = await launch();
});
after(async () => { await browser?.close(); h?.close(); });

test('chat -> Claude reads the page -> asks to click -> user allows -> the page button is clicked -> answer streams back', async () => {
  // settings saved before the background starts, as storage would hold them
  const { page, errors } = await openDevice(browser, h.base, { apiKey: 'sk-ant-test', baseURL: h.base });
  await page.fill('#input', 'Нажми кнопку «Купить»');
  await page.click('#send');
  await page.waitForSelector('.confirm', { timeout: 15000 });
  assert.match(await page.textContent('.confirm p') ?? '', /Нажать кнопку «Купить»\?/);
  await page.screenshot({ path: 'artifacts/e2e-confirm.png' });
  await page.click('.confirm .yes');
  await page.waitForFunction(() => document.querySelector('#send:not([hidden])') && document.body.innerText.includes('Готово'), null, { timeout: 15000 });
  await page.screenshot({ path: 'artifacts/e2e-done.png' });
  assert.equal(await page.evaluate(() => ((document.getElementById('shop') as HTMLIFrameElement).contentWindow as any).bought), 1);
  const log = await page.textContent('#log');
  assert.match(log!, /Смотрю страницу\./);
  assert.match(log!, /Нажимаю \[\d+\]/);
  assert.equal(await page.innerHTML('.msg.assistant:last-of-type b'), 'нажал «Купить»');
  assert.deepEqual(errors, []);

  // what the API received
  assert.equal(h.requests.length, 3);
  const [first, second, third] = h.requests;
  // SDK 1.x sends the API key as a bearer token (API version 2026-10-21)
  assert.equal(first.headers.authorization, 'Bearer sk-ant-test');
  assert.match(String(first.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.match(String(first.headers['anthropic-beta']), /context-management-2025-06-27/);
  assert.equal(first.body.model, 'claude-opus-5-5');
  assert.equal(first.body.fallbacks, 'default');
  assert.equal(first.body.stream, true);
  assert.deepEqual(first.body.output_config, { effort: 'medium' });
  assert.ok(first.body.tools.every((t: any) => t.strict === true && t.eager_input_streaming === true && t.input_schema.additionalProperties === false));
  assert.equal(first.body.thinking, undefined);
  // the page text reaches Claude fenced as untrusted content, and the click result follows
  const pageResult = second.body.messages[2].content[0];
  assert.equal(pageResult.type, 'tool_result');
  assert.match(pageResult.content, /<page_text>[\s\S]*Цена 4990[\s\S]*<\/page_text>/);
  assert.match(third.body.messages[4].content[0].content, /Clicked/);
});
