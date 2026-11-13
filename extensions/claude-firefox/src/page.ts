// Functions that run inside the web page (injected with tabs.executeScript). Each one is self-contained: it is serialized with
// Function.prototype.toString, so it must not reference anything outside its own body.

export interface SnapshotArgs { maxText: number; maxElements: number }
export interface Snapshot { url: string; title: string; text: string; elements: string; scroll: string }

/** Page text plus a numbered list of the visible interactive elements. Every listed element gets a data-claude-id attribute. */
export function snapshot(args: SnapshotArgs): Snapshot {
  const SEL = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [contenteditable=""], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';
  const clean = (s: string | null | undefined, n = 80) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  let next = Number(document.documentElement.getAttribute('data-claude-next') || '1');
  const lines: string[] = [];
  const vh = innerHeight;
  for (const el of Array.from(document.querySelectorAll(SEL))) {
    if (lines.length >= args.maxElements) break;
    if (!visible(el)) continue;
    let id = el.getAttribute('data-claude-id');
    if (!id) { id = String(next++); el.setAttribute('data-claude-id', id); }
    const tag = el.tagName.toLowerCase();
    const h = el as HTMLElement & { value?: string; type?: string; placeholder?: string; checked?: boolean; disabled?: boolean };
    let kind = el.getAttribute('role') || tag;
    const attrs: string[] = [];
    if (tag === 'input') { kind = 'input'; attrs.push('type=' + (h.type || 'text')); }
    if (h.placeholder) attrs.push('placeholder="' + clean(h.placeholder, 40) + '"');
    if (tag === 'a') { const href = el.getAttribute('href') || ''; if (href && !href.startsWith('javascript:')) attrs.push('href=' + clean(href, 60)); }
    if (h.disabled) attrs.push('disabled');
    if (h.type === 'checkbox' || h.type === 'radio') attrs.push(h.checked ? 'checked' : 'unchecked');
    const label = clean(el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || el.getAttribute('alt') || (el.querySelector('img[alt]')?.getAttribute('alt')) || '');
    let value = '';
    if (tag === 'select') value = clean((el as HTMLSelectElement).selectedOptions[0]?.text, 40) + ' options: ' + Array.from((el as HTMLSelectElement).options).slice(0, 12).map((o) => clean(o.text, 25)).join(' | ');
    else if ((tag === 'input' || tag === 'textarea') && h.type !== 'password') value = clean(h.value, 60);
    else if (h.type === 'password' && h.value) value = '(filled)';
    const r = el.getBoundingClientRect();
    const where = r.bottom < 0 ? ' (above)' : r.top > vh ? ' (below)' : '';
    lines.push(`[${id}] ${kind}${attrs.length ? '(' + attrs.join(', ') + ')' : ''}${label ? ' "' + label + '"' : ''}${value ? ' value="' + value + '"' : ''}${where}`);
  }
  document.documentElement.setAttribute('data-claude-next', String(next));
  const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  return {
    url: location.href, title: document.title,
    text: text.length > args.maxText ? text.slice(0, args.maxText) + `\n… (${text.length - args.maxText} more characters; scroll or ask for more)` : text,
    elements: lines.join('\n'),
    scroll: `${Math.round((scrollY / max) * 100)}% (viewport ${innerWidth}x${innerHeight})`,
  };
}

export interface ActArgs { id: string; text?: string; submit?: boolean }
export interface ActResult { ok: boolean; message: string; password?: boolean }

/** Look up an element by its data-claude-id and say what it is (used for confirmations before acting). */
export function describe(args: ActArgs): ActResult {
  const el = document.querySelector(`[data-claude-id="${CSS.escape(args.id)}"]`) as HTMLElement | null;
  if (!el) return { ok: false, message: `No element [${args.id}] on the page any more. Call get_page again.` };
  const label = (el.getAttribute('aria-label') || el.innerText || (el as HTMLInputElement).placeholder || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const type = (el as HTMLInputElement).type || '';
  const sensitive = type === 'password' || /card|cc-|cvv|cvc|iban|pin/i.test((el.getAttribute('autocomplete') || '') + ' ' + (el.getAttribute('name') || '') + ' ' + (el.id || ''));
  // phrased for the confirmation question shown to the user ("Нажать кнопку «Купить»?")
  const tag = el.tagName.toLowerCase(), role = el.getAttribute('role');
  const kind = tag === 'a' || role === 'link' ? 'ссылку' : tag === 'button' || role === 'button' || type === 'submit' || type === 'button' ? 'кнопку'
    : tag === 'select' ? 'список' : type === 'checkbox' ? 'флажок' : type === 'radio' ? 'переключатель' : tag === 'input' || tag === 'textarea' || el.isContentEditable ? 'поле' : 'элемент';
  return { ok: true, message: label ? `${kind} «${label}»` : kind, password: sensitive };
}

export function click(args: ActArgs): ActResult {
  const el = document.querySelector(`[data-claude-id="${CSS.escape(args.id)}"]`) as HTMLElement | null;
  if (!el) return { ok: false, message: `No element [${args.id}] on the page any more. Call get_page again.` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus({ preventScroll: true });
  const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o));
  el.click();
  return { ok: true, message: `Clicked [${args.id}].` };
}

export function typeText(args: ActArgs): ActResult {
  const el = document.querySelector(`[data-claude-id="${CSS.escape(args.id)}"]`) as HTMLElement | null;
  if (!el) return { ok: false, message: `No element [${args.id}] on the page any more. Call get_page again.` };
  const text = args.text ?? '';
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (el instanceof HTMLSelectElement) {
    const opt = Array.from(el.options).find((o) => o.value === text || o.text.trim().toLowerCase() === text.trim().toLowerCase());
    if (!opt) return { ok: false, message: `No option "${text}" in [${args.id}]. Options: ${Array.from(el.options).map((o) => o.text.trim()).join(' | ')}` };
    el.value = opt.value;
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // the native setter, so frameworks that track the value (React and similar) see the change
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text);
  } else if (el.isContentEditable) {
    el.textContent = text;
  } else return { ok: false, message: `[${args.id}] is not a text field or a list.` };
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (args.submit) {
    const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const go = el.dispatchEvent(new KeyboardEvent('keydown', k));
    el.dispatchEvent(new KeyboardEvent('keypress', k)); el.dispatchEvent(new KeyboardEvent('keyup', k));
    const form = (el as HTMLInputElement).form;
    if (go && form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
  }
  return { ok: true, message: `Typed into [${args.id}]${args.submit ? ' and pressed Enter' : ''}.` };
}

export interface ScrollArgs { direction: 'up' | 'down' | 'top' | 'bottom' }
export function scrollPage(args: ScrollArgs): ActResult {
  const step = innerHeight * 0.85;
  if (args.direction === 'down') scrollBy(0, step);
  else if (args.direction === 'up') scrollBy(0, -step);
  else if (args.direction === 'top') scrollTo(0, 0);
  else scrollTo(0, document.documentElement.scrollHeight);
  const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  return { ok: true, message: `Scrolled ${args.direction}; now at ${Math.round((scrollY / max) * 100)}%.` };
}
