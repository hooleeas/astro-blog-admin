import { isImageFilename } from './image-assets';
import { getWebdavConfig } from './webdav-config';
import { imageContentType, storeGetFile } from './image-store';

/** 按文件名从当前存储（WebDAV / Cloudflare R2）回源读图并返回响应；文件名不合法或读取失败一律 404。 */
export async function serveImage(locals: unknown, filename: string): Promise<Response> {
  if (!isImageFilename(filename)) {
    return new Response('Not found', { status: 404 });
  }
  try {
    const config = await getWebdavConfig(locals);
    const body = await storeGetFile(locals, config, filename);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': imageContentType(filename),
        'cache-control': 'public, max-age=3600',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
