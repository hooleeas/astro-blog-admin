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

/** 用当前 KV 配置连 WebDAV 做 stat('/')，验证地址/账号/密码可用 */
export const POST: APIRoute = async ({ locals }) => {
  try {
    const cfg = await getWebdavConfig(locals);
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
