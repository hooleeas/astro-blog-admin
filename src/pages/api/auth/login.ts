import type { APIRoute } from 'astro';
import { getEnv } from '../../../lib/env';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  signSession,
  timingSafeEqual,
} from '../../../lib/session';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);

  if (!env.ADMIN_PASSWORD) {
    return Response.json({ ok: false, error: '服务端未配置 ADMIN_PASSWORD' }, { status: 500 });
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (!timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    return Response.json({ ok: false, error: '密码错误' }, { status: 401 });
  }

  const sessionValue = await signSession(env.ADMIN_PASSWORD);
  const isHttps = new URL(request.url).protocol === 'https:';
  const cookie = [
    `${SESSION_COOKIE}=${sessionValue}`,
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(isHttps ? ['Secure'] : []),
  ].join('; ');

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': cookie,
    },
  });
};
