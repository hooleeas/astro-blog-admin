// 图片存储层：按设置里的存储方式（WebDAV / Cloudflare R2）统一提供存取接口。
// WebDAV 实现沿用原有逻辑；R2 走 S3 兼容接口（aws4fetch 签名，原生 fetch，Workers 可用）。
// EdgeOne 运行时（platform 层判定）：「R2」这一档改走 EdgeOne Blob 对象存储，不用 S3 密钥。
// 注意：不要用默认入口 'webdav'（依赖 node-fetch），'webdav/web' 是官方自包含 web 构建。
import { createClient } from 'webdav/web';
import { AwsClient } from 'aws4fetch';
import { getBinding, getImageBlobStore } from './platform';
import { imageDir, type WebdavConfig } from './webdav-config';

/** Pages 项目里 R2 存储桶的绑定变量名（在 Pages 设置 → 函数 → R2 存储桶绑定里添加） */
export const R2_BINDING_NAME = 'IMGS_R2';

/** R2 绑定对象的最小结构（Cloudflare R2Bucket 接口子集） */
interface R2BucketLike {
  head(key: string): Promise<unknown | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; size: number; uploaded: Date | string }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

/**
 * 取平台绑定里的 R2 存储桶（Cloudflare Pages 的 IMGS_R2 绑定；EdgeOne 无此绑定，
 * 返回 null 后各存储操作自动走 S3 兼容接口）；没绑或形状不对返回 null
 */
export function getR2Binding(locals: unknown): R2BucketLike | null {
  try {
    const bucket = getBinding(locals, R2_BINDING_NAME);
    if (bucket && typeof bucket.put === 'function' && typeof bucket.get === 'function') {
      return bucket as R2BucketLike;
    }
  } catch {}
  return null;
}

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
    fail(500, `未检测到 Pages 绑定（${R2_BINDING_NAME}），也没有填写完整的 R2 密钥：请二选一——在 Pages 设置里绑定 R2 存储桶（变量名 ${R2_BINDING_NAME}），或在图床设置页填写 R2 端点与密钥`);
  }
}

function r2Key(cfg: WebdavConfig, filename: string): string {
  return `${imageDir(cfg)}/${filename}`;
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

export async function storeFileExists(locals: unknown, cfg: WebdavConfig, filename: string): Promise<boolean> {
  if (cfg.storage === 'r2') {
    const bucket = getR2Binding(locals);
    if (bucket) return (await bucket.head(r2Key(cfg, filename))) !== null;
    const blob = await getImageBlobStore(locals);
    if (blob) return blob.exists(r2Key(cfg, filename));
    const res = await r2Client(cfg).fetch(r2ObjectUrl(cfg, filename), { method: 'HEAD' });
    return res.ok;
  }
  const client = webdavClient(cfg);
  return client.exists(`/${imageDir(cfg)}/${filename}`);
}

export async function storePutFile(locals: unknown, cfg: WebdavConfig, filename: string, data: ArrayBuffer): Promise<void> {
  if (cfg.storage === 'r2') {
    const bucket = getR2Binding(locals);
    if (bucket) {
      await bucket.put(r2Key(cfg, filename), data, { httpMetadata: { contentType: imageContentType(filename) } });
      return;
    }
    const blob = await getImageBlobStore(locals);
    if (blob) {
      await blob.put(r2Key(cfg, filename), data);
      return;
    }
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

export async function storeGetFile(locals: unknown, cfg: WebdavConfig, filename: string): Promise<Uint8Array> {
  if (cfg.storage === 'r2') {
    const bucket = getR2Binding(locals);
    if (bucket) {
      const obj = await bucket.get(r2Key(cfg, filename));
      if (!obj) fail(404, '图片不存在');
      return new Uint8Array(await obj.arrayBuffer());
    }
    const blob = await getImageBlobStore(locals);
    if (blob) {
      const data = await blob.get(r2Key(cfg, filename));
      if (!data) fail(404, '图片不存在');
      return new Uint8Array(data);
    }
    const res = await r2Client(cfg).fetch(r2ObjectUrl(cfg, filename));
    if (!res.ok) await r2Error(res, '读取');
    return new Uint8Array(await res.arrayBuffer());
  }
  const client = webdavClient(cfg);
  const data = await client.getFileContents(`/${imageDir(cfg)}/${filename}`);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as unknown as ArrayLike<number>);
}

export async function storeListFiles(locals: unknown, cfg: WebdavConfig): Promise<StoredImage[]> {
  if (cfg.storage === 'r2') {
    const bucket = getR2Binding(locals);
    if (bucket) {
      const prefix = `${imageDir(cfg)}/`;
      const out: StoredImage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await bucket.list({ prefix, cursor, limit: 1000 });
        for (const obj of res.objects) {
          const name = obj.key.slice(prefix.length);
          if (!name || name.includes('/')) continue;
          out.push({
            filename: name,
            size: obj.size,
            lastmod: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : String(obj.uploaded || ''),
          });
        }
        if (!res.truncated || !res.cursor) break;
        cursor = res.cursor;
      }
      return out;
    }
    const blob = await getImageBlobStore(locals);
    if (blob) {
      const prefix = `${imageDir(cfg)}/`;
      const items = await blob.list(prefix);
      const out: StoredImage[] = [];
      for (const it of items) {
        const name = it.key.slice(prefix.length);
        if (!name || name.includes('/')) continue;
        out.push({ filename: name, size: it.size, lastmod: it.lastmod });
      }
      return out;
    }
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

export async function storeDeleteFile(locals: unknown, cfg: WebdavConfig, filename: string): Promise<void> {
  if (cfg.storage === 'r2') {
    const bucket = getR2Binding(locals);
    if (bucket) {
      await bucket.delete(r2Key(cfg, filename));
      return;
    }
    const blob = await getImageBlobStore(locals);
    if (blob) {
      await blob.delete(r2Key(cfg, filename));
      return;
    }
    const res = await r2Client(cfg).fetch(r2ObjectUrl(cfg, filename), { method: 'DELETE' });
    if (!res.ok && res.status !== 204) await r2Error(res, '删除');
    return;
  }
  const client = webdavClient(cfg);
  await client.deleteFile(`/${imageDir(cfg)}/${filename}`);
}
