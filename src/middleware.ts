import { defineMiddleware } from 'astro:middleware';
import { getEnv } from './lib/env';
import {
  ATTEMPT_COOKIE,
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
 * - v2 无 refresh_token 的会话：accessExp 当验活有效期用，过期才向 GitHub 验活一次，死了同样按会话死亡处理
 * - 会话刚死（吊销/续期失败/验活不过）且是后台页面：不劳用户手动重登，直接 302 到 /api/auth/login
 *   走一遍 OAuth 自愈回原页（应用已授权时全程无感）；60 秒内刚跳过一次则回 /login 防循环
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
    // 根路径是公开图床页（访客上传），后台在 /posts 等子路径
    path === '/' ||
    path === '/login' ||
    path === '/api/auth/login' ||
    path === '/api/auth/callback' ||
    path === '/favicon.ico' ||
    // 公开图床页及其上传接口（只能上传，不能管理与设置）
    path === '/upload' ||
    path === '/api/public-upload' ||
    path === '/api/public-config' ||
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
    ['/admin', '/posts', '/notes', '/pages', '/data', '/images', '/settings'].some(
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
  let sessionDied = false; // 本来有会话、但令牌刚被判定死亡（与从未登录区分，自愈跳转只对它触发）

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
        sessionDied = true;
        pendingCookie = sessionCookieHeader('', isHttps, null);
      }
    } else if (session.version === 2 && !session.refreshToken) {
      // 无 refresh_token 的 v2 会话没有到期信息可依：accessExp 当「验活有效期」用，
      // 为 0 或已过才向 GitHub 验活一次（活着就把有效期顺延 15 分钟，避免每请求都打 GitHub）
      if (!session.accessExp || Date.now() > session.accessExp) {
        const alive = await validateToken(session.accessToken);
        if (alive === true) {
          pendingCookie = sessionCookieHeader(
            await signSessionV2(secret, session.accessToken, '', Date.now() + 15 * 60 * 1000),
            isHttps,
            SESSION_MAX_AGE
          );
        } else if (alive === false) {
          token = null;
          sessionDied = true;
          pendingCookie = sessionCookieHeader('', isHttps, null);
        }
        // alive === null（网络问题等）→ 放行且不动 cookie，下次再验
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
        sessionDied = true;
        pendingCookie = sessionCookieHeader('', isHttps, null);
      }
      // alive === null（网络问题等）→ 放行且不动 cookie，下次再验
    }
    if (session.version === 2 && !pendingCookie && Date.now() - session.issuedAt > 24 * 3600 * 1000) {
      // 滚动续签：cookie 的 7 天 TTL 从签发算起，本轮没触发 token 续期时，
      // cookie 超过 1 天就用同一载荷重签（刷新签发时间），天天用就不会被 cookie 到期踢出（用户令「以后别再弹」）
      pendingCookie = sessionCookieHeader(
        await signSessionV2(secret, session.accessToken, session.refreshToken, session.accessExp),
        isHttps,
        SESSION_MAX_AGE
      );
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
    if (sessionDied) {
      // 会话刚死：直接跳一遍 OAuth 自愈回原页，不让用户自己找重登入口（用户嫌手动太麻烦）；
      // 60 秒内刚自愈跳过一次又死，说明光靠跳解决不了，回登录页明示，防无限循环
      const attemptTs = Number(context.cookies.get(ATTEMPT_COOKIE)?.value || 0);
      const attemptedRecently = Number.isFinite(attemptTs) && Date.now() - attemptTs < 60_000;
      if (!attemptedRecently) {
        const reqUrl = new URL(context.request.url);
        const res = context.redirect(
          `/api/auth/login?next=${encodeURIComponent(reqUrl.pathname + reqUrl.search)}`
        );
        if (pendingCookie) res.headers.append('set-cookie', pendingCookie);
        res.headers.append('set-cookie', [
          `${ATTEMPT_COOKIE}=${Date.now()}`,
          'Path=/',
          'Max-Age=60',
          'HttpOnly',
          'SameSite=Lax',
          ...(isHttps ? ['Secure'] : []),
        ].join('; '));
        return res;
      }
    }
    return withCookie(context.redirect('/login'));
  }

  (context.locals as any).githubToken = token;
  return withCookie(await next());
});
