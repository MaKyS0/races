// End to end in Chromium: the built chat page + background script + the real Anthropic SDK, with a simulated `browser`
// (runtime port, storage, tabs; executeScript runs in a "web page" iframe) and a local mock of the Messages API that
// streams SSE like the real one. Checks the request Claude would get and the whole get_page -> confirm -> click flow.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
// @ts-expect-error the repository's Chromium launcher (scripts/browser.mjs) has no type declarations
import { launch } from '../../../scripts/browser.mjs';

const SHOP = `<!doctype html><html><head><title>Магазин</title></head><body><h1>Кроссовки</h1><p>Цена 4990 ₽</p>
<button onclick="window.bought=(window.bought||0)+1">Купить</button><a href="#reviews">Отзывы</a></body></html>`;

// fake WebExtension API for the background + chat scripts in one window; tab 7 is the shop page in an iframe
const FAKE = `
window.__store = {}; const listeners = [];
const ev = () => { const l = []; return { addListener: (f) => l.push(f), _fire: (...a) => l.forEach((f) => f(...a)) }; };
const shop = () => document.getElementById('shop');
const tab = () => ({ id: 7, url: 'https://shop.example/sneakers', title: shop().contentDocument.title, status: 'complete', lastAccessed: 1 });
const onConnect = ev();
window.browser = {
  storage: { local: { get: async () => ({ ...window.__store }), set: async (o) => { Object.assign(window.__store, o); } } },
  tabs: {
    onActivated: ev(), onUpdated: ev(), onRemoved: ev(),
    get: async (id) => { if (id !== 7) throw new Error('no tab'); return tab(); },
    query: async () => [tab()],
    update: async () => tab(), create: async () => tab(),
    executeScript: async (id, { code }) => [shop().contentWindow.eval(code)],
  },
  browserAction: { onClicked: ev() },
  runtime: {
    getURL: (p) => 'moz-extension://x/' + p,
    onConnect,
    connect: ({ name }) => {
      // two linked ports: the chat side and the background side
      const mk = () => ({ name, onMessage: ev(), onDisconnect: ev(), postMessage: null });
      const a = mk(), b = mk();
      a.postMessage = (m) => setTimeout(() => b.onMessage._fire(JSON.parse(JSON.stringify(m))));
      b.postMessage = (m) => setTimeout(() => a.onMessage._fire(JSON.parse(JSON.stringify(m))));
      setTimeout(() => onConnect._fire(b));
      return a;
    },
  },
};`;

let server: http.Server, browser: Browser, base = '';
const requests: { headers: http.IncomingHttpHeaders; body: any }[] = [];

function sse(res: http.ServerResponse, blocks: ({ text: string } | { tool: string; input: object })[], stop: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: 'msg_' + requests.length, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
  blocks.forEach((b, i) => {
    if ('text' in b) {
      send('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
      for (const part of b.text.match(/.{1,6}/gs)!) send('content_block_delta', { index: i, delta: { type: 'text_delta', text: part } });
    } else {
      send('content_block_start', { index: i, content_block: { type: 'tool_use', id: 'toolu_' + requests.length + i, name: b.tool, input: {} } });
      send('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    send('content_block_stop', { index: i });
  });
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', {});
  res.end();
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url!.split('?')[0];
    if (req.method === 'POST' && url === '/v1/messages') {
      let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
        const body = JSON.parse(raw); requests.push({ headers: req.headers, body });
        const last = body.messages[body.messages.length - 1];
        const results = Array.isArray(last.content) ? last.content.filter((b: any) => b.type === 'tool_result') : [];
        if (!results.length) return sse(res, [{ text: 'Смотрю страницу.' }, { tool: 'get_page', input: {} }], 'tool_use');
        const out = String(results[0].content);
        const id = out.match(/\[(\d+)\] button "Купить"/)?.[1];
        if (id && !/Clicked/.test(out)) return sse(res, [{ tool: 'click', input: { id } }], 'tool_use');
        return sse(res, [{ text: 'Готово: **нажал «Купить»**.' }], 'end_turn');
      });
      return;
    }
    if (url === '/harness') {
      const chat = fs.readFileSync('dist/chat.html', 'utf8').replace('<script src="chat.js"></script>', '');
      const html = chat.replace('<link rel="stylesheet" href="chat.css">', `<link rel="stylesheet" href="/dist/chat.css"><script>${FAKE}</script>`)
        .replace('</body>', `<iframe id="shop" src="/shop" style="width:400px;height:300px"></iframe></body>`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (url === '/shop') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(SHOP); }
    if (url.startsWith('/dist/')) { res.writeHead(200, { 'content-type': url.endsWith('.css') ? 'text/css' : url.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript' }); return res.end(fs.readFileSync('.' + url)); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

test('chat -> Claude reads the page -> asks to click -> user allows -> the page button is clicked -> answer streams back', async () => {
  const page = await browser.newPage({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/harness');
  await page.waitForFunction(() => (document.getElementById('shop') as HTMLIFrameElement).contentDocument?.title === 'Магазин');
  // settings saved before the background starts, as storage would hold them
  await page.evaluate((b) => { (window as any).__store = { apiKey: 'sk-ant-test', baseURL: b }; }, base);
  await page.addScriptTag({ url: '/dist/background.js' });
  await page.addScriptTag({ url: '/dist/chat.js' });
  await page.waitForFunction(() => document.getElementById('target')!.textContent!.includes('shop.example'));
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
  assert.equal(requests.length, 3);
  const [first, second, third] = requests;
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
