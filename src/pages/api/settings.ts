export const prerender = false;

import type { APIRoute } from 'astro';
import { getWebdavConfig, saveWebdavConfig, toPublic, normalizeLinkPrefix, DEFAULT_LINK_PREFIX } from '../../lib/webdav-config';

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
      linkPrefix?: unknown;
      webp?: unknown;
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

    // 对外链接前缀：未传则保留已保存值（同密码的处理方式）
    let linkPrefix: string;
    if (body.linkPrefix === undefined) {
      const old = await getWebdavConfig(locals).catch(() => null);
      linkPrefix = old?.linkPrefix ?? DEFAULT_LINK_PREFIX;
    } else {
      const normalized = normalizeLinkPrefix(body.linkPrefix);
      if (normalized === null) {
        return json({ ok: false, error: '链接前缀不合法：只能是单级路径（不含 / 和空格），如 images' }, 400);
      }
      if (['api', 'posts', 'notes', 'pages', 'data', 'settings', 'login', 'admin'].includes(normalized)) {
        return json({ ok: false, error: '该前缀与后台路径冲突，请换一个' }, 400);
      }
      linkPrefix = normalized;
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
      webp: body.webp !== false,
      linkPrefix,
    });
    return json({ ok: true });
  } catch (e) {
    return err(e);
  }
};
