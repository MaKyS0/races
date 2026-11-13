// The agent loop: one user message -> Claude -> browser tools -> Claude ... until it answers without a tool call.
// Kept free of browser.* and SDK calls (both are injected) so it can be tested with a scripted model in Node.
import type Anthropic from '@anthropic-ai/sdk';

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;
type Result = Anthropic.Beta.BetaToolResultBlockParam;

export interface ModelRequest { system: string; tools: Anthropic.Beta.BetaTool[]; messages: Msg[] }
/** One model turn; onText receives the reply text as it streams. Rejects with the SDK's errors. */
export type CallModel = (req: ModelRequest, onText: (delta: string) => void, signal: AbortSignal) => Promise<Anthropic.Beta.BetaMessage>;

export interface ToolOutcome { content: string; isError?: boolean }
export interface ToolHost {
  tools: Anthropic.Beta.BetaTool[];
  /** null = the input is fine; otherwise why it is not (the call is not run and Claude gets the reason) */
  validate(name: string, input: unknown): string | null;
  /** a sentence for the confirmation prompt, or null when the action needs no confirmation */
  needsConfirmation(name: string, input: Record<string, unknown>): Promise<string | null>;
  run(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
  /** short human-readable line for the chat log */
  summarize(name: string, input: Record<string, unknown>): string;
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'turn_end' }
  | { type: 'tool'; id: string; summary: string; status: 'running' | 'done' | 'error' | 'denied'; detail?: string }
  | { type: 'confirm'; id: string; question: string }
  | { type: 'error'; message: string }
  | { type: 'busy'; busy: boolean };

export interface AgentOptions {
  system: string;
  host: ToolHost;
  callModel: CallModel;
  emit: (e: AgentEvent) => void;
  /** resolves true when the user allows the action */
  confirm: (id: string, question: string) => Promise<boolean>;
  maxSteps?: number;
  /** errors that are API errors (auth, rate limit, ...) as opposed to unparseable tool input */
  isApiError: (e: unknown) => boolean;
}

export class Agent {
  messages: Msg[] = [];
  /** system prompt of the current conversation (set per conversation: it carries Claude's memory at that moment) */
  system: string;
  private abort: AbortController | null = null;
  constructor(private o: AgentOptions) { this.system = o.system; }

  get busy() { return this.abort !== null; }
  stop() { this.abort?.abort(); }
  reset() { this.stop(); this.messages = []; }
  /** continue an earlier conversation (from this device or synced from another) */
  load(messages: Msg[], system: string) { this.stop(); this.messages = messages; this.system = system; }

  async send(text: string): Promise<void> {
    if (this.abort) throw new Error('busy');
    const abort = this.abort = new AbortController();
    this.o.emit({ type: 'busy', busy: true });
    this.messages.push({ role: 'user', content: text });
    try { await this.loop(abort.signal); }
    finally { this.abort = null; this.o.emit({ type: 'busy', busy: false }); }
  }

  private async loop(signal: AbortSignal) {
    const max = this.o.maxSteps ?? 40;
    let jsonRetries = 0;
    for (let step = 0; step < max; step++) {
      if (signal.aborted) return;
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await this.o.callModel({ system: this.system, tools: this.o.host.tools, messages: this.messages }, (d) => this.o.emit({ type: 'text', delta: d }), signal);
      } catch (e) {
        this.o.emit({ type: 'turn_end' });
        if (signal.aborted) return;
        // tool input the SDK could not parse at all: ask again a couple of times; API errors go to the user as they are
        if (!this.o.isApiError(e) && jsonRetries++ < 2) continue;
        this.o.emit({ type: 'error', message: errorText(e) });
        return;
      }
      this.o.emit({ type: 'turn_end' });
      if (msg.stop_reason === 'refusal') {
        // a refused turn is not added to the history: it may hold a cut-off tool call that can never be answered
        this.o.emit({ type: 'error', message: 'Claude отказался выполнять этот запрос' + (msg.stop_details?.explanation ? ': ' + msg.stop_details.explanation : '.') });
        return;
      }
      this.messages.push({ role: 'assistant', content: msg.content as Block[] });
      const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (!calls.length) {
        if (msg.stop_reason === 'max_tokens') this.o.emit({ type: 'error', message: 'Ответ упёрся в ограничение длины и обрезан.' });
        return;
      }
      const results: Result[] = [];
      for (const call of calls) results.push(await this.runCall(call, msg.stop_reason === 'max_tokens', signal));
      this.messages.push({ role: 'user', content: results });
      if (signal.aborted) return;
    }
    this.o.emit({ type: 'error', message: `Остановлено после ${max} шагов. Напишите «продолжай», чтобы Claude продолжил.` });
  }

  private async runCall(call: Anthropic.Beta.BetaToolUseBlock, truncated: boolean, signal: AbortSignal): Promise<Result> {
    const res = (content: string, isError = false): Result => ({ type: 'tool_result', tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
    // every tool_use must get a tool_result, even when the call is not run, or the next request is rejected
    if (signal.aborted) return res('Cancelled by the user.', true);
    if (truncated) return res('The call was cut off by the output limit before its input was complete. Call the tool again.', true);
    const bad = this.o.host.validate(call.name, call.input);
    if (bad) return res(JSON.stringify({ INVALID_INPUT: bad, received: call.input }), true);
    const input = call.input as Record<string, unknown>;
    const summary = this.o.host.summarize(call.name, input);
    const question = await this.o.host.needsConfirmation(call.name, input);
    if (question) {
      this.o.emit({ type: 'tool', id: call.id, summary, status: 'running', detail: 'ждёт вашего решения' });
      const ok = await this.o.confirm(call.id, question);
      if (!ok || signal.aborted) {
        this.o.emit({ type: 'tool', id: call.id, summary, status: 'denied' });
        return res('The user did not allow this action. Ask them what to do instead, or try another way.', true);
      }
    }
    this.o.emit({ type: 'tool', id: call.id, summary, status: 'running' });
    try {
      const out = await this.o.host.run(call.name, input);
      this.o.emit({ type: 'tool', id: call.id, summary, status: out.isError ? 'error' : 'done', detail: out.isError ? out.content.slice(0, 200) : undefined });
      return res(out.content, !!out.isError);
    } catch (e) {
      this.o.emit({ type: 'tool', id: call.id, summary, status: 'error', detail: errorText(e) });
      return res('Tool failed: ' + errorText(e), true);
    }
  }
}

export function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
