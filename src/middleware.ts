import { defineMiddleware } from 'astro:middleware';
import { getEnv } from './lib/env';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  getSession,
  signSessionV2,
} from './lib/session';

/**
 * 全局守卫（后台直接挂在根路径 /）：
 * - 放行：/login、/api/auth/login、/api/auth/callback、/favicon.ico、以 /_astro/ 开头的静态资源
 * - 本地显式预览模式只在 loopback 地址放行页面与 API
 * - /api/* 需登录，未登录 → 401 {ok:false,error:'未登录'}
 * - 后台页面（/、/posts、/notes、/pages、/data、/images、/settings 及其子路径）需登录，未登录 → 302 跳 /login
 * - 未知路径放行，渲染公开 404（不跳登录）
 * - 登录后把 GitHub token 写入 locals.githubToken，供各 API 调 GitHub 用
 * - v2 会话：access_token 到期前用 refresh_token 自动续期并回写 cookie；续期失败按未登录处理
 * - v1 旧会话：一次性向 GitHub 校验 token 是否还活着——活着升级为 v2，已失效则清 cookie 强制重登
 */

function sessionCookieHeader(value: string, isHttps: boolean, maxAge: number | null): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    maxAge === null ? 'Max-Age=0' : `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(isHttps ? ['Secure'] : []),
  ].join('; ');
}

interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  accessExp: number;
}

/** 用 refresh_token 向 GitHub 换新 token 对；失败返回 null。 */
async function refreshTokens(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<RefreshedTokens | null> {
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!data.access_token || data.error) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      accessExp: data.expires_in ? Date.now() + data.expires_in * 1000 : 0,
    };
  } catch {
    return null;
  }
}

/** 校验 access_token 是否仍被 GitHub 接受：true 活着 / false 已失效 / null 无法判定（网络等）。 */
async function validateToken(token: string): Promise<boolean | null> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'astro-blog-admin',
      },
    });
    if (res.status === 200) return true;
    if (res.status === 401) return false;
    return null;
  } catch {
    return null;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const path = new URL(context.request.url).pathname;

  if (
    path === '/login' ||
    path === '/api/auth/login' ||
    path === '/api/auth/callback' ||
    path === '/favicon.ico' ||
    path.startsWith('/_astro/') ||
    // 图床图片文件公开可读（复制到文章里的链接要能直接打开）；/images 页面本身不在此列，仍需登录
    (path.startsWith('/images/') && path.length > '/images/'.length) ||
    // 自定义链接前缀的图片文件同样公开（前缀是否正确由 [prefix] 路由按设置校验，不对返回 404）
    (/^\/[^/]+\/[^/]+\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path) && !path.startsWith('/api/'))
  ) {
    return next();
  }

  // 旧 /admin/* 由 src/pages/admin/ 下的重定向桩处理（301 到新路径）

  // 后台页面路径（需登录）；未知路径放行，渲染公开 404
  const isAdminPage =
    path === '/' ||
    ['/posts', '/notes', '/pages', '/data', '/images', '/settings'].some(
      (p) => path === p || path.startsWith(p + '/')
    );

  const env = getEnv(context.locals);
  const hostname = new URL(context.request.url).hostname;
  const isLoopbackHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const isLocalPreview = import.meta.env.DEV && env.ADMIN_LOCAL_PREVIEW === 'true' && isLoopbackHost;
  if (isLocalPreview && (isAdminPage || path.startsWith('/api/'))) {
    return next();
  }

  const isHttps = new URL(context.request.url).protocol === 'https:';
  const secret = env.GITHUB_CLIENT_SECRET;
  const session = await getSession(context.cookies.get(SESSION_COOKIE)?.value, secret);

  let token: string | null = null;
  let pendingCookie: string | null = null; // 需要回写到响应上的会话 cookie

  if (session) {
    token = session.accessToken;
    if (
      session.version === 2 &&
      session.refreshToken &&
      session.accessExp &&
      Date.now() > session.accessExp - 60_000
    ) {
      // access_token 已过期或即将过期 → 续期
      const refreshed =
        env.GITHUB_CLIENT_ID && secret
          ? await refreshTokens(env.GITHUB_CLIENT_ID, secret, session.refreshToken)
          : null;
      if (refreshed) {
        token = refreshed.accessToken;
        pendingCookie = sessionCookieHeader(
          await signSessionV2(secret, refreshed.accessToken, refreshed.refreshToken, refreshed.accessExp),
          isHttps,
          SESSION_MAX_AGE
        );
      } else {
        // 续期失败（如 refresh_token 也失效）→ 清会话，按未登录处理
        token = null;
        pendingCookie = sessionCookieHeader('', isHttps, null);
      }
    } else if (session.version === 1) {
      // 旧会话只存了 access_token 且无过期信息，一次性校验其有效性
      const alive = await validateToken(session.accessToken);
      if (alive === true) {
        // 升级为 v2（无 refresh_token 时 accessExp 记 0，后续不再重复校验）
        pendingCookie = sessionCookieHeader(
          await signSessionV2(secret, session.accessToken, '', 0),
          isHttps,
          SESSION_MAX_AGE
        );
      } else if (alive === false) {
        token = null;
        pendingCookie = sessionCookieHeader('', isHttps, null);
      }
      // alive === null（网络问题等）→ 放行且不动 cookie，下次再验
    }
  }

  const withCookie = (res: Response): Response => {
    if (pendingCookie) res.headers.append('set-cookie', pendingCookie);
    return res;
  };

  if (!token) {
    if (path.startsWith('/api/')) {
      return withCookie(
        new Response(JSON.stringify({ ok: false, error: '未登录' }), {
          status: 401,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      );
    }
    if (!isAdminPage) return withCookie(await next()); // 公开 404，不跳登录
    return withCookie(context.redirect('/login'));
  }

  (context.locals as any).githubToken = token;
  return withCookie(await next());
});
