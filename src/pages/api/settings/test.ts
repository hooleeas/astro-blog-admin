export const prerender = false;

import type { APIRoute } from 'astro';
// 同 upload.ts：用 'webdav/web' 自包含构建，Workers 兼容
import { createClient } from 'webdav/web';
import { getWebdavConfig } from '../../../lib/webdav-config';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 用表单中的地址和账号测试 WebDAV；密码留空时沿用已保存密码。 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const saved = await getWebdavConfig(locals);
    const body = await request.json().catch(() => null) as {
      url?: unknown;
      username?: unknown;
      password?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return json({ ok: false, error: '请求体必须是 JSON' }, 400);
    }

    const url = typeof body.url === 'string' ? body.url.trim() : saved.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      return json({ ok: false, error: 'WebDAV 地址必须以 http:// 或 https:// 开头' }, 400);
    }
    const cfg = {
      url: url.replace(/\/+$/, ''),
      username: typeof body.username === 'string' ? body.username.trim() : saved.username,
      password: typeof body.password === 'string' && body.password.length > 0
        ? body.password
        : saved.password,
    };
    const client = createClient(cfg.url, { username: cfg.username, password: cfg.password });
    await client.stat('/');
    return json({ ok: true, data: { message: '连接成功，WebDAV 服务可用' } });
  } catch (e: any) {
    if (e && typeof e.status === 'number' && e.message) {
      return json({ ok: false, error: e.message }, e.status);
    }
    return json({ ok: false, error: `连接失败：${e?.message || String(e)}` });
  }
};
