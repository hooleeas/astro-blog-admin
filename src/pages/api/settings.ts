export const prerender = false;

import type { APIRoute } from 'astro';
import { getWebdavConfig, saveWebdavConfig, toPublic, normalizeLinkPrefix, DEFAULT_LINK_PREFIX, normalizePageTitle, normalizeR2Endpoint, normalizeR2Bucket } from '../../lib/webdav-config';
import { getR2Binding } from '../../lib/image-store';
import { isEdgeOne } from '../../lib/platform';

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

/** 返回图床配置 —— 密码与 R2 密钥永不返回，只给 hasPassword / hasR2Secret；另带 hasR2Binding（Pages 是否已绑定 R2） */
export const GET: APIRoute = async ({ locals }) => {
  try {
    const cfg = await getWebdavConfig(locals);
    return json({ ok: true, data: { ...toPublic(cfg), hasR2Binding: getR2Binding(locals) !== null, hasBlobBackend: isEdgeOne(locals) } });
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
      pageTitle?: unknown;
      webp?: unknown;
      storage?: unknown;
      r2Endpoint?: unknown;
      r2Bucket?: unknown;
      r2AccessKeyId?: unknown;
      r2SecretAccessKey?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return json({ ok: false, error: '请求体必须是 JSON' }, 400);
    }

    const oldCfg = await getWebdavConfig(locals).catch(() => null);

    // 存储方式：未传则保留已保存值
    const storage = body.storage === 'r2' || body.storage === 'webdav'
      ? body.storage
      : (oldCfg?.storage ?? 'webdav');

    const url = String(body.url ?? oldCfg?.url ?? '').trim();
    if (storage === 'webdav') {
      if (!url) {
        return json({ ok: false, error: 'WebDAV 地址必填' }, 400);
      }
      if (!/^https?:\/\//i.test(url)) {
        return json({ ok: false, error: 'WebDAV 地址必须以 http:// 或 https:// 开头' }, 400);
      }
    } else if (url && !/^https?:\/\//i.test(url)) {
      return json({ ok: false, error: 'WebDAV 地址必须以 http:// 或 https:// 开头' }, 400);
    }

    // Cloudflare R2 字段：未传保留旧值；密钥留空保留旧密钥（同 WebDAV 密码）
    let r2Endpoint = oldCfg?.r2Endpoint ?? '';
    if (body.r2Endpoint !== undefined) {
      const normalized = normalizeR2Endpoint(body.r2Endpoint);
      if (normalized === null) {
        return json({ ok: false, error: 'R2 端点不合法：必须以 https:// 开头，如 https://<账号ID>.r2.cloudflarestorage.com' }, 400);
      }
      r2Endpoint = normalized;
    }
    let r2Bucket = oldCfg?.r2Bucket ?? '';
    if (body.r2Bucket !== undefined) {
      const normalized = normalizeR2Bucket(body.r2Bucket);
      if (normalized === null) {
        return json({ ok: false, error: 'R2 存储桶名不合法：不能包含 /、空格，最长 63 个字符' }, 400);
      }
      r2Bucket = normalized;
    }
    const r2AccessKeyId = body.r2AccessKeyId !== undefined
      ? String(body.r2AccessKeyId || '').trim()
      : (oldCfg?.r2AccessKeyId ?? '');
    let r2SecretAccessKey = String(body.r2SecretAccessKey ?? '');
    if (!r2SecretAccessKey) r2SecretAccessKey = oldCfg?.r2SecretAccessKey ?? '';
    // 已通过 Pages 绑定 R2 时，下面的端点与密钥都不必填（绑定优先，运行时直接走绑定）；
    // EdgeOne 上「R2」档走 Blob 对象存储，端点与密钥同样免填
    if (storage === 'r2' && getR2Binding(locals) === null && !isEdgeOne(locals)) {
      if (!r2Endpoint) return json({ ok: false, error: 'R2 端点必填（或先在 Pages 设置里绑定 R2 存储桶，变量名 IMGS_R2）' }, 400);
      if (!r2Bucket) return json({ ok: false, error: 'R2 存储桶名必填' }, 400);
      if (!r2AccessKeyId) return json({ ok: false, error: 'R2 访问密钥 ID 必填' }, 400);
      if (!r2SecretAccessKey) return json({ ok: false, error: 'R2 密钥必填' }, 400);
    }

    const dir = String(body.dir || '').trim().replace(/^\/+|\/+$/g, '');
    if (dir.includes('..')) {
      return json({ ok: false, error: '目录不能包含 ..' }, 400);
    }

    // 对外链接前缀：未传则保留已保存值（同密码的处理方式）
    let linkPrefix: string;
    if (body.linkPrefix === undefined) {
      linkPrefix = oldCfg?.linkPrefix ?? DEFAULT_LINK_PREFIX;
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

    // 公开页标题：未传则保留已保存值
    let pageTitle: string;
    if (body.pageTitle === undefined) {
      pageTitle = oldCfg?.pageTitle ?? '';
    } else {
      const normalized = normalizePageTitle(body.pageTitle);
      if (normalized === null) {
        return json({ ok: false, error: '公开页标题不合法：最多 60 个字符，不能包含换行' }, 400);
      }
      pageTitle = normalized;
    }

    // 密码为空 → 保留 KV 里旧密码
    let password = String(body.password ?? '');
    if (!password) {
      password = oldCfg?.password || '';
    }

    await saveWebdavConfig(locals, {
      storage,
      r2Endpoint,
      r2Bucket,
      r2AccessKeyId,
      r2SecretAccessKey,
      url: url.replace(/\/+$/, ''),
      username: String(body.username || '').trim(),
      password,
      dir,
      webp: body.webp !== false,
      linkPrefix,
      pageTitle,
    });
    return json({ ok: true });
  } catch (e) {
    return err(e);
  }
};
