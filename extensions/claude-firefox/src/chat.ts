// Chat tab: renders the conversation the background page holds and sends the user's messages, confirmations and settings.
import type { AgentEvent } from './agent';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = $('log'), input = $<HTMLTextAreaElement>('input'), send = $<HTMLButtonElement>('send'), stopBtn = $<HTMLButtonElement>('stop');
const dlg = $<HTMLDialogElement>('settings');

type Item = { kind: 'user' | 'assistant' | 'error'; text: string } | { kind: 'tool'; id: string; summary: string; status: string; detail?: string };
let current: HTMLElement | null = null;        // the assistant message being streamed
let currentText = '';
let busy = false, hasKey = false;
const tools = new Map<string, HTMLElement>();

// ---------------------------------------------------------------- rendering
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** small, safe Markdown subset: code blocks, inline code, bold, links, paragraphs */
function md(src: string): string {
  const parts = src.split(/```[a-z]*\n?/);
  return parts.map((p, i) => {
    if (i % 2) return `<pre><code>${esc(p)}</code></pre>`;
    return esc(p).split(/\n{2,}/).map((para) => `<p>${para
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\n/g, '<br>')}</p>`).join('');
  }).join('');
}
const scroll = () => { log.scrollTop = log.scrollHeight; };
function add(cls: string, html: string): HTMLElement {
  $('empty')?.remove();
  const d = document.createElement('div'); d.className = cls; d.innerHTML = html; log.append(d); scroll(); return d;
}
const ICON: Record<string, string> = { running: '⏳', done: '✓', error: '✕', denied: '⊘' };
function toolLine(id: string, summary: string, status: string, detail?: string) {
  const html = `<span class="st">${ICON[status] ?? '•'}</span>${esc(summary)}${detail ? `<span class="detail">${esc(detail)}</span>` : ''}`;
  const el = tools.get(id);
  if (el) { el.className = 'tool ' + status; el.innerHTML = html; } else tools.set(id, add('tool ' + status, html));
}
function renderItem(it: Item) {
  if (it.kind === 'user') add('msg user', esc(it.text));
  else if (it.kind === 'assistant') add('msg assistant', md(it.text));
  else if (it.kind === 'error') add('msg error', esc(it.text));
  else if (it.kind === 'tool') toolLine(it.id, it.summary, it.status, it.detail);
}
function confirmBox(id: string, question: string) {
  const box = add('confirm', `<p>${esc(question)}</p><div class="buttons"><button class="no">Запретить</button><button class="primary yes">Разрешить</button></div>`);
  const answer = (ok: boolean) => { port.postMessage({ type: 'confirm', id, ok }); box.remove(); };
  box.querySelector<HTMLButtonElement>('.yes')!.onclick = () => answer(true);
  box.querySelector<HTMLButtonElement>('.no')!.onclick = () => answer(false);
}
function setBusy(b: boolean) {
  busy = b; send.hidden = b; stopBtn.hidden = !b;
  if (!b && current) { current.classList.remove('typing'); current = null; }
}

// ---------------------------------------------------------------- background connection
let port = connect();
function connect() {
  const p = browser.runtime.connect({ name: 'chat' });
  p.onMessage.addListener(onMessage as (m: object) => void);
  p.onDisconnect.addListener(() => setTimeout(() => { port = connect(); }, 500));
  return p;
}
function onMessage(m: { type: string; [k: string]: unknown }) {
  if (m.type === 'state') {
    log.innerHTML = ''; tools.clear(); current = null;
    const items = m.items as Item[];
    if (!items.length) log.innerHTML = EMPTY;
    items.forEach(renderItem);
    setBusy(!!m.busy); hasKey = !!m.hasKey;
    if (m.settings) fillSettings(m.settings as Settings);
    if (!hasKey) dlg.showModal();
  } else if (m.type === 'user') {
    add('msg user', esc(m.text as string));
  } else if (m.type === 'target') {
    const t = $('target');
    t.textContent = m.url ? `${m.title || ''} · ${new URL(m.url as string).host}` : 'нет открытой страницы';
  } else if (m.type === 'saved') {
    hasKey = !!m.hasKey; $('keyState').textContent = hasKey ? 'Ключ сохранён' : 'Ключ не задан';
  } else if (m.type === 'event') onEvent(m.event as AgentEvent);
  else if (m.type === 'meta') onMeta(m as unknown as Meta);
  else if (m.type === 'settings') fillSettings(m.settings as Settings);
  else if (m.type === 'notice') add('notice' + (m.error ? ' error' : ''), esc(m.text as string));
}
function onEvent(e: AgentEvent) {
  if (e.type === 'text') {
    if (!current) { current = add('msg assistant typing', ''); currentText = ''; }
    currentText += e.delta; current.innerHTML = md(currentText); scroll();
  } else if (e.type === 'turn_end') { current?.classList.remove('typing'); current = null; }
  else if (e.type === 'tool') { current = null; toolLine(e.id, e.summary, e.status, e.detail); }
  else if (e.type === 'confirm') confirmBox(e.id, e.question);
  else if (e.type === 'error') add('msg error', esc(e.message));
  else if (e.type === 'busy') setBusy(e.busy);
}
const EMPTY = $('empty').outerHTML;

// ---------------------------------------------------------------- composer
const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'; };
input.addEventListener('input', grow);
input.addEventListener('keydown', (e) => {
  // Enter sends on a hardware keyboard; on the phone keyboard the send button is the way
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); submit(); }
});
$('composer').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
function submit() {
  const text = input.value.trim();
  if (!text || busy) return;
  if (!hasKey) { dlg.showModal(); return; }
  port.postMessage({ type: 'send', text });
  input.value = ''; grow();
}
stopBtn.onclick = () => port.postMessage({ type: 'stop' });
$('new').onclick = () => port.postMessage({ type: 'reset' });   // the current conversation stays in the history (☰)

// ---------------------------------------------------------------- settings
type Settings = { apiKey: string; model: string; effort: string; confirmActions: boolean; googleClientId: string; googleClientSecret: string; syncApiKey: boolean };
function fillSettings(s: Settings) {
  $<HTMLInputElement>('apiKey').value = '';
  $('keyState').textContent = s.apiKey ? `Сохранён ключ ${s.apiKey}. Оставьте поле пустым, чтобы не менять.` : 'Ключ не задан. Его можно создать на console.anthropic.com.';
  $<HTMLSelectElement>('model').value = s.model;
  $<HTMLSelectElement>('effort').value = s.effort;
  $<HTMLInputElement>('confirmActions').checked = s.confirmActions;
  $<HTMLInputElement>('syncApiKey').checked = s.syncApiKey;
  $<HTMLInputElement>('gClientId').value = s.googleClientId;
  $<HTMLInputElement>('gClientSecret').value = '';
  $<HTMLInputElement>('gClientSecret').placeholder = s.googleClientSecret ? 'сохранён (оставьте пустым)' : 'GOCSPX-…';
  ($('gHelp') as HTMLDetailsElement).open = !s.googleClientId;
}
$('gear').onclick = () => dlg.showModal();
$('cancel').onclick = () => dlg.close();
const formSettings = () => ({
  apiKey: $<HTMLInputElement>('apiKey').value.trim(),
  model: $<HTMLSelectElement>('model').value,
  effort: $<HTMLSelectElement>('effort').value,
  confirmActions: $<HTMLInputElement>('confirmActions').checked,
  syncApiKey: $<HTMLInputElement>('syncApiKey').checked,
  googleClientId: $<HTMLInputElement>('gClientId').value.trim(),
  googleClientSecret: $<HTMLInputElement>('gClientSecret').value.trim(),
});
$('settingsForm').addEventListener('submit', () => port.postMessage({ type: 'settings', settings: formSettings() }));

// ---------------------------------------------------------------- Google sync, history, memory
type Meta = { google: { email: string; status: string; at: number; error: string }; notes: { id: string; text: string }[]; conversations: { id: string; title: string; updated: number }[]; currentId: string | null };
let lastMeta: Meta | null = null;
const when = (t: number) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function onMeta(m: Meta) {
  lastMeta = m;
  const g = m.google, st = $('syncState');
  st.className = 'sync-state' + (g.status === 'error' ? ' error' : '');
  st.textContent = !g.email ? 'Не подключено'
    : g.status === 'syncing' ? `${g.email}: синхронизация…`
    : g.status === 'error' ? `${g.email}: ошибка — ${g.error}`
    : `${g.email}: синхронизировано${g.at ? ' ' + when(g.at) : ''}`;
  $('gLogin').hidden = !!g.email; $('gSync').hidden = !g.email; $('gLogout').hidden = !g.email;
  renderLists();
}
function li(main: string, onOpen: (() => void) | null, onDelete: () => void, current = false) {
  const el = document.createElement('li');
  if (current) el.className = 'current';
  const b = document.createElement(onOpen ? 'button' : 'div'); b.className = 'main'; b.innerHTML = main;
  if (onOpen) b.addEventListener('click', onOpen);
  const d = document.createElement('button'); d.className = 'del'; d.textContent = '✕'; d.setAttribute('aria-label', 'Удалить');
  d.addEventListener('click', onDelete);
  el.append(b, d); return el;
}
function renderLists() {
  if (!lastMeta) return;
  const cl = $('convList'), nl = $('noteList');
  cl.replaceChildren(...lastMeta.conversations.map((c) => li(`${esc(c.title || 'Без названия')}<small>${when(c.updated)}</small>`,
    () => { port.postMessage({ type: 'open_conv', id: c.id }); ($('history') as HTMLDialogElement).close(); },
    () => { if (confirm('Удалить этот разговор на всех устройствах?')) port.postMessage({ type: 'delete_conv', id: c.id }); }, c.id === lastMeta!.currentId)));
  if (!lastMeta.conversations.length) cl.innerHTML = '<li class="empty-row">Пока нет разговоров</li>';
  nl.replaceChildren(...lastMeta.notes.map((n) => li(esc(n.text), null, () => port.postMessage({ type: 'delete_note', id: n.id }))));
  if (!lastMeta.notes.length) nl.innerHTML = '<li class="empty-row">Память пуста. Скажите Claude «запомни, что…».</li>';
}
$('gLogin').onclick = () => {
  // save the client ID / secret first, then start the sign-in tab
  port.postMessage({ type: 'settings', settings: formSettings() });
  port.postMessage({ type: 'google_login' });
  $('syncState').textContent = 'Открываю вход Google…';
};
$('gSync').onclick = () => port.postMessage({ type: 'sync_now' });
$('gLogout').onclick = () => { if (confirm('Отключить синхронизацию с Google на этом устройстве?')) port.postMessage({ type: 'google_logout' }); };
for (const id of ['history', 'memory']) {
  const d = $(id) as HTMLDialogElement;
  d.querySelector<HTMLButtonElement>('.close')!.onclick = () => d.close();
}
$('hist').onclick = () => { renderLists(); ($('history') as HTMLDialogElement).showModal(); };
$('mem').onclick = () => { renderLists(); ($('memory') as HTMLDialogElement).showModal(); };
$('noteForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $<HTMLInputElement>('noteText');
  if (t.value.trim()) port.postMessage({ type: 'add_note', text: t.value.trim() });
  t.value = '';
});
