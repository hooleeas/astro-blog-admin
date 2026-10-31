import type { APIRoute } from 'astro';
import { SESSION_COOKIE } from '../../../lib/session';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const isHttps = new URL(request.url).protocol === 'https:';
  const cookie = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
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
