import { getEnv } from './env';

export interface WebdavConfig {
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

/** 取 KV binding；Pages 后台未绑定或本地开发缺失时抛友好错误 */
function getKV(locals: unknown): {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
} {
  const env = getEnv(locals as any);
  const kv = env?.ADMIN_KV;
  if (!kv) {
    throw {
      status: 500,
      message: 'KV 未绑定（ADMIN_KV 不可用）：请在 Pages 项目设置里绑定 KV 命名空间，或在本地开发时配置',
    } as ConfigError;
  }
  return kv;
}

/** 从 KV 读 WebDAV 配置；未配置时抛 {status:500, message}（调用方转成 {ok:false,error}） */
export async function getWebdavConfig(locals: unknown): Promise<WebdavConfig> {
  const kv = getKV(locals);
  const raw = await kv.get(KV_KEY);
  if (!raw) throw notConfigured();
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw notConfigured();
  }
  if (!parsed || typeof parsed.url !== 'string' || !parsed.url) throw notConfigured();
  return {
    url: parsed.url.replace(/\/+$/, ''),
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
  cfg: { url: string; username: string; password: string; dir: string; webp: boolean; linkPrefix: string; pageTitle: string },
): Promise<void> {
  const kv = getKV(locals);
  await kv.put(
    KV_KEY,
    JSON.stringify({
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
    url: cfg.url,
    username: cfg.username,
    dir: cfg.dir,
    hasPassword: cfg.password.length > 0,
    webp: cfg.webp,
    linkPrefix: cfg.linkPrefix,
    pageTitle: cfg.pageTitle,
  };
}
