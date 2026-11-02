export const prerender = false;

import type { APIRoute } from 'astro';
import { getWebdavConfig } from '../../lib/webdav-config';
import { serveImage } from '../../lib/serve-image';

/**
 * 自定义前缀的图床图片回源：/<前缀>/<文件名>。
 * 前缀以图床设置里的 linkPrefix 为准，不匹配一律 404（默认前缀 images 由 /images/[filename] 处理）。
 */
export const GET: APIRoute = async ({ locals, params }) => {
  try {
    const config = await getWebdavConfig(locals);
    if (!params.prefix || params.prefix !== config.linkPrefix) {
      return new Response('Not found', { status: 404 });
    }
  } catch {
    return new Response('Not found', { status: 404 });
  }
  return serveImage(locals, params.filename ?? '');
};
