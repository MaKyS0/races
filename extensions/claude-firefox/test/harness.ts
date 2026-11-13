// Shared end-to-end harness: one local server that serves the built chat page with a simulated WebExtension API,
// a "web page" (the shop) for the tools, a mock of the Anthropic Messages API (SSE streaming, scripted per test) and
// a mock of Google's token + Drive endpoints (one Drive shared by every simulated device).
import http from 'node:http';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';

export const SHOP = `<!doctype html><html><head><title>Магазин</title></head><body><h1>Кроссовки</h1><p>Цена 4990 ₽</p>
<button onclick="window.bought=(window.bought||0)+1">Купить</button><a href="#reviews">Отзывы</a></body></html>`;

// fake WebExtension API for the background + chat scripts in one window; tab 7 is the shop page in an iframe.
// Opening Google's sign-in page "signs in" at once: the redirect to the loopback address goes to the webRequest listeners.
const FAKE = `
window.__store = window.__store || {};
const ev = () => { const l = []; return { addListener: (f) => l.push(f), removeListener: (f) => { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }, _fire: (...a) => l.map((f) => f(...a)) }; };
const shop = () => document.getElementById('shop');
const tab = () => ({ id: 7, url: 'https://shop.example/sneakers', title: shop().contentDocument.title, status: 'complete', lastAccessed: 1 });
const onConnect = ev(), onBeforeRequest = ev();
window.__opened = [];
window.browser = {
  storage: { local: {
    get: async () => JSON.parse(JSON.stringify(window.__store)),
    set: async (o) => { Object.assign(window.__store, JSON.parse(JSON.stringify(o))); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete window.__store[k]; },
  } },
  webRequest: { onBeforeRequest },
  tabs: {
    onActivated: ev(), onUpdated: ev(), onRemoved: ev(),
    get: async (id) => { if (id !== 7) throw new Error('no tab'); return tab(); },
    query: async () => [tab()],
    update: async () => tab(),
    remove: async () => {},
    create: async ({ url }) => {
      window.__opened.push(url);
      if (url.includes('/o/oauth2/')) {
        const u = new URL(url);
        setTimeout(() => onBeforeRequest._fire({ url: u.searchParams.get('redirect_uri') + '?code=good&state=' + u.searchParams.get('state'), tabId: 99 }), 50);
        return { id: 99, url };
      }
      return tab();
    },
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

export type Block = { text: string } | { tool: string; input: object };
export type Respond = (body: any) => { blocks: Block[]; stop: string };
export interface ApiRequest { headers: http.IncomingHttpHeaders; body: any }

function sse(res: http.ServerResponse, n: number, blocks: Block[], stop: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: 'msg_' + n, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
  blocks.forEach((b, i) => {
    if ('text' in b) {
      send('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
      for (const part of b.text.match(/.{1,6}/gs)!) send('content_block_delta', { index: i, delta: { type: 'text_delta', text: part } });
    } else {
      send('content_block_start', { index: i, content_block: { type: 'tool_use', id: `toolu_${n}_${i}`, name: b.tool, input: {} } });
      send('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    send('content_block_stop', { index: i });
  });
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', {});
  res.end();
}

export async function startHarness(respond: Respond) {
  const requests: ApiRequest[] = [];
  const drive = { content: null as string | null, writes: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x'), url = u.pathname;
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const json = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST' && url === '/v1/messages') {
        const body = JSON.parse(raw); requests.push({ headers: req.headers, body });
        const r = respond(body);
        return sse(res, requests.length, r.blocks, r.stop);
      }
      // ---- Google
      if (url === '/token') {
        const f = new URLSearchParams(raw);
        const idt = 'h.' + Buffer.from(JSON.stringify({ email: 'me@gmail.com' })).toString('base64url') + '.s';
        if (f.get('grant_type') === 'authorization_code' && f.get('code') === 'good' && f.get('code_verifier')) return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idt });
        if (f.get('grant_type') === 'refresh_token') return json({ access_token: 'at', expires_in: 3600 });
        res.writeHead(400); return res.end('{"error":"invalid_grant"}');
      }
      if (url.startsWith('/drive') || url.startsWith('/upload')) {
        if (req.headers.authorization !== 'Bearer at') { res.writeHead(401); return res.end('{}'); }
        if (url === '/drive/v3/files') return json({ files: drive.content ? [{ id: 'f1' }] : [] });
        if (url === '/drive/v3/files/f1') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(drive.content); }
        if (url === '/upload/drive/v3/files' && req.method === 'POST') { drive.content = raw.split('\r\n\r\n')[2].split('\r\n--')[0]; drive.writes++; return json({ id: 'f1' }); }
        if (url === '/upload/drive/v3/files/f1' && req.method === 'PATCH') { drive.content = raw; drive.writes++; return json({ id: 'f1' }); }
      }
      // ---- pages
      if (url === '/harness') {
        const chat = fs.readFileSync('dist/chat.html', 'utf8').replace('<script src="chat.js"></script>', '');
        const html = chat.replace('<link rel="stylesheet" href="chat.css">', `<link rel="stylesheet" href="/dist/chat.css"><script>${FAKE}</script>`)
          .replace('<img src="icon.svg"', '<img src="/dist/icon.svg"')
          .replace('</body>', `<iframe id="shop" src="/shop" style="width:400px;height:300px"></iframe></body>`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
      }
      if (url === '/shop') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(SHOP); }
      if (url.startsWith('/dist/')) { res.writeHead(200, { 'content-type': url.endsWith('.css') ? 'text/css' : url.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript' }); return res.end(fs.readFileSync('.' + url)); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const google = { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: base + '/token', apiUrl: base + '/drive/v3', uploadUrl: base + '/upload/drive/v3' };
  return { base, requests, drive, google, close: () => server.close() };
}

/** one simulated device: its own browser context (own storage), the extension started with the given stored values */
export async function openDevice(browser: Browser, base: string, store: Record<string, unknown>): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/harness');
  await page.waitForFunction(() => (document.getElementById('shop') as HTMLIFrameElement).contentDocument?.title === 'Магазин');
  await page.evaluate((s) => { Object.assign((window as any).__store, s); }, store);
  await page.addScriptTag({ url: '/dist/background.js' });
  await page.addScriptTag({ url: '/dist/chat.js' });
  await page.waitForFunction(() => document.getElementById('target')!.textContent!.includes('shop.example'));
  return { page, errors };
}

/** the text of the first user message of the request's conversation */
export const firstUserText = (body: any): string => {
  const m = body.messages.find((x: any) => x.role === 'user' && typeof x.content === 'string');
  return m?.content ?? '';
};
export const toolResults = (body: any): any[] => {
  const last = body.messages[body.messages.length - 1];
  return Array.isArray(last.content) ? last.content.filter((b: any) => b.type === 'tool_result') : [];
};
