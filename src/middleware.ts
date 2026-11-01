import { defineMiddleware } from 'astro:middleware';
import { getEnv } from './lib/env';
import { SESSION_COOKIE, getSessionToken } from './lib/session';

/**
 * 全局守卫（后台直接挂在根路径 /）：
 * - 放行：/login、/api/auth/login、/api/auth/callback、/favicon.ico、以 /_astro/ 开头的静态资源
 * - 旧 /admin/* 重定向到 /*（兼容旧书签）
 * - 本地显式预览模式只在 loopback 地址放行页面与 API
 * - /api/* 需登录，未登录 → 401 {ok:false,error:'未登录'}
 * - 后台页面（/、/posts、/notes、/pages、/data、/images、/settings 及其子路径）需登录，未登录 → 302 跳 /login
 * - 未知路径放行，渲染公开 404（不跳登录）
 * - 登录后把 GitHub token 写入 locals.githubToken，供各 API 调 GitHub 用
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const path = new URL(context.request.url).pathname;

  if (
    path === '/login' ||
    path === '/api/auth/login' ||
    path === '/api/auth/callback' ||
    path === '/favicon.ico' ||
    path.startsWith('/_astro/')
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

  const cookie = context.cookies.get(SESSION_COOKIE)?.value;
  const token = await getSessionToken(cookie, env.GITHUB_CLIENT_SECRET);

  if (!token) {
    if (path.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: false, error: '未登录' }), {
        status: 401,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    if (!isAdminPage) return next(); // 公开 404，不跳登录
    return context.redirect('/login');
  }

  (context.locals as any).githubToken = token;
  return next();
});
