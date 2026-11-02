import { getKVStore, isEdgeOne, type KvLike } from './platform';

export type ImageStorageKind = 'webdav' | 'r2';

export interface WebdavConfig {
  /** 图片存储方式：WebDAV 或 Cloudflare R2（S3 兼容接口） */
  storage: ImageStorageKind;
  /** Cloudflare R2 的 S3 端点，如 https://<账号ID>.r2.cloudflarestorage.com */
  r2Endpoint: string;
  /** Cloudflare R2 存储桶名称 */
  r2Bucket: string;
  /** Cloudflare R2 访问密钥 ID */
  r2AccessKeyId: string;
  /** Cloudflare R2 密钥 —— 只存 KV，绝不进代码仓库，绝不返回给前端 */
  r2SecretAccessKey: string;
  url: string;
  username: string;
  /** 明文密码 —— 只存 KV，绝不进代码仓库，绝不返回给前端 */
  password: string;
  dir: string;
  /** 是否上传时转 WebP（默认 true，可在设置页开关） */
  webp: boolean;
  /** 图片对外链接的路径前缀（默认 images），链接形如 /<前缀>/<文件名> */
  linkPrefix: string;
  /** 公开图床页标题（可空，空时页面用默认「图床」） */
  pageTitle: string;
}

export interface WebdavConfigPublic {
  /** 图片存储方式 */
  storage: ImageStorageKind;
  /** Cloudflare R2 的 S3 端点 */
  r2Endpoint: string;
  /** Cloudflare R2 存储桶名称 */
  r2Bucket: string;
  /** Cloudflare R2 访问密钥 ID */
  r2AccessKeyId: string;
  /** 是否已设置 R2 密钥（只给布尔值，不回显原值） */
  hasR2Secret: boolean;
  url: string;
  username: string;
  dir: string;
  /** 是否已设置密码（只给布尔值，不回显原值） */
  hasPassword: boolean;
  /** 是否上传时转 WebP */
  webp: boolean;
  /** 图片对外链接的路径前缀 */
  linkPrefix: string;
  /** 公开图床页标题 */
  pageTitle: string;
}

/** 图床默认存放目录（设置页未填 dir 时使用） */
export const IMG_DIR = 'img';

/** 图床实际存放目录：设置页填了 dir 就用它，留空用默认 img */
export function imageDir(cfg: WebdavConfig): string {
  return cfg.dir || IMG_DIR;
}

/** 对外链接默认前缀 */
export const DEFAULT_LINK_PREFIX = 'images';

/**
 * 规范化对外链接前缀：单级路径（不含 /、\、空白与控制字符），留空用默认 images；
 * 不合法返回 null（设置接口据此报错，读取配置时回退默认）。
 */
export function normalizeLinkPrefix(raw: unknown): string | null {
  const s = String(raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!s) return DEFAULT_LINK_PREFIX;
  if (s.includes('/') || s.includes('\\') || s === '.' || s === '..' || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

/**
 * 规范化公开图床页标题：去掉首尾空白，最多 60 个字符，不含控制字符（含换行）；
 * 不合法返回 null（设置接口据此报错，读取配置时回退空字符串、页面用默认标题）。
 */
/** 规范化 R2 的 S3 端点：必须 https:// 开头且是合法 URL，去掉尾部斜杠；不合法返回 null */
export function normalizeR2Endpoint(raw: unknown): string | null {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https:\/\//i.test(s)) return null;
  try { new URL(s); } catch { return null; }
  return s;
}

/** 规范化 R2 存储桶名：不含 /、\、空白与控制字符，最长 63；不合法返回 null */
export function normalizeR2Bucket(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.length > 63 || s.includes('/') || s.includes('\\') || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

export function normalizePageTitle(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (s.length > 60) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

export interface ConfigError {
  status: number;
  message: string;
}

const KV_KEY = 'webdav:config';

function notConfigured(): ConfigError {
  return { status: 500, message: '未配置 WebDAV，请先到设置页填写' };
}

/** 取 KV 存储（平台适配层）；未绑定或不可用时抛友好错误 */
async function getKV(locals: unknown): Promise<KvLike> {
  const kv = await getKVStore(locals);
  if (!kv) {
    throw {
      status: 500,
      message: 'KV 未绑定（ADMIN_KV 不可用）：Cloudflare Pages 请给项目绑定 KV 命名空间（变量名 ADMIN_KV），或在本地开发时配置；EdgeOne Pages 走 Blob 存储、无需绑定',
    } as ConfigError;
  }
  return kv;
}

/** 从 KV 读 WebDAV 配置；未配置时抛 {status:500, message}（调用方转成 {ok:false,error}） */
export async function getWebdavConfig(locals: unknown): Promise<WebdavConfig> {
  const kv = await getKV(locals);
  const raw = await kv.get(KV_KEY);
  if (!raw) throw notConfigured();
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw notConfigured();
  }
  if (!parsed || typeof parsed !== 'object') throw notConfigured();
  const storage: ImageStorageKind = parsed.storage === 'r2' ? 'r2' : 'webdav';
  const r2Endpoint = normalizeR2Endpoint(parsed.r2Endpoint) ?? '';
  const r2Bucket = normalizeR2Bucket(parsed.r2Bucket) ?? '';
  const r2AccessKeyId = String(parsed.r2AccessKeyId || '').trim();
  const r2SecretAccessKey = String(parsed.r2SecretAccessKey || '');
  const url = typeof parsed.url === 'string' ? parsed.url.replace(/\/+$/, '') : '';
  // 两种存储都未配置才视为未配置（兼容只填 R2 的保存）；
  // EdgeOne 上「R2」档走 Blob 对象存储、不需要端点与密钥（见 platform.ts），同样视为已配置
  if (!url && !(r2Endpoint && r2Bucket && r2AccessKeyId && r2SecretAccessKey) && !(storage === 'r2' && isEdgeOne(locals))) throw notConfigured();
  return {
    storage,
    r2Endpoint,
    r2Bucket,
    r2AccessKeyId,
    r2SecretAccessKey,
    url,
    username: String(parsed.username || ''),
    password: String(parsed.password || ''),
    dir: String(parsed.dir || '').replace(/^\/+|\/+$/g, ''),
    webp: parsed.webp !== false,
    linkPrefix: normalizeLinkPrefix(parsed.linkPrefix) ?? DEFAULT_LINK_PREFIX,
    pageTitle: normalizePageTitle(parsed.pageTitle) ?? '',
  };
}

/** 写 WebDAV 配置到 KV。password 由调用方决定（空则调用方先填入旧值）。 */
export async function saveWebdavConfig(
  locals: unknown,
  cfg: { storage: ImageStorageKind; r2Endpoint: string; r2Bucket: string; r2AccessKeyId: string; r2SecretAccessKey: string; url: string; username: string; password: string; dir: string; webp: boolean; linkPrefix: string; pageTitle: string },
): Promise<void> {
  const kv = await getKV(locals);
  await kv.put(
    KV_KEY,
    JSON.stringify({
      storage: cfg.storage,
      r2Endpoint: cfg.r2Endpoint,
      r2Bucket: cfg.r2Bucket,
      r2AccessKeyId: cfg.r2AccessKeyId,
      r2SecretAccessKey: cfg.r2SecretAccessKey,
      url: cfg.url,
      username: cfg.username,
      password: cfg.password,
      dir: cfg.dir,
      webp: cfg.webp,
      linkPrefix: cfg.linkPrefix,
      pageTitle: cfg.pageTitle,
      updatedAt: new Date().toISOString(),
    }),
  );
}

/** 去掉密码后的公开视图（给 GET /api/settings 用） */
export function toPublic(cfg: WebdavConfig): WebdavConfigPublic {
  return {
    storage: cfg.storage,
    r2Endpoint: cfg.r2Endpoint,
    r2Bucket: cfg.r2Bucket,
    r2AccessKeyId: cfg.r2AccessKeyId,
    hasR2Secret: cfg.r2SecretAccessKey.length > 0,
    url: cfg.url,
    username: cfg.username,
    dir: cfg.dir,
    hasPassword: cfg.password.length > 0,
    webp: cfg.webp,
    linkPrefix: cfg.linkPrefix,
    pageTitle: cfg.pageTitle,
  };
}
