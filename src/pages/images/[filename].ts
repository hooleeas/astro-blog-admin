export const prerender = false;

import type { APIRoute } from 'astro';
// 与 upload.ts 相同：用 'webdav/web' 自包含构建（原生 fetch），不要用默认入口。
import { createClient } from 'webdav/web';
import { isImageFilename } from '../../lib/image-assets';
import { getWebdavConfig, imageDir } from '../../lib/webdav-config';

/**
 * 图床图片回源：图片只存 WebDAV 一份，本路由按 /images/<文件名> 从 WebDAV 读出返回。
 * 中间件对 /images/<文件名> 放行（公开可读），复制到文章里的链接可直接打开。
 */

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

export const GET: APIRoute = async ({ locals, params }) => {
  const filename = params.filename ?? '';
  if (!isImageFilename(filename)) {
    return new Response('Not found', { status: 404 });
  }
  try {
    const config = await getWebdavConfig(locals);
    const client = createClient(config.url, { username: config.username, password: config.password });
    const data = await client.getFileContents(`/${imageDir(config)}/${filename}`);
    const body = data instanceof ArrayBuffer ? data : new Uint8Array(data as unknown as ArrayLike<number>);
    const ext = (filename.split('.').pop() || '').toLowerCase();
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
        'cache-control': 'public, max-age=3600',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
};
