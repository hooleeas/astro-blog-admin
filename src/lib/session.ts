/**
 * 会话 cookie 签发 / 校验（middleware、登录、退出共用）。
 *
 * Cookie 值格式：`v1.<ts>.<hmacHex>`
 * hmac = HMAC-SHA256(ADMIN_PASSWORD, `v1.<ts>`)，全程 Web Crypto（crypto.subtle），
 * Workers 与 Node 通用。比较使用恒定时间比较，防时序攻击。
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

/** 恒定时间字符串比较（防时序攻击）。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 签发一个会话 cookie 值。 */
export async function signSession(password: string): Promise<string> {
  const ts = String(Date.now());
  const payload = `v1.${ts}`;
  const mac = await hmacSha256Hex(password, payload);
  return `${payload}.${mac}`;
}

/** 校验会话 cookie 值是否合法且未过期。 */
export async function verifySession(
  value: string | undefined,
  password: string | undefined
): Promise<boolean> {
  if (!value || !password) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const [, ts, mac] = parts;
  const issuedAt = Number(ts);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false;
  if (Date.now() - issuedAt > SESSION_TTL_MS) return false; // 过期
  if (Date.now() - issuedAt < -5 * 60 * 1000) return false; // 时钟漂移容差 5 分钟
  const expected = await hmacSha256Hex(password, `v1.${ts}`);
  return timingSafeEqual(mac, expected);
}

export const SESSION_COOKIE = 'admin_session';
export const SESSION_MAX_AGE = 7 * 24 * 3600; // 7 天（秒）
