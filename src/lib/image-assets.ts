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

export function getImageUrl(locals: unknown, filename: string, localPreview: boolean, requestUrl?: string, linkPrefix: string = 'images'): string {
  // 图片地址只用根路径 /<前缀>/<文件名>，不带域名：从任何域名打开都自动跟随当前域名；
  // 前缀可在图床设置里改（默认 images），图片实体只存 WebDAV，由对应路由回源读取。
  void locals; void localPreview; void requestUrl;
  return `/${linkPrefix}/${encodeURIComponent(filename)}`;
}
