/**
 * 会话 cookie 签发 / 校验（middleware、登录、退出共用）。
 *
 * Cookie 值格式：`v1.<ts>.<b64urlToken>.<hmacHex>`
 * hmac = HMAC-SHA256(GITHUB_CLIENT_SECRET, `v1.<ts>.<b64urlToken>`)，
 * 全程 Web Crypto（crypto.subtle），Workers 与 Node 通用。比较使用恒定时间比较，防时序攻击。
 * token 即 GitHub OAuth 登录拿到的 access_token，用于服务端调 GitHub API。
 */

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天

async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** base64url 编码（Workers 无 Buffer） */
export function b64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url 解码 */
export function b64urlDecode(input: string): string {
  let b = input.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const binary = atob(b);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 恒定时间字符串比较（防时序攻击）。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 签发一个会话 cookie 值（载荷携带 GitHub OAuth token）。 */
export async function signSession(secret: string, token: string): Promise<string> {
  const ts = String(Date.now());
  const body = `v1.${ts}.${b64urlEncode(token)}`;
  const mac = await hmacSha256Hex(secret, body);
  return `${body}.${mac}`;
}

/**
 * 校验会话 cookie，合法且未过期则返回其中携带的 GitHub token，
 * 否则返回 null。
 */
export async function getSessionToken(
  value: string | undefined,
  secret: string | undefined
): Promise<string | null> {
  if (!value || !secret) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, ts, tokenB64, mac] = parts;
  const issuedAt = Number(ts);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;
  if (Date.now() - issuedAt > SESSION_TTL_MS) return null; // 过期
  if (Date.now() - issuedAt < -5 * 60 * 1000) return null; // 时钟漂移容差 5 分钟
  const expected = await hmacSha256Hex(secret, `v1.${ts}.${tokenB64}`);
  if (!timingSafeEqual(mac, expected)) return null;
  let token: string;
  try {
    token = b64urlDecode(tokenB64);
  } catch {
    return null;
  }
  return token || null;
}

/** 校验会话 cookie 值是否合法且未过期。 */
export async function verifySession(
  value: string | undefined,
  secret: string | undefined
): Promise<boolean> {
  return (await getSessionToken(value, secret)) !== null;
}

export const SESSION_COOKIE = 'admin_session';
export const SESSION_MAX_AGE = 7 * 24 * 3600; // 7 天（秒）

/** OAuth state 防 CSRF cookie（短期）。 */
export const STATE_COOKIE = 'oauth_state';
