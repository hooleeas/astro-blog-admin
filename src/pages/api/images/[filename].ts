export const prerender = false;

import type { APIRoute } from 'astro';
import { createClient } from 'webdav/web';
import { deletePagesAsset } from '../../../lib/github';
import { isImageFilename, isLocalImagePreview } from '../../../lib/image-assets';
import { deleteLocalImageAsset } from '../../../lib/local-data';
import { getWebdavConfig, IMG_DIR } from '../../../lib/webdav-config';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export const DELETE: APIRoute = async ({ locals, params, request }) => {
  const filename = params.filename ?? '';
  if (!isImageFilename(filename)) return json({ ok: false, error: '图片文件名无效' }, 400);

  const localPreview = isLocalImagePreview(locals, request);
  let client: ReturnType<typeof createClient>;
  try {
    const config = await getWebdavConfig(locals);
    client = createClient(config.url, { username: config.username, password: config.password });
    if (!await client.exists(`/${IMG_DIR}/${filename}`)) {
      return json({ ok: false, error: '图床中不存在这张图片' }, 404);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: `检查 WebDAV 原图失败：${message}` }, 502);
  }

  try {
    if (localPreview) {
      try {
        await deleteLocalImageAsset(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } else {
      await deletePagesAsset(locals, `${IMG_DIR}/${filename}`, `admin: 删除图床图片 ${filename}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: `删除站点图片副本失败：${message}` }, 502);
  }

  try {
    const remotePath = `/${IMG_DIR}/${filename}`;
    await client.deleteFile(remotePath);
    return json({ ok: true, data: { filename } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: `站点副本已删除，但删除 WebDAV 原图失败：${message}` }, 502);
  }
};
