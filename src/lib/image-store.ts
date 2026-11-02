// 图片存储层：按设置里的存储方式（WebDAV / Cloudflare R2）统一提供存取接口。
// WebDAV 实现沿用原有逻辑；R2 走 S3 兼容接口（aws4fetch 签名，原生 fetch，Workers 可用）。
// 注意：不要用默认入口 'webdav'（依赖 node-fetch），'webdav/web' 是官方自包含 web 构建。
import { createClient } from 'webdav/web';
import { AwsClient } from 'aws4fetch';
import { imageDir, type WebdavConfig } from './webdav-config';

export interface StoredImage {
  filename: string;
  size: number;
  /** ISO 时间字符串 */
  lastmod: string;
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

export function imageContentType(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

interface StoreError { status: number; message: string }
function fail(status: number, message: string): never {
  throw { status, message } as StoreError;
}

function requireWebdav(cfg: WebdavConfig): void {
  if (!cfg.url) fail(500, '未配置 WebDAV，请先到图床设置页填写');
}
function requireR2(cfg: WebdavConfig): void {
  if (!cfg.r2Endpoint || !cfg.r2Bucket || !cfg.r2AccessKeyId || !cfg.r2SecretAccessKey) {
    fail(500, '未配置 Cloudflare R2，请先到图床设置页填写');
  }
}

/* ---------------- WebDAV ---------------- */

function webdavClient(cfg: WebdavConfig) {
  requireWebdav(cfg);
  return createClient(cfg.url, { username: cfg.username, password: cfg.password });
}

async function webdavEnsureDir(cfg: WebdavConfig): Promise<void> {
  const client = webdavClient(cfg);
  let prefix = '';
  for (const seg of imageDir(cfg).split('/')) {
    prefix += `/${seg}`;
    try { await (client as any).createDirectory(prefix); } catch {}
  }
}

/* ---------------- Cloudflare R2（S3 兼容） ---------------- */

function r2Client(cfg: WebdavConfig): AwsClient {
  requireR2(cfg);
  return new AwsClient({
    accessKeyId: cfg.r2AccessKeyId,
    secretAccessKey: cfg.r2SecretAccessKey,
    service: 's3',
    region: 'auto',
  });
}

function r2ObjectUrl(cfg: WebdavConfig, filename: string): string {
  const key = `${imageDir(cfg)}/${filename}`;
  const encodedKey = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `${cfg.r2Endpoint}/${cfg.r2Bucket}/${encodedKey}`;
}

async function r2Error(res: Response, action: string): Promise<never> {
  let detail = '';
  try {
    const text = await res.text();
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    detail = code ? `：${code}` : '';
  } catch {}
  fail(502, `Cloudflare R2 ${action}失败（${res.status}）${detail}`);
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ---------------- 统一接口 ---------------- */

export async function storeFileExists(cfg: WebdavConfig, filename: string): Promise<boolean> {
  if (cfg.storage === 'r2') {
    const res = await r2Client(cfg).fetch(r2ObjectUrl(cfg, filename), { method: 'HEAD' });
    return res.ok;
  }
  const client = webdavClient(cfg);
  return client.exists(`/${imageDir(cfg)}/${filename}`);
}

export async function storePutFile(cfg: WebdavConfig, filename: string, data: ArrayBuffer): Promise<void> {
  if (cfg.storage === 'r2') {
    const res = await r2Client(cfg).fetch(r2ObjectUrl(cfg, filename), {
      method: 'PUT',
      body: data,
      headers: { 'content-type': imageContentType(filename) },
    });
    if (!res.ok) await r2Error(res, '上传');
    return;
  }
  await webdavEnsureDir(cfg);
  const client = webdavClient(cfg);
  await client.putFileContents(`/${imageDir(cfg)}/${filename}`, data, { overwrite: false });
}

export async function storeGetFile(cfg: WebdavConfig, filename: string): Promise<Uint8Array> {
  if (cfg.storage === 'r2') {
    const res = await r2Client(cfg).fetch(r2ObjectUrl(cfg, filename));
    if (!res.ok) await r2Error(res, '读取');
    return new Uint8Array(await res.arrayBuffer());
  }
  const client = webdavClient(cfg);
  const data = await client.getFileContents(`/${imageDir(cfg)}/${filename}`);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as unknown as ArrayLike<number>);
}

export async function storeListFiles(cfg: WebdavConfig): Promise<StoredImage[]> {
  if (cfg.storage === 'r2') {
    requireR2(cfg);
    const prefix = `${imageDir(cfg)}/`;
    const url = `${cfg.r2Endpoint}/${cfg.r2Bucket}?list-type=2&encoding-type=url&prefix=${encodeURIComponent(prefix)}`;
    const res = await r2Client(cfg).fetch(url);
    if (!res.ok) await r2Error(res, '读取列表');
    const xml = await res.text();
    const out: StoredImage[] = [];
    for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const inner = block[1];
      const rawKey = inner.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
      if (!rawKey) continue;
      let key = xmlUnescape(rawKey);
      try { key = decodeURIComponent(key); } catch {}
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (!name || name.includes('/')) continue;
      out.push({
        filename: name,
        size: Number(inner.match(/<Size>(\d+)<\/Size>/)?.[1] || 0),
        lastmod: inner.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] || '',
      });
    }
    return out;
  }
  const client = webdavClient(cfg);
  const directory = `/${imageDir(cfg)}`;
  if (!await client.exists(directory)) return [];
  const files = await client.getDirectoryContents(directory);
  return files
    .filter((file) => file.type === 'file')
    .map((file) => ({ filename: file.basename, size: file.size, lastmod: file.lastmod }));
}

export async function storeDeleteFile(cfg: WebdavConfig, filename: string): Promise<void> {
  if (cfg.storage === 'r2') {
    const res = await r2Client(cfg).fetch(r2ObjectUrl(cfg, filename), { method: 'DELETE' });
    if (!res.ok && res.status !== 204) await r2Error(res, '删除');
    return;
  }
  const client = webdavClient(cfg);
  await client.deleteFile(`/${imageDir(cfg)}/${filename}`);
}
