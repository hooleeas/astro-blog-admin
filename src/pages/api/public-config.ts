export const prerender = false;

import type { APIRoute } from 'astro';
import { getWebdavConfig } from '../../lib/webdav-config';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 公开图床页只需要这一个开关：是否上传时转 WebP。其余配置（地址、账号、目录）一概不返回。 */
export const GET: APIRoute = async ({ locals }) => {
  const cfg = await getWebdavConfig(locals).catch(() => null);
  return json({ ok: true, data: { webp: cfg ? cfg.webp !== false : true } });
};
