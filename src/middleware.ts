import { defineMiddleware } from 'astro:middleware';
import { getEnv } from './lib/env';
import { SESSION_COOKIE, verifySession } from './lib/session';

/**
 * 全局守卫：
 * - 放行：/login、/api/auth/login、/favicon.ico、以 /_astro/ 开头的静态资源
 * - /admin/* 需登录，未登录 → 302 跳 /login
 * - /api/* 需登录，未登录 → 401 {ok:false,error:'未登录'}
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const path = new URL(context.request.url).pathname;

  const needsAuth = path.startsWith('/admin/') || path.startsWith('/api/');
  if (!needsAuth) return next();

  if (
    path === '/login' ||
    path === '/api/auth/login' ||
    path === '/favicon.ico' ||
    path.startsWith('/_astro/')
  ) {
    return next();
  }

  const env = getEnv(context.locals);
  const cookie = context.cookies.get(SESSION_COOKIE)?.value;
  const authed = await verifySession(cookie, env.ADMIN_PASSWORD);

  if (!authed) {
    if (path.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: false, error: '未登录' }), {
        status: 401,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    return context.redirect('/login');
  }

  return next();
});
