// The browser tools Claude can call, and how they run in Firefox (tabs.* + scripts injected into the page).
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolHost, ToolOutcome } from './agent';
import { snapshot, describe, click, typeText, scrollPage } from './page';

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const tool = (name: string, description: string, input_schema: ReturnType<typeof obj>): Anthropic.Beta.BetaTool =>
  ({ name, description, input_schema, strict: true, eager_input_streaming: true });

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  tool('get_page', 'Read the current tab: URL, title, visible text and a numbered list of interactive elements ([id] kind "label"). Call it before acting on a page and again after anything that changes the page; element ids are only valid for the page you read them from.', obj({}, [])),
  tool('click', 'Click the element with this id from the last get_page.', obj({ id: { type: 'string', description: 'element id from get_page, e.g. "12"' } }, ['id'])),
  tool('type_text', 'Put text into a text field (replacing what is there), or choose an option in a drop-down list by its text. Set submit to press Enter afterwards (e.g. to run a search).', obj({ id: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['id', 'text', 'submit'])),
  tool('scroll', 'Scroll the current tab.', obj({ direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] } }, ['direction'])),
  tool('navigate', 'Open a URL in the current tab. A plain phrase that is not a URL is searched for.', obj({ url: { type: 'string' } }, ['url'])),
  tool('go_back', 'Go back to the previous page in the current tab.', obj({}, [])),
  tool('list_tabs', 'List the open tabs with their ids; the current one is marked.', obj({}, [])),
  tool('switch_tab', 'Make another open tab the current one (what get_page and the other tools act on).', obj({ tab_id: { type: 'integer' } }, ['tab_id'])),
  tool('open_tab', 'Open a URL in a new tab and make it the current one.', obj({ url: { type: 'string' } }, ['url'])),
];

/** Mutating actions that ask the user first when confirmations are on (typing into password / card fields always asks). */
const ACTIONS = new Set(['click', 'type_text', 'navigate', 'go_back', 'open_tab']);

export interface Settings { apiKey: string; model: string; effort: 'low' | 'medium' | 'high'; confirmActions: boolean; /** only for the end-to-end test's mock API */ baseURL?: string }

/** Runs a self-contained page function in a tab and returns its result. */
async function inPage<A, R>(tabId: number, fn: (a: A) => R, args: A): Promise<R> {
  const [r] = await browser.tabs.executeScript(tabId, { code: `(${fn.toString()})(${JSON.stringify(args)})` });
  return r as R;
}

function toUrl(s: string): string {
  const t = s.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  if (/^[^\s]+\.[a-z]{2,}(\/|$|:|\?)/i.test(t)) return 'https://' + t;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(t);
}

export class BrowserHost implements ToolHost {
  tools = TOOLS;
  constructor(private target: { get(): Promise<number | null>; set(id: number): void }, private settings: () => Settings) {}

  private async tab(): Promise<number> {
    const id = await this.target.get();
    if (id == null) throw new Error('There is no web page tab open. Use open_tab or navigate.');
    return id;
  }

  /** wait until the tab has finished loading (navigation after a click may take a moment to start) */
  private async settle(tabId: number, ms = 9000) {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 400));
    while (Date.now() - t0 < ms) {
      const t = await browser.tabs.get(tabId).catch(() => null);
      if (!t || t.status === 'complete') return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  validate(name: string, input: unknown): string | null {
    const t = TOOLS.find((x) => x.name === name);
    if (!t) return `unknown tool ${name}`;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
    const schema = t.input_schema as { properties: Record<string, { type: string; enum?: string[] }>; required: string[] };
    const o = input as Record<string, unknown>;
    for (const k of schema.required) if (!(k in o)) return `missing "${k}"`;
    for (const [k, v] of Object.entries(o)) {
      const p = schema.properties[k];
      if (!p) return `unexpected "${k}"`;
      const ok = p.type === 'integer' ? Number.isInteger(v) : typeof v === p.type;
      if (!ok) return `"${k}" must be ${p.type}`;
      if (p.enum && !p.enum.includes(v as string)) return `"${k}" must be one of ${p.enum.join(', ')}`;
    }
    return null;
  }

  summarize(name: string, i: Record<string, unknown>): string {
    switch (name) {
      case 'get_page': return 'Читаю страницу';
      case 'click': return `Нажимаю [${i.id}]`;
      case 'type_text': return `Ввожу в [${i.id}]: «${String(i.text).slice(0, 60)}»${i.submit ? ' + Enter' : ''}`;
      case 'scroll': return `Прокрутка: ${i.direction}`;
      case 'navigate': return `Открываю ${toUrl(String(i.url))}`;
      case 'go_back': return 'Назад';
      case 'list_tabs': return 'Список вкладок';
      case 'switch_tab': return `Вкладка ${i.tab_id}`;
      case 'open_tab': return `Новая вкладка: ${toUrl(String(i.url))}`;
      default: return name;
    }
  }

  async needsConfirmation(name: string, i: Record<string, unknown>): Promise<string | null> {
    let sensitive = false, what = '';
    if (name === 'click' || name === 'type_text') {
      const d = await inPage(await this.tab(), describe, { id: String(i.id) }).catch(() => null);
      if (d?.ok) { what = d.message; sensitive = !!d.password; }
    }
    if (name === 'type_text' && sensitive) return `Ввести данные в защищённое поле ${what}? Claude хочет ввести: «${String(i.text)}».`;
    if (!this.settings().confirmActions || !ACTIONS.has(name)) return null;
    if (name === 'click') return `Нажать ${what || '[' + i.id + ']'}?`;
    if (name === 'type_text') return `Ввести «${String(i.text)}» в ${what || '[' + i.id + ']'}${i.submit ? ' и нажать Enter' : ''}?`;
    return this.summarize(name, i) + '?';
  }

  async run(name: string, i: Record<string, unknown>): Promise<ToolOutcome> {
    const fail = (content: string): ToolOutcome => ({ content, isError: true });
    switch (name) {
      case 'get_page': {
        const tabId = await this.tab();
        const s = await inPage(tabId, snapshot, { maxText: 12000, maxElements: 250 }).catch((e) => { throw new Error(`Cannot read this page (${(e as Error).message}). Browser pages like about: and the add-on store are off limits.`); });
        // the page is untrusted: fence it so instructions written on it are read as content, not as commands
        return { content: `URL: ${s.url}\nTitle: ${s.title}\nScroll: ${s.scroll}\n\n<page_text>\n${s.text}\n</page_text>\n\n<interactive_elements>\n${s.elements || '(none visible)'}\n</interactive_elements>` };
      }
      case 'click': {
        const tabId = await this.tab();
        const r = await inPage(tabId, click, { id: String(i.id) });
        if (!r.ok) return fail(r.message);
        await this.settle(tabId);
        const t = await browser.tabs.get(tabId);
        return { content: `${r.message} Now at: ${t.url} (${t.title}). Call get_page to see the result.` };
      }
      case 'type_text': {
        const tabId = await this.tab();
        const r = await inPage(tabId, typeText, { id: String(i.id), text: String(i.text), submit: !!i.submit });
        if (!r.ok) return fail(r.message);
        if (i.submit) await this.settle(tabId);
        return { content: r.message };
      }
      case 'scroll': {
        const r = await inPage(await this.tab(), scrollPage, { direction: i.direction as 'up' | 'down' | 'top' | 'bottom' });
        return { content: r.message };
      }
      case 'navigate': {
        const url = toUrl(String(i.url));
        const id = await this.target.get();
        let tabId: number;
        if (id == null) { tabId = (await browser.tabs.create({ url, active: false })).id!; this.target.set(tabId); }
        else { tabId = id; await browser.tabs.update(tabId, { url }); }
        await this.settle(tabId, 15000);
        const t = await browser.tabs.get(tabId);
        return { content: `Opened ${t.url} (${t.title}). Call get_page to read it.` };
      }
      case 'go_back': {
        const tabId = await this.tab();
        await browser.tabs.executeScript(tabId, { code: 'history.back()' });
        await this.settle(tabId);
        const t = await browser.tabs.get(tabId);
        return { content: `Now at ${t.url} (${t.title}).` };
      }
      case 'list_tabs': {
        const cur = await this.target.get();
        const tabs = (await browser.tabs.query({})).filter((t) => /^https?:/.test(t.url || ''));
        return { content: tabs.map((t) => `${t.id === cur ? '* ' : '  '}${t.id}: ${t.title} — ${t.url}`).join('\n') || '(no web pages open)' };
      }
      case 'switch_tab': {
        const t = await browser.tabs.get(i.tab_id as number).catch(() => null);
        if (!t || !/^https?:/.test(t.url || '')) return fail(`No web page tab with id ${i.tab_id}.`);
        this.target.set(t.id!);
        return { content: `Current tab: ${t.title} — ${t.url}` };
      }
      case 'open_tab': {
        const t = await browser.tabs.create({ url: toUrl(String(i.url)), active: false });
        this.target.set(t.id!);
        await this.settle(t.id!, 15000);
        const u = await browser.tabs.get(t.id!);
        return { content: `Opened tab ${u.id}: ${u.url} (${u.title}). Call get_page to read it.` };
      }
    }
    return fail(`unknown tool ${name}`);
  }
}
