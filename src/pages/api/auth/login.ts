import type { APIRoute } from 'astro';
import { getEnv } from '../../../lib/env';
import { NEXT_COOKIE, STATE_COOKIE, sanitizeNextPath } from '../../../lib/session';

export const prerender = false;

const STATE_MAX_AGE = 600; // 10 分钟

function randomState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * GET /api/auth/login → 302 跳到 GitHub OAuth 授权页。
 * state 存短期 httpOnly cookie，callback 时校验防 CSRF。
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);
  if (!env.GITHUB_CLIENT_ID) {
    return Response.json({ ok: false, error: '服务端未配置 GITHUB_CLIENT_ID' }, { status: 500 });
  }

  const state = randomState();
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/auth/callback`;
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('scope', 'repo');
  authorize.searchParams.set('state', state);

  const isHttps = url.protocol === 'https:';
  const shortCookie = (name: string, value: string) => [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${STATE_MAX_AGE}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(isHttps ? ['Secure'] : []),
  ].join('; ');

  // 自愈跳转带回的原页面（会话死了由 middleware 跳来），授权成功后由 callback 跳回原页
  const next = sanitizeNextPath(url.searchParams.get('next'));

  const headers = new Headers();
  headers.set('Location', authorize.toString());
  headers.append('set-cookie', shortCookie(STATE_COOKIE, state));
  headers.append('set-cookie', shortCookie(NEXT_COOKIE, encodeURIComponent(next)));
  return new Response(null, { status: 302, headers });
};
