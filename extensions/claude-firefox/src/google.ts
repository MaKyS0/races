// Google sign-in and the sync file on Google Drive.
// Sign-in: OAuth 2.0 authorization code + PKCE for an "installed app" client (the user's own Google Cloud client ID),
// redirecting to a loopback address. Nothing listens there: the extension catches the redirect with webRequest (and,
// as a fallback, tabs.onUpdated), reads the code from the URL and closes the tab. The browser.identity API that desktop
// Firefox offers for this does not exist on Firefox for Android.
// Storage: one JSON file in the Drive "appDataFolder" - a hidden per-app folder; the drive.appdata scope cannot see
// any of the user's own files.

export interface GoogleConfig {
  clientId: string; clientSecret: string;
  authUrl?: string; tokenUrl?: string; apiUrl?: string; uploadUrl?: string;   // overridable for tests
}
export interface GoogleTokens { access_token: string; refresh_token: string; expires_at: number; email: string }

export const REDIRECT = 'http://127.0.0.1:53682/oauth2';
export const SCOPES = 'openid email https://www.googleapis.com/auth/drive.appdata';
export const FILE_NAME = 'claude-browser-agent-sync.json';
const ep = (c: GoogleConfig) => ({
  auth: c.authUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth',
  token: c.tokenUrl ?? 'https://oauth2.googleapis.com/token',
  api: c.apiUrl ?? 'https://www.googleapis.com/drive/v3',
  upload: c.uploadUrl ?? 'https://www.googleapis.com/upload/drive/v3',
});

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

export function authUrl(c: GoogleConfig, challenge: string, state: string): string {
  const q = new URLSearchParams({
    client_id: c.clientId, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES,
    code_challenge: challenge, code_challenge_method: 'S256', state,
    access_type: 'offline', prompt: 'consent',          // consent every time so Google always returns a refresh token
  });
  return `${ep(c).auth}?${q}`;
}

/** the email from the id_token (no signature check needed: it came straight from Google's token endpoint over TLS) */
function emailOf(idToken?: string): string {
  try { return JSON.parse(atob(idToken!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email ?? ''; } catch { return ''; }
}

async function tokenRequest(c: GoogleConfig, body: Record<string, string>) {
  const r = await fetch(ep(c).token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google: ${j.error_description || j.error || r.status}`);
  return j as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };
}

export async function exchangeCode(c: GoogleConfig, code: string, verifier: string): Promise<GoogleTokens> {
  const j = await tokenRequest(c, { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: verifier });
  if (!j.refresh_token) throw new Error('Google не выдал refresh-токен. Попробуйте войти ещё раз.');
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000, email: emailOf(j.id_token) };
}

export async function fresh(c: GoogleConfig, t: GoogleTokens): Promise<GoogleTokens> {
  if (Date.now() < t.expires_at) return t;
  const j = await tokenRequest(c, { refresh_token: t.refresh_token, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token' });
  return { ...t, access_token: j.access_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
}

/** Parse the loopback redirect: the code, or Google's error ("access_denied" when the user pressed Cancel). */
export function parseRedirect(url: string, state: string): { code?: string; error?: string } | null {
  if (!url.startsWith(REDIRECT)) return null;
  const q = new URL(url).searchParams;
  if (q.get('state') !== state) return { error: 'state mismatch' };
  if (q.get('error')) return { error: q.get('error')! };
  return q.get('code') ? { code: q.get('code')! } : null;
}

// ---------------------------------------------------------------- Drive appDataFolder file
export class DriveFile {
  private id: string | null = null;
  constructor(private c: GoogleConfig, private token: () => Promise<string>) {}

  private async req(url: string, init: RequestInit = {}) {
    const r = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: 'Bearer ' + await this.token() } });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(`Google Drive ${r.status}: ${j.error?.message ?? r.statusText}`);
    }
    return r;
  }
  private async find(): Promise<string | null> {
    if (this.id) return this.id;
    const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name='${FILE_NAME}' and trashed=false`, fields: 'files(id,modifiedTime)', orderBy: 'modifiedTime desc' });
    const j = await (await this.req(`${ep(this.c).api}/files?${q}`)).json();
    return (this.id = j.files?.[0]?.id ?? null);
  }
  async read<T>(): Promise<T | null> {
    const id = await this.find();
    if (!id) return null;
    try { return await (await this.req(`${ep(this.c).api}/files/${id}?alt=media`)).json(); }
    catch (e) { if (/ 404:/.test(String(e))) { this.id = null; return null; } throw e; }
  }
  async write(data: unknown): Promise<void> {
    const body = JSON.stringify(data);
    const id = await this.find();
    if (id) { await this.req(`${ep(this.c).upload}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body }); return; }
    const boundary = 'b' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
    const multipart = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const j = await (await this.req(`${ep(this.c).upload}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: multipart })).json();
    this.id = j.id;
  }
}
