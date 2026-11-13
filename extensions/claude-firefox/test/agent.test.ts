// Agent loop against a scripted model: the protocol rules that make or break a real session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent, AgentEvent, CallModel, ToolHost, ModelRequest } from '../src/agent';
import { TOOLS } from '../src/tools';

type Msg = Anthropic.Beta.BetaMessage;
const reply = (content: unknown[], stop_reason: string, extra: object = {}): Msg =>
  ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: {}, ...extra } as unknown as Msg);
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

function setup(script: ((req: ModelRequest) => Msg | Error)[], opts: { confirmAnswer?: boolean; confirmAll?: boolean; onRun?: (name: string) => void } = {}) {
  const events: AgentEvent[] = [], ran: string[] = [], requests: ModelRequest[] = [];
  const host: ToolHost = {
    tools: TOOLS,
    validate: (name, input) => (name === 'click' && typeof (input as { id?: unknown }).id !== 'string' ? '"id" must be string' : null),
    needsConfirmation: async (name) => (opts.confirmAll && name === 'click' ? 'Нажать?' : null),
    run: async (name, input) => { ran.push(name + JSON.stringify(input)); opts.onRun?.(name); return { content: name === 'get_page' ? 'URL: x\n[1] button "OK"' : 'done' }; },
    summarize: (name) => name,
  };
  let i = 0;
  const callModel: CallModel = async (req, onText) => {
    // the loop mutates its history afterwards: keep a copy of what was sent
    requests.push(structuredClone(req));
    const step = script[i++];
    if (!step) throw new Error('script exhausted');
    const r = step(req);
    if (r instanceof Error) throw r;
    for (const b of r.content) if (b.type === 'text') onText(b.text);
    return r;
  };
  const agent = new Agent({ system: 'sys', host, callModel, emit: (e) => events.push(e), confirm: async () => opts.confirmAnswer ?? true, isApiError: (e) => (e as Error).message.startsWith('API') });
  return { agent, events, ran, requests };
}

test('runs tools until Claude answers, and every tool_use gets its tool_result in one user message', async () => {
  const { agent, ran, requests, events } = setup([
    () => reply([text('Смотрю.'), use('t1', 'get_page', {}), use('t2', 'scroll', { direction: 'down' })], 'tool_use'),
    () => reply([use('t3', 'click', { id: '1' })], 'tool_use'),
    () => reply([text('Готово.')], 'end_turn'),
  ]);
  await agent.send('нажми OK');
  assert.deepEqual(ran, ['get_page{}', 'scroll{"direction":"down"}', 'click{"id":"1"}']);
  const second = requests[1].messages;
  assert.equal(second.length, 3);
  const results = second[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
  assert.deepEqual(results.map((r) => r.tool_use_id), ['t1', 't2']);
  assert.equal(agent.messages.length, 6);                 // user, assistant, results, assistant, results, assistant
  assert.ok(events.some((e) => e.type === 'text' && e.delta === 'Готово.'));
  assert.ok(!agent.busy);
});

test('the assistant content goes back unchanged (thinking and fallback blocks included)', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
  const { agent, requests } = setup([
    () => reply([thinking, use('t1', 'get_page', {})], 'tool_use'),
    () => reply([text('ok')], 'end_turn'),
  ]);
  await agent.send('x');
  assert.deepEqual((requests[1].messages[1].content as unknown[])[0], thinking);
});

test('invalid tool input is not run and comes back as an error result', async () => {
  const { agent, ran, requests } = setup([
    () => reply([use('t1', 'click', { id: 5 })], 'tool_use'),
    () => reply([text('ok')], 'end_turn'),
  ]);
  await agent.send('x');
  assert.deepEqual(ran, []);
  const r = (requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
  assert.equal(r.is_error, true);
  assert.match(String(r.content), /INVALID_INPUT/);
});

test('a denied confirmation does not run the action and tells Claude', async () => {
  const { agent, ran, requests, events } = setup([
    () => reply([use('t1', 'click', { id: '1' })], 'tool_use'),
    () => reply([text('Хорошо, не нажимаю.')], 'end_turn'),
  ], { confirmAll: true, confirmAnswer: false });
  await agent.send('x');
  assert.deepEqual(ran, []);
  const r = (requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
  assert.equal(r.is_error, true);
  assert.ok(events.some((e) => e.type === 'tool' && e.status === 'denied'));
});

test('tool calls cut off by max_tokens are answered with an error, not run', async () => {
  const { agent, ran, requests } = setup([
    () => reply([use('t1', 'type_text', { id: '1', text: 'полов' })], 'max_tokens'),
    () => reply([text('ok')], 'end_turn'),
  ]);
  await agent.send('x');
  assert.deepEqual(ran, []);
  assert.match(String((requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[])[0].content), /cut off/);
});

test('a refusal is reported and kept out of the history (no unanswered tool_use)', async () => {
  const { agent, ran, events } = setup([
    () => reply([use('t1', 'click', { id: '1' })], 'refusal', { stop_details: { type: 'refusal', category: null, explanation: null } }),
  ]);
  await agent.send('x');
  assert.deepEqual(ran, []);
  assert.equal(agent.messages.length, 1);
  assert.ok(events.some((e) => e.type === 'error' && /отказался/.test(e.message)));
});

test('API errors stop the turn and are shown; unparseable tool JSON is retried', async () => {
  const a = setup([() => new Error('API 401 invalid x-api-key')]);
  await a.agent.send('x');
  assert.ok(a.events.some((e) => e.type === 'error' && /401/.test(e.message)));
  const b = setup([() => new SyntaxError('Unexpected end of JSON input'), () => reply([text('ok')], 'end_turn')]);
  await b.agent.send('x');
  assert.equal(b.requests.length, 2);
  assert.ok(!b.events.some((e) => e.type === 'error'));
});

test('stop() during a turn leaves a valid history: every started tool call is answered, no further model call', async () => {
  let agentRef: Agent | null = null;
  const { agent, ran, requests } = setup([
    () => reply([use('t1', 'get_page', {}), use('t2', 'click', { id: '1' })], 'tool_use'),
  ], { onRun: () => agentRef!.stop() });
  agentRef = agent;
  await agent.send('x');
  assert.deepEqual(ran, ['get_page{}']);                  // the second call is not run after the stop
  const last = agent.messages[agent.messages.length - 1];
  assert.equal(last.role, 'user');
  const results = last.content as Anthropic.Beta.BetaToolResultBlockParam[];
  assert.deepEqual(results.map((r) => r.tool_use_id), ['t1', 't2']);
  assert.match(String(results[1].content), /Cancelled/);
  assert.equal(requests.length, 1);
  assert.ok(!agent.busy);
});
