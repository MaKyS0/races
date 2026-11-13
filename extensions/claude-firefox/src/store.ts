// What the extension keeps and syncs: conversations, Claude's memory notes and the settings, plus the merge rule used
// when another device has written to Google Drive. Pure data and functions (no browser.*), so the merge is unit-tested.
import type Anthropic from '@anthropic-ai/sdk';

export type Item = { kind: 'user' | 'assistant' | 'error'; text: string } | { kind: 'tool'; id: string; summary: string; status: string; detail?: string };

export interface Conversation {
  id: string; title: string; created: number; updated: number;
  /** the system prompt is frozen per conversation (memory as it was when the conversation started) */
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  items: Item[];
  /** tombstone: deleted on some device; kept so the deletion syncs */
  deleted?: boolean;
}
export interface Note { id: string; text: string; created: number; updated: number; deleted?: boolean }
export interface SyncedSettings { model: string; effort: 'low' | 'medium' | 'high'; confirmActions: boolean; apiKey?: string; updated: number }
export interface SyncData { v: 1; settings?: SyncedSettings; notes: Note[]; conversations: Conversation[] }

export const MAX_CONVERSATIONS = 40;
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** newest version of each id wins; tombstones win over older live copies and are kept for 60 days */
function mergeById<T extends { id: string; updated: number; deleted?: boolean }>(a: T[], b: T[], now: number): T[] {
  const m = new Map<string, T>();
  for (const x of [...a, ...b]) {
    const cur = m.get(x.id);
    if (!cur || x.updated > cur.updated || (x.updated === cur.updated && x.deleted && !cur.deleted)) m.set(x.id, x);
  }
  return [...m.values()].filter((x) => !x.deleted || now - x.updated < 60 * 86400e3);
}

export function merge(local: SyncData, remote: SyncData | null, now = Date.now()): SyncData {
  if (!remote) return local;
  const settings = !remote.settings ? local.settings : !local.settings ? remote.settings
    : remote.settings.updated > local.settings.updated ? remote.settings : local.settings;
  const conversations = mergeById(local.conversations, remote.conversations, now)
    .sort((x, y) => y.updated - x.updated);
  // keep the newest live conversations (and every tombstone, which is tiny)
  let live = 0;
  const kept = conversations.filter((c) => c.deleted || ++live <= MAX_CONVERSATIONS);
  return { v: 1, settings, notes: mergeById(local.notes, remote.notes, now).sort((x, y) => x.created - y.created), conversations: kept };
}

/** what Claude sees of its memory at the start of a conversation */
export function memoryBlock(notes: Note[]): string {
  const live = notes.filter((n) => !n.deleted);
  if (!live.length) return 'Your memory is empty.';
  return 'Your memory (notes you saved earlier, on any of the user\'s devices):\n<memory>\n' + live.map((n) => `[${n.id}] ${n.text}`).join('\n') + '\n</memory>';
}

export function titleOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}
