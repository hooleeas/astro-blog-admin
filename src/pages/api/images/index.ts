export const prerender = false;

import type { APIRoute } from 'astro';
import { getImageUrl, isImageFilename, isLocalImagePreview } from '../../../lib/image-assets';
import { getWebdavConfig } from '../../../lib/webdav-config';
import { storeListFiles } from '../../../lib/image-store';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const config = await getWebdavConfig(locals);
    const files = await storeListFiles(locals, config);
    const localPreview = isLocalImagePreview(locals, request);
    const images = files
      .filter((file) => isImageFilename(file.filename))
      .map((file) => ({
        filename: file.filename,
        url: getImageUrl(locals, file.filename, localPreview, request.url, config.linkPrefix),
        size: file.size,
        lastmod: file.lastmod,
      }))
      .sort((a, b) => b.lastmod.localeCompare(a.lastmod));
    return json({ ok: true, data: images });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error &&
      typeof error.status === 'number' ? error.status : 500;
    const message = error instanceof Error ? error.message :
      typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
    return json({ ok: false, error: `读取图片列表失败：${message}` }, status);
  }
};
