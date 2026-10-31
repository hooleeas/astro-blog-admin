export const prerender = false;

import type { APIRoute } from 'astro';
// 注意：不要用默认入口 'webdav'（dist/node，依赖 node-fetch，在 Workers 上跑不起来）。
// 'webdav/web' 是官方自包含 web 构建（原生 fetch，显式支持 WorkerGlobalScope），
// 在 Cloudflare Pages Functions / workerd 里可直接运行。
import { createClient } from 'webdav/web';
import { getWebdavConfig, buildPublicUrl } from '../../lib/webdav-config';

const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'];
const TYPE_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function rand6(): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return json({ ok: false, error: '未收到文件（表单字段名应为 file）' }, 400);
    }
    if (file.size === 0) {
      return json({ ok: false, error: '文件为空' }, 400);
    }
    if (file.size > MAX_SIZE) {
      return json({ ok: false, error: '文件超过 10MB 限制' }, 400);
    }

    // 扩展名白名单（小写、只留字母数字，防穿越）；文件名无有效扩展名时尝试按 content-type 推断
    let ext = (file.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!ALLOWED_EXT.includes(ext)) {
      ext = TYPE_TO_EXT[file.type] || '';
    }
    const isImage = file.type.startsWith('image/') || ALLOWED_EXT.includes(ext);
    if (!isImage) {
      return json({ ok: false, error: '只允许上传图片文件' }, 400);
    }
    if (!ALLOWED_EXT.includes(ext)) {
      return json({ ok: false, error: `不支持的图片格式（仅支持 ${ALLOWED_EXT.join(' / ')}）` }, 400);
    }

    const cfg = await getWebdavConfig(locals);

    // 文件名：YYYYMMDD-HHmmss-<6位随机>.ext（服务器时间为准，Workers 上是 UTC）
    const d = new Date();
    const filename =
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
      `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-` +
      `${rand6()}.${ext}`;

    const client = createClient(cfg.url, { username: cfg.username, password: cfg.password });
    const data = await file.arrayBuffer();
    const remotePath = cfg.dir ? `/${cfg.dir}/${filename}` : `/${filename}`;
    await client.putFileContents(remotePath, data, { overwrite: false });

    return json({ ok: true, data: { url: buildPublicUrl(cfg, filename), filename } });
  } catch (e: any) {
    if (e && typeof e.status === 'number' && e.message) {
      return json({ ok: false, error: e.message }, e.status);
    }
    return json({ ok: false, error: `上传失败：${e?.message || String(e)}` }, 500);
  }
};
