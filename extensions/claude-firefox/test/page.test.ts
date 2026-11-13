// The in-page functions, run in real Chromium exactly the way the extension sends them (source text of the bundled function).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
// @ts-expect-error the repository's Chromium launcher (scripts/browser.mjs) has no type declarations
import { launch } from '../../../scripts/browser.mjs';
import { snapshot, describe, click, typeText, scrollPage } from '../src/page';

const HTML = `<!doctype html><html><head><title>Тестовая страница</title></head><body style="margin:0">
<h1>Магазин</h1><p>Добро пожаловать. Сегодня скидки.</p>
<a href="/about">О нас</a>
<button id="hidden" style="display:none">Скрыто</button>
<button id="buy" onclick="window.bought=(window.bought||0)+1">Купить</button>
<form id="f" onsubmit="event.preventDefault(); window.submitted=document.getElementById('q').value">
  <input id="q" name="q" placeholder="Поиск товаров"><input id="pw" type="password" name="password">
</form>
<select id="city"><option value="msk">Москва</option><option value="kzn">Казань</option></select>
<div id="ed" contenteditable="true" aria-label="Заметка"></div>
<div style="height:3000px"></div><button>Внизу</button>
<script>
  // a framework-style input: it only trusts the value it sees in input events
  window.seen = ''; document.getElementById('q').addEventListener('input', (e) => { window.seen = e.target.value; });
</script></body></html>`;

let browser: Browser, page: Page;
const run = <A, R>(fn: (a: A) => R, args: A) => page.evaluate(`(${fn.toString()})(${JSON.stringify(args)})`) as Promise<R>;
const idOf = async (sel: string) => (await page.getAttribute(sel, 'data-claude-id'))!;

before(async () => {
  browser = await launch();
  page = await browser.newPage({ viewport: { width: 412, height: 800 } });
  await page.setContent(HTML);
});
after(async () => { await browser?.close(); });

test('snapshot lists visible interactive elements with ids and the page text', async () => {
  const s = await run(snapshot, { maxText: 5000, maxElements: 100 });
  assert.equal(s.title, 'Тестовая страница');
  assert.match(s.text, /Добро пожаловать/);
  assert.match(s.elements, /\[\d+\] a\(href=\/about\) "О нас"/);
  assert.match(s.elements, /\[\d+\] button "Купить"/);
  assert.match(s.elements, /input\(type=text, placeholder="Поиск товаров"\)/);
  assert.match(s.elements, /select "[^"]*" value="Москва options: Москва \| Казань"/);
  assert.match(s.elements, /"Внизу" \(below\)/);
  assert.doesNotMatch(s.elements, /Скрыто/);
  // ids stay the same on the next read
  const again = await run(snapshot, { maxText: 5000, maxElements: 100 });
  assert.equal(again.elements, s.elements);
});

test('click reaches the element', async () => {
  const r = await run(click, { id: await idOf('#buy') });
  assert.ok(r.ok);
  assert.equal(await page.evaluate('window.bought'), 1);
});

test('typing sets the value so framework listeners see it, and submit runs the form', async () => {
  const r = await run(typeText, { id: await idOf('#q'), text: 'кроссовки', submit: true });
  assert.ok(r.ok, r.message);
  assert.equal(await page.evaluate('window.seen'), 'кроссовки');
  assert.equal(await page.evaluate('window.submitted'), 'кроссовки');
});

test('select by option text; contenteditable; password fields are flagged as sensitive', async () => {
  assert.ok((await run(typeText, { id: await idOf('#city'), text: 'Казань' })).ok);
  assert.equal(await page.inputValue('#city'), 'kzn');
  assert.ok(!(await run(typeText, { id: await idOf('#city'), text: 'Сочи' })).ok);
  assert.ok((await run(typeText, { id: await idOf('#ed'), text: 'привет' })).ok);
  assert.equal(await page.textContent('#ed'), 'привет');
  const d = await run(describe, { id: await idOf('#pw') });
  assert.ok(d.ok && d.password);
  assert.ok(!(await run(describe, { id: await idOf('#q') })).password);
});

test('unknown ids are reported, scrolling moves the page', async () => {
  const r = await run(click, { id: '9999' });
  assert.ok(!r.ok);
  assert.match(r.message, /get_page/);
  const s = await run(scrollPage, { direction: 'bottom' });
  assert.match(s.message, /100%/);
});
