// Merge rules for two devices, and the Google token + Drive client against a local mock of Google's endpoints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { merge, memoryBlock, SyncData, Conversation, Note } from '../src/store';
import { DriveFile, exchangeCode, fresh, parseRedirect, authUrl, pkce, REDIRECT, GoogleConfig } from '../src/google';

const conv = (id: string, updated: number, extra: Partial<Conversation> = {}): Conversation =>
  ({ id, title: id, created: 0, updated, system: 's', messages: [], items: [], ...extra });
const note = (id: string, updated: number, extra: Partial<Note> = {}): Note => ({ id, text: id, created: updated, updated, ...extra });
const data = (c: Conversation[], n: Note[], settingsUpdated = 0): SyncData =>
  ({ v: 1, conversations: c, notes: n, settings: { model: 'm' + settingsUpdated, effort: 'medium', confirmActions: true, updated: settingsUpdated } });

test('merge: newest copy of each conversation and note wins, both sides are kept', () => {
  const now = 1e12;
  const a = data([conv('c1', 10, { title: 'old' }), conv('c2', 5)], [note('n1', 1)], 3);
  const b = data([conv('c1', 20, { title: 'new' }), conv('c3', 7)], [note('n2', 2)], 9);
  const m = merge(a, b, now);
  assert.deepEqual(m.conversations.map((c) => c.id), ['c1', 'c3', 'c2']);     // newest first
  assert.equal(m.conversations[0].title, 'new');
  assert.deepEqual(m.notes.map((n) => n.id), ['n1', 'n2']);
  assert.equal(m.settings!.model, 'm9');
  assert.deepEqual(merge(b, a, now).conversations.map((c) => c.id), ['c1', 'c3', 'c2']);   // order of arguments does not matter
});

test('merge: deletions sync (tombstones beat older live copies) and expire after 60 days', () => {
  const now = 100 * 86400e3;
  const local = data([conv('c1', now - 2000)], [note('n1', now - 2000)]);
  const remote = data([conv('c1', now - 1000, { deleted: true })], [note('n1', now - 1000, { deleted: true, text: '' })]);
  const m = merge(local, remote, now);
  assert.ok(m.conversations[0].deleted && m.notes[0].deleted);
  assert.equal(memoryBlock(m.notes), 'Your memory is empty.');
  const later = merge(m, null, now + 61 * 86400e3);
  assert.equal(merge(later, data([], []), now + 61 * 86400e3).conversations.length, 0);
});

test('merge keeps at most 40 live conversations', () => {
  const many = Array.from({ length: 50 }, (_, i) => conv('c' + i, i));
  const m = merge(data(many, []), data([], []));
  assert.equal(m.conversations.length, 40);
  assert.equal(m.conversations[0].id, 'c49');
});

test('memory block lists live notes with their ids', () => {
  assert.match(memoryBlock([note('a1', 1, { text: 'Город: Казань' }), note('b2', 2, { deleted: true })]), /<memory>\n\[a1\] Город: Казань\n<\/memory>/);
});

// ---------------------------------------------------------------- Google endpoints, mocked
let server: http.Server, cfg: GoogleConfig;
const drive: { content: string | null; id: string; tokens: string[] } = { content: null, id: 'file1', tokens: [] };
before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      const json = (code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/token') {
        const f = new URLSearchParams(raw);
        if (f.get('client_secret') !== 'sec') return json(401, { error: 'invalid_client' });
        if (f.get('grant_type') === 'authorization_code') {
          if (f.get('code') !== 'good' || !f.get('code_verifier') || f.get('redirect_uri') !== REDIRECT) return json(400, { error: 'invalid_grant' });
          const idt = 'h.' + Buffer.from(JSON.stringify({ email: 'me@gmail.com' })).toString('base64url') + '.s';
          return json(200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, id_token: idt });
        }
        if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'rt1') return json(200, { access_token: 'at2', expires_in: 3600 });
        return json(400, { error: 'invalid_grant' });
      }
      drive.tokens.push(String(req.headers.authorization));
      if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
        assert.equal(u.searchParams.get('spaces'), 'appDataFolder');
        return json(200, { files: drive.content ? [{ id: drive.id }] : [] });
      }
      if (u.pathname === `/drive/v3/files/${drive.id}` && u.searchParams.get('alt') === 'media') return res.end(drive.content);
      if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
        assert.match(String(req.headers['content-type']), /multipart\/related; boundary=/);
        assert.match(raw, /"parents":\["appDataFolder"\]/);
        drive.content = raw.split('\r\n\r\n')[2].split('\r\n--')[0];
        return json(200, { id: drive.id });
      }
      if (u.pathname === `/upload/drive/v3/files/${drive.id}` && req.method === 'PATCH') { drive.content = raw; return json(200, { id: drive.id }); }
      json(404, { error: { message: 'not found' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const b = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cfg = { clientId: 'cid', clientSecret: 'sec', authUrl: b + '/auth', tokenUrl: b + '/token', apiUrl: b + '/drive/v3', uploadUrl: b + '/upload/drive/v3' };
});
after(() => { server.close(); });

test('sign-in URL carries PKCE, offline access and only the appdata scope; the redirect is parsed and checked', async () => {
  const { verifier, challenge } = await pkce();
  assert.ok(verifier.length >= 43 && !/[+/=]/.test(challenge));
  const u = new URL(authUrl(cfg, challenge, 'st8'));
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/drive.appdata');
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
  assert.deepEqual(parseRedirect(REDIRECT + '?code=abc&state=st8', 'st8'), { code: 'abc' });
  assert.deepEqual(parseRedirect(REDIRECT + '?error=access_denied&state=st8', 'st8'), { error: 'access_denied' });
  assert.deepEqual(parseRedirect(REDIRECT + '?code=abc&state=evil', 'st8'), { error: 'state mismatch' });
  assert.equal(parseRedirect('https://example.com/?code=1', 'st8'), null);
});

test('code exchange, token refresh, and the Drive file: create, read back, update', async () => {
  const t = await exchangeCode(cfg, 'good', 'v'.repeat(43));
  assert.equal(t.email, 'me@gmail.com');
  assert.equal(t.refresh_token, 'rt1');
  const refreshed = await fresh(cfg, { ...t, expires_at: 0 });
  assert.equal(refreshed.access_token, 'at2');
  assert.equal((await fresh(cfg, t)).access_token, 'at1');            // still valid: no request
  await assert.rejects(exchangeCode({ ...cfg, clientSecret: 'bad' }, 'good', 'v'.repeat(43)), /invalid_client/);

  const f = new DriveFile(cfg, async () => 'at2');
  assert.equal(await f.read(), null);
  await f.write({ v: 1, notes: [{ id: 'x' }] });
  assert.deepEqual(await new DriveFile(cfg, async () => 'at2').read(), { v: 1, notes: [{ id: 'x' }] });
  await f.write({ v: 1, notes: [] });
  assert.deepEqual(await new DriveFile(cfg, async () => 'at2').read(), { v: 1, notes: [] });
  assert.ok(drive.tokens.every((h) => h === 'Bearer at2'));
});
