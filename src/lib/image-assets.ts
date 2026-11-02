import { getEnv } from './env';
import { IMG_DIR } from './webdav-config';

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
  const env = getEnv(locals as any);
  const imagePath = `${IMG_DIR}/${encodeURIComponent(filename)}`;
  if (localPreview) {
    if (env.LOCAL_SITE_URL) {
      return new URL(imagePath, new URL(env.LOCAL_SITE_URL)).toString();
    }
    // 未显式配置博客地址时，跟随访问者实际使用的域名（博客本地端口 4323）
    const req = new URL(requestUrl || 'http://127.0.0.1:4323');
    const siteUrl = new URL(`${req.protocol}//${req.hostname}:4323`);
    return new URL(imagePath, siteUrl).toString();
  }

  const repo = (env.GITHUB_PAGES_REPO || 'hooleeas/hooleeas.github.io')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  const branch = encodeURIComponent(env.GITHUB_PAGES_BRANCH || 'main');
  return `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${imagePath}`;
}
