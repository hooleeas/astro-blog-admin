export const prerender = false;

import type { APIRoute } from 'astro';
// 注意：不要用默认入口 'webdav'（dist/node，依赖 node-fetch，在 Workers 上跑不起来）。
// 'webdav/web' 是官方自包含 web 构建（原生 fetch，显式支持 WorkerGlobalScope），
// 在 Cloudflare Pages Functions / workerd 里可直接运行。
import { createClient } from 'webdav/web';
import { getWebdavConfig, IMG_DIR } from '../../lib/webdav-config';
import { putPagesAsset } from '../../lib/github';
import { getImageUrl, isImageFilename, isLocalImagePreview } from '../../lib/image-assets';

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

    // 扩展名白名单；保留原始文件名（转换后的 WebP 已由浏览器换好扩展名）。
    let filename = file.name;
    if (/[\\/\u0000-\u001f\u007f]/.test(filename) || new TextEncoder().encode(filename).length > 240) {
      return json({ ok: false, error: '文件名无效或过长' }, 400);
    }
    let ext = (filename.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!ALLOWED_EXT.includes(ext)) {
      ext = TYPE_TO_EXT[file.type] || '';
      if (ext) {
        const extensionStart = filename.lastIndexOf('.');
        filename = `${extensionStart > 0 ? filename.slice(0, extensionStart) : filename}.${ext}`;
      }
    }
    const isImage = file.type.startsWith('image/') || ALLOWED_EXT.includes(ext);
    if (!isImage) {
      return json({ ok: false, error: '只允许上传图片文件' }, 400);
    }
    if (!ALLOWED_EXT.includes(ext)) {
      return json({ ok: false, error: `不支持的图片格式（仅支持 ${ALLOWED_EXT.join(' / ')}）` }, 400);
    }
    if (!isImageFilename(filename)) {
      return json({ ok: false, error: '文件名无效或过长' }, 400);
    }

    const cfg = await getWebdavConfig(locals);

    const client = createClient(cfg.url, { username: cfg.username, password: cfg.password });
    const data = await file.arrayBuffer();
    // 图片统一存放在 /img/ 目录（不存在则创建）
    try { await (client as any).createDirectory(`/${IMG_DIR}`); } catch {}
    const remotePath = `/${IMG_DIR}/${filename}`;
    await client.putFileContents(remotePath, data, { overwrite: false });

    const localPreview = isLocalImagePreview(locals, request);
    if (localPreview) {
      try {
        const { writeLocalImageAsset } = await import('../../lib/local-data.js');
        await writeLocalImageAsset(filename, new Uint8Array(data));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ ok: false, error: `图片已存入 WebDAV，但写入本地站点失败：${message}` }, 500);
      }
    } else {
      try {
        await putPagesAsset(locals, `${IMG_DIR}/${filename}`, new Uint8Array(data), `admin: 发布图床图片 ${filename}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ ok: false, error: `图片已存入 WebDAV，但发布到本站失败：${message}` }, 502);
      }
    }

    return json({ ok: true, data: { url: getImageUrl(locals, filename, localPreview), filename } });
  } catch (e: any) {
    if (e && typeof e.status === 'number' && e.message) {
      return json({ ok: false, error: e.message }, e.status);
    }
    return json({ ok: false, error: `上传失败：${e?.message || String(e)}` }, 500);
  }
};
