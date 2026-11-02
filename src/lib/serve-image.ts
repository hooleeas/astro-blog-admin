import { createClient } from 'webdav/web';
import { isImageFilename } from './image-assets';
import { getWebdavConfig, imageDir } from './webdav-config';

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

/** 按文件名从 WebDAV 回源读图并返回响应；文件名不合法或读取失败一律 404。 */
export async function serveImage(locals: unknown, filename: string): Promise<Response> {
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
}
