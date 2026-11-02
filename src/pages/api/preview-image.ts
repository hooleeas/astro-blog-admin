import type { APIContext } from 'astro';
import { getFileDownloadUrl } from '../../lib/github.js';

export const prerender = false;

/**
 * GET /api/preview-image?path=/images/avatar.webp
 * 变量里的相对图片地址是博客站点根路径，后台域名下取不到图；
 * 按博客仓库 public/ 下的原图取 GitHub 临时下载地址，302 跳转过去。
 */
export async function GET({ locals, request }: APIContext) {
  const path = new URL(request.url).searchParams.get('path') ?? '';
  if (!path.startsWith('/') || path.includes('..')) {
    return new Response('bad path', { status: 400 });
  }
  for (const candidate of ['public' + path, path.slice(1)]) {
    try {
      const downloadUrl = await getFileDownloadUrl(locals, candidate);
      if (downloadUrl) {
        return new Response(null, {
          status: 302,
          headers: { Location: downloadUrl, 'Cache-Control': 'private, max-age=120' },
        });
      }
    } catch {
      // 该候选路径不存在，试下一个
    }
  }
  return new Response('not found', { status: 404 });
}
