export const prerender = false;

import type { APIRoute } from 'astro';
import { createClient } from 'webdav/web';
import { getImageUrl, isImageFilename, isLocalImagePreview } from '../../../lib/image-assets';
import { getWebdavConfig, imageDir } from '../../../lib/webdav-config';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const config = await getWebdavConfig(locals);
    const client = createClient(config.url, { username: config.username, password: config.password });
    const directory = `/${imageDir(config)}`;
    if (!await client.exists(directory)) return json({ ok: true, data: [] });

    const files = await client.getDirectoryContents(directory);
    const localPreview = isLocalImagePreview(locals, request);
    const images = files
      .filter((file) => file.type === 'file' && isImageFilename(file.basename))
      .map((file) => ({
        filename: file.basename,
        url: getImageUrl(locals, file.basename, localPreview, request.url, config.linkPrefix),
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
