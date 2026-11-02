import type { APIRoute } from 'astro';
import { getEnv } from '../../../lib/env';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  STATE_COOKIE,
  signSessionV2,
  timingSafeEqual,
} from '../../../lib/session';

export const prerender = false;

function cookieHeader(
  name: string,
  value: string,
  isHttps: boolean,
  maxAge: number | null
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    maxAge === null ? 'Max-Age=0' : `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(isHttps ? ['Secure'] : []),
  ].join('; ');
}

/**
 * GET /api/auth/callback?code=…&state=…
 * 校验 state → 用 code 换 access_token → 查 /user 校验是仓库主人 →
 * 签发会话 cookie（载荷带 GitHub token）→ 302 到 /admin。
 */
export const GET: APIRoute = async ({ request, cookies, locals }) => {
  const env = getEnv(locals);
  const url = new URL(request.url);
  const isHttps = url.protocol === 'https:';

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return Response.json(
      { ok: false, error: '服务端未配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET' },
      { status: 500 }
    );
  }

  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const savedState = cookies.get(STATE_COOKIE)?.value || '';

  if (!code || !state || !timingSafeEqual(state, savedState)) {
    return Response.json({ ok: false, error: 'state 校验失败' }, { status: 403 });
  }

  // 用 code 换 access_token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/auth/callback`,
    }),
  });
  if (!tokenRes.ok) {
    return Response.json({ ok: false, error: 'GitHub 换 token 失败' }, { status: 502 });
  }
  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  const accessToken = tokenData.access_token || '';
  if (!accessToken) {
    return Response.json(
      { ok: false, error: `GitHub 未返回 token：${tokenData.error || '未知错误'}` },
      { status: 502 }
    );
  }
  // 应用开启 token 过期时 GitHub 会同时给 refresh_token 与 expires_in（秒）
  const refreshToken = tokenData.refresh_token || '';
  const accessExp = tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : 0;

  // 查登录用户，必须是仓库主人
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'astro-blog-admin',
    },
  });
  if (!userRes.ok) {
    return Response.json({ ok: false, error: `GitHub 取用户信息失败（${userRes.status}）` }, { status: 502 });
  }
  const userData = (await userRes.json()) as { login?: string };
  const owner = env.GITHUB_OWNER || 'hooleeas';
  if (userData.login !== owner) {
    return Response.json({ ok: false, error: '该 GitHub 账号无管理权限' }, { status: 403 });
  }

  // 签发 v2 会话（HMAC 密钥用 GITHUB_CLIENT_SECRET，载荷带 access/refresh/过期时间）
  const sessionValue = await signSessionV2(env.GITHUB_CLIENT_SECRET, accessToken, refreshToken, accessExp);

  const headers = new Headers();
  headers.set('Location', '/admin');
  headers.append('set-cookie', cookieHeader(SESSION_COOKIE, sessionValue, isHttps, SESSION_MAX_AGE));
  headers.append('set-cookie', cookieHeader(STATE_COOKIE, '', isHttps, null)); // 清掉 state
  return new Response(null, { status: 302, headers });
};
