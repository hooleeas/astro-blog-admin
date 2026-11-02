export const prerender = false;

import type { APIRoute } from 'astro';
import { isImageFilename } from '../../../lib/image-assets';
import { getWebdavConfig } from '../../../lib/webdav-config';
import { storeDeleteFile, storeFileExists } from '../../../lib/image-store';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export const DELETE: APIRoute = async ({ locals, params }) => {
  const filename = params.filename ?? '';
  if (!isImageFilename(filename)) return json({ ok: false, error: '图片文件名无效' }, 400);

  try {
    const config = await getWebdavConfig(locals);
    if (!await storeFileExists(config, filename)) {
      return json({ ok: false, error: '图床中不存在这张图片' }, 404);
    }
    // 图片只存当前存储一份，删除也只删这一份
    await storeDeleteFile(config, filename);
    return json({ ok: true, data: { filename } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: `删除图片失败：${message}` }, 502);
  }
};
