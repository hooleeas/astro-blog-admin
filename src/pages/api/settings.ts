export const prerender = false;

import type { APIRoute } from 'astro';
import { getWebdavConfig, saveWebdavConfig, toPublic } from '../../lib/webdav-config';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function err(e: unknown): Response {
  const ce = e as { status?: number; message?: string } | null;
  if (ce && typeof ce.status === 'number' && ce.message) {
    return json({ ok: false, error: ce.message }, ce.status);
  }
  return json({ ok: false, error: `操作失败：${(e as Error)?.message || String(e)}` }, 500);
}

/** 返回 WebDAV 配置 —— password 永不返回，只给 hasPassword */
export const GET: APIRoute = async ({ locals }) => {
  try {
    const cfg = await getWebdavConfig(locals);
    return json({ ok: true, data: toPublic(cfg) });
  } catch (e) {
    return err(e);
  }
};

/** 保存 WebDAV 配置。password 为空则保留 KV 里旧密码（不清空）。 */
export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
      username?: unknown;
      password?: unknown;
      dir?: unknown;
      publicBaseUrl?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return json({ ok: false, error: '请求体必须是 JSON' }, 400);
    }

    const url = String(body.url || '').trim();
    if (!url) {
      return json({ ok: false, error: 'WebDAV 地址必填' }, 400);
    }
    if (!/^https?:\/\//i.test(url)) {
      return json({ ok: false, error: 'WebDAV 地址必须以 http:// 或 https:// 开头' }, 400);
    }

    const dir = String(body.dir || '').trim().replace(/^\/+|\/+$/g, '');
    if (dir.includes('..')) {
      return json({ ok: false, error: '目录不能包含 ..' }, 400);
    }

    const publicBaseUrl = String(body.publicBaseUrl || '').trim();
    if (publicBaseUrl && !/^https?:\/\//i.test(publicBaseUrl)) {
      return json({ ok: false, error: '公开访问地址必须以 http:// 或 https:// 开头' }, 400);
    }

    // 密码为空 → 保留 KV 里旧密码
    let password = String(body.password ?? '');
    if (!password) {
      const old = await getWebdavConfig(locals).catch(() => null);
      password = old?.password || '';
    }

    await saveWebdavConfig(locals, {
      url: url.replace(/\/+$/, ''),
      username: String(body.username || '').trim(),
      password,
      dir,
      publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    });
    return json({ ok: true });
  } catch (e) {
    return err(e);
  }
};
