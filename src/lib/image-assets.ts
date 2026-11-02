import { getEnv } from './env';

const IMAGE_FILENAME_RE = /^[^/\\\u0000-\u001f\u007f]+\.(png|jpe?g|gif|webp|svg|avif)$/i;

export function isImageFilename(filename: string): boolean {
  return IMAGE_FILENAME_RE.test(filename) && new TextEncoder().encode(filename).length <= 240;
}

export function isLocalImagePreview(locals: unknown, request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return import.meta.env.DEV &&
    getEnv(locals as any).ADMIN_LOCAL_PREVIEW === 'true' &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
}

export function getImageUrl(locals: unknown, filename: string, localPreview: boolean, requestUrl?: string): string {
  // 链接域名跟随访问者打开页面时用的域名（本地/pages.dev/自定义域名都一样处理），
  // 路径统一 /images/<文件名>；图片实体只存 WebDAV，由 /images/[filename] 路由回源读取。
  void locals; void localPreview;
  const path = `images/${encodeURIComponent(filename)}`;
  if (requestUrl) {
    // 只取 Origin 拼链接：请求本身在 /api/* 下，用整条 URL 做相对解析会多出一截 /api
    return `${new URL(requestUrl).origin}/${path}`;
  }
  return `/${path}`;
}
