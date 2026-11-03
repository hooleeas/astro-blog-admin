import { getMetaStore, isEdgeOne, type KvLike } from './platform';

export type ImageStorageKind = 'webdav' | 'r2' | 's3' | 'tg';

export interface WebdavConfig {
  /** 图片存储方式：WebDAV、Cloudflare R2（绑定）、S3 兼容存储或 Telegram 渠道 */
  storage: ImageStorageKind;
  /** 本配置对应的存储渠道 ID（登记表按它记账）；旧单配置形态为 legacy-<类型> */
  channelId?: string;
  /** Cloudflare R2 的 S3 端点，如 https://<账号ID>.r2.cloudflarestorage.com */
  r2Endpoint: string;
  /** Cloudflare R2 存储桶名称 */
  r2Bucket: string;
  /** Cloudflare R2 访问密钥 ID */
  r2AccessKeyId: string;
  /** Cloudflare R2 密钥 —— 只存配置存储，绝不进代码仓库，绝不返回给前端 */
  r2SecretAccessKey: string;
  /** S3 渠道端点（通用 S3 兼容存储，如 R2 的 S3 入口、AWS S3、MinIO、COS） */
  s3Endpoint: string;
  /** S3 渠道存储桶名称 */
  s3Bucket: string;
  /** S3 渠道区域（R2 填 auto，AWS 填如 us-east-1） */
  s3Region: string;
  /** S3 渠道访问密钥 ID */
  s3AccessKeyId: string;
  /** S3 渠道密钥 —— 只存配置存储，绝不返回给前端 */
  s3SecretAccessKey: string;
  url: string;
  username: string;
  /** 明文密码 —— 只存 KV，绝不进代码仓库，绝不返回给前端 */
  password: string;
  dir: string;
  /** Telegram 渠道名称（仅用于区分，默认 TG） */
  tgChannelName: string;
  /** Telegram 渠道是否启用（停用后该渠道不可上传/读取） */
  tgEnabled: boolean;
  /** Telegram 机器人令牌 —— 只存 KV，绝不进代码仓库，绝不返回给前端 */
  tgBotToken: string;
  /** Telegram 会话 ID（图片存放的频道/群）—— 只存 KV，不返回给前端 */
  tgChatId: string;
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
  /** S3 渠道端点 */
  s3Endpoint: string;
  /** S3 渠道存储桶名称 */
  s3Bucket: string;
  /** S3 渠道区域 */
  s3Region: string;
  /** S3 渠道访问密钥 ID */
  s3AccessKeyId: string;
  /** 是否已设置 S3 密钥（只给布尔值，不回显原值） */
  hasS3Secret: boolean;
  url: string;
  username: string;
  dir: string;
  /** 是否已设置密码（只给布尔值，不回显原值） */
  hasPassword: boolean;
  /** Telegram 渠道名称 */
  tgChannelName: string;
  /** Telegram 渠道是否启用 */
  tgEnabled: boolean;
  /** 是否已设置 Bot Token（只给布尔值，不回显原值） */
  hasTgBotToken: boolean;
  /** 是否已设置 Chat ID（只给布尔值，不回显原值） */
  hasTgChatId: boolean;
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

/** 规范化 S3 端点：必须 http:// 或 https:// 开头且是合法 URL，去掉尾部斜杠；留空返回空串，不合法返回 null */
export function normalizeS3Endpoint(raw: unknown): string | null {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return null;
  try { new URL(s); } catch { return null; }
  return s;
}

/** S3 默认区域（R2 等自动区域的存储用 auto） */
export const DEFAULT_S3_REGION = 'auto';

/** 规范化 S3 区域：字母、数字、连字符，最长 40；留空用默认 auto，不合法返回 null */
export function normalizeS3Region(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return DEFAULT_S3_REGION;
  if (s.length > 40 || !/^[A-Za-z0-9-]+$/.test(s)) return null;
  return s;
}

export function normalizePageTitle(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (s.length > 60) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

/** Telegram 渠道默认名称 */
export const DEFAULT_TG_CHANNEL_NAME = 'TG';

/** 规范化 Telegram 渠道名称：去首尾空白，最长 30 字符、不含控制字符；留空用默认 TG；不合法返回 null */
export function normalizeTgChannelName(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return DEFAULT_TG_CHANNEL_NAME;
  if (s.length > 30 || /[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

/**
 * 规范化 Telegram Chat ID：数字 ID（频道为 -100 开头）或 @频道用户名；
 * 留空返回空字符串，不合法返回 null。
 */
export function normalizeTgChatId(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^-?\d{1,20}$/.test(s)) return s;
  if (/^@[A-Za-z0-9_]{5,}$/.test(s)) return s;
  return null;
}

export interface ConfigError {
  status: number;
  message: string;
}

const KV_KEY = 'webdav:config';

function notConfigured(): ConfigError {
  return { status: 500, message: '图床尚未配置，请先到设置页完成存储配置' };
}

/** 取账本存储（平台适配层：D1 优先、否则 KV，EdgeOne 走 Blob）；不可用时抛友好错误 */
async function getKV(locals: unknown): Promise<KvLike> {
  const kv = await getMetaStore(locals);
  if (!kv) {
    throw {
      status: 500,
      message: '配置存储不可用：Cloudflare Pages 请给项目绑定 KV 命名空间（变量名 ADMIN_KV）或 D1 数据库（变量名 ADMIN_D1）；EdgeOne Pages 走 Blob 存储、无需绑定',
    } as ConfigError;
  }
  return kv;
}

/** 从 KV 读图床配置（旧单配置形态）；未配置时抛 {status:500, message}（调用方转成 {ok:false,error}） */
export async function getLegacyWebdavConfig(locals: unknown): Promise<WebdavConfig> {
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
  const storage: ImageStorageKind = parsed.storage === 'r2' ? 'r2' : parsed.storage === 'tg' ? 'tg' : 'webdav';
  const r2Endpoint = normalizeR2Endpoint(parsed.r2Endpoint) ?? '';
  const r2Bucket = normalizeR2Bucket(parsed.r2Bucket) ?? '';
  const r2AccessKeyId = String(parsed.r2AccessKeyId || '').trim();
  const r2SecretAccessKey = String(parsed.r2SecretAccessKey || '');
  const url = typeof parsed.url === 'string' ? parsed.url.replace(/\/+$/, '') : '';
  const tgChannelName = normalizeTgChannelName(parsed.tgChannelName) ?? DEFAULT_TG_CHANNEL_NAME;
  const tgEnabled = parsed.tgEnabled !== false;
  const tgBotToken = String(parsed.tgBotToken || '').trim();
  const tgChatId = normalizeTgChatId(parsed.tgChatId) ?? '';
  // 两种存储都未配置才视为未配置（兼容只填 R2 的保存）；
  // EdgeOne 上「R2」档走 Blob 对象存储、不需要端点与密钥（见 platform.ts），同样视为已配置；
  // Telegram 档填了令牌与会话 ID 即视为已配置
  if (!url && !(r2Endpoint && r2Bucket && r2AccessKeyId && r2SecretAccessKey) && !(storage === 'r2' && isEdgeOne(locals)) && !(tgBotToken && tgChatId)) throw notConfigured();
  return {
    storage,
    channelId: `legacy-${storage}`,
    r2Endpoint,
    r2Bucket,
    r2AccessKeyId,
    r2SecretAccessKey,
    s3Endpoint: '',
    s3Bucket: '',
    s3Region: DEFAULT_S3_REGION,
    s3AccessKeyId: '',
    s3SecretAccessKey: '',
    url,
    username: String(parsed.username || ''),
    password: String(parsed.password || ''),
    dir: String(parsed.dir || '').replace(/^\/+|\/+$/g, ''),
    tgChannelName,
    tgEnabled,
    tgBotToken,
    tgChatId,
    webp: parsed.webp !== false,
    linkPrefix: normalizeLinkPrefix(parsed.linkPrefix) ?? DEFAULT_LINK_PREFIX,
    pageTitle: normalizePageTitle(parsed.pageTitle) ?? '',
  };
}

/* ================= 存储渠道（多渠道模型） =================
 * 渠道列表存配置存储 storage:channels：每条渠道是一种存储的完整参数（WebDAV / R2 / S3 / Telegram），
 * 各有独立的「对外连接路径」（单级、必填、可多渠道共用）与上传目录；
 * 图床设置只保存「当前使用哪条渠道」与图床自身选项（webp、公开页标题）。
 * 旧的单配置（webdav:config）首次读取时按其内容折算成渠道（不落盘，用户首次在新界面保存时才落盘）。
 */

export interface StorageChannel {
  id: string;
  /** 渠道名称（用户可改，必填） */
  name: string;
  kind: ImageStorageKind;
  /** 是否启用：停用的渠道不能被选为当前存储、其对外路径也不出图 */
  enabled: boolean;
  /** 对外连接路径：图片链接形如 /<path>/<文件名>；可多渠道共用，共用时切换存储不影响链接 */
  path: string;
  /** 上传目录（该渠道内的存放目录） */
  dir: string;
  url: string;
  username: string;
  password: string;
  r2Endpoint: string;
  r2Bucket: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  tgBotToken: string;
  tgChatId: string;
}

export interface StorageChannelPublic {
  id: string;
  name: string;
  kind: ImageStorageKind;
  enabled: boolean;
  path: string;
  dir: string;
  url: string;
  username: string;
  hasPassword: boolean;
  r2Endpoint: string;
  r2Bucket: string;
  r2AccessKeyId: string;
  hasR2Secret: boolean;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  hasS3Secret: boolean;
  hasTgBotToken: boolean;
  hasTgChatId: boolean;
}

export interface ChannelsState {
  channels: StorageChannel[];
  activeId: string;
}

const CHANNELS_KEY = 'storage:channels';

/** 渠道名称规范化（与 Telegram 渠道名称同一规则） */
export const normalizeChannelName = normalizeTgChannelName;

export function newChannelId(): string {
  return `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function kindDefaultName(kind: ImageStorageKind, locals: unknown): string {
  if (kind === 'webdav') return 'WebDAV';
  if (kind === 'tg') return DEFAULT_TG_CHANNEL_NAME;
  if (kind === 's3') return 'S3';
  return isEdgeOne(locals) ? 'EdgeOne Blob' : 'Cloudflare R2';
}

function sanitizeChannel(raw: any, locals: unknown): StorageChannel | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind: ImageStorageKind = raw.kind === 'r2' ? 'r2' : raw.kind === 's3' ? 's3' : raw.kind === 'tg' ? 'tg' : raw.kind === 'webdav' ? 'webdav' : null as never;
  if (!kind) return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: normalizeChannelName(raw.name) ?? kindDefaultName(kind, locals),
    kind,
    enabled: raw.enabled !== false,
    path: normalizeLinkPrefix(raw.path) ?? '',
    dir: String(raw.dir || '').replace(/^\/+|\/+$/g, ''),
    url: typeof raw.url === 'string' ? raw.url.replace(/\/+$/, '') : '',
    username: String(raw.username || ''),
    password: String(raw.password || ''),
    r2Endpoint: normalizeR2Endpoint(raw.r2Endpoint) ?? '',
    r2Bucket: normalizeR2Bucket(raw.r2Bucket) ?? '',
    r2AccessKeyId: String(raw.r2AccessKeyId || '').trim(),
    r2SecretAccessKey: String(raw.r2SecretAccessKey || ''),
    s3Endpoint: normalizeS3Endpoint(raw.s3Endpoint) ?? '',
    s3Bucket: normalizeR2Bucket(raw.s3Bucket) ?? '',
    s3Region: normalizeS3Region(raw.s3Region) ?? DEFAULT_S3_REGION,
    s3AccessKeyId: String(raw.s3AccessKeyId || '').trim(),
    s3SecretAccessKey: String(raw.s3SecretAccessKey || ''),
    tgBotToken: String(raw.tgBotToken || '').trim(),
    tgChatId: normalizeTgChatId(raw.tgChatId) ?? '',
  };
}

/** 读渠道列表（原始存储形态）；不存在返回 null */
export async function loadChannelsState(locals: unknown): Promise<ChannelsState | null> {
  const kv = await getKV(locals);
  const raw = await kv.get(CHANNELS_KEY);
  if (!raw) return null;
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.channels)) return null;
  const channels = parsed.channels
    .map((ch: any) => sanitizeChannel(ch, locals))
    .filter((ch: StorageChannel | null): ch is StorageChannel => ch !== null);
  return { channels, activeId: String(parsed.activeId || '') };
}

/** 写渠道列表 */
export async function saveChannelsState(locals: unknown, state: ChannelsState): Promise<void> {
  const kv = await getKV(locals);
  await kv.put(CHANNELS_KEY, JSON.stringify({ channels: state.channels, activeId: state.activeId, updatedAt: new Date().toISOString() }));
}

/** 把旧单配置折算成渠道列表：所有渠道共用旧的对外路径，保证切换存储时链接不变 */
export function deriveChannelsState(legacy: WebdavConfig, locals: unknown): ChannelsState {
  const channels: StorageChannel[] = [];
  const sharedPath = legacy.linkPrefix || DEFAULT_LINK_PREFIX;
  const make = (kind: ImageStorageKind): StorageChannel => ({
    // 固定 ID 而非随机：折算结果不落盘，登记表按渠道 ID 记账，ID 必须跨请求稳定
    id: `legacy-${kind}`,
    name: kind === 'tg' ? legacy.tgChannelName : kindDefaultName(kind, locals),
    kind,
    enabled: kind === 'tg' ? legacy.tgEnabled : true,
    path: sharedPath,
    dir: legacy.dir,
    url: legacy.url,
    username: legacy.username,
    password: legacy.password,
    r2Endpoint: legacy.r2Endpoint,
    r2Bucket: legacy.r2Bucket,
    r2AccessKeyId: legacy.r2AccessKeyId,
    r2SecretAccessKey: legacy.r2SecretAccessKey,
    s3Endpoint: '',
    s3Bucket: '',
    s3Region: DEFAULT_S3_REGION,
    s3AccessKeyId: '',
    s3SecretAccessKey: '',
    tgBotToken: legacy.tgBotToken,
    tgChatId: legacy.tgChatId,
  });
  const activeKind = legacy.storage;
  const active = make(activeKind);
  channels.push(active);
  const others: Array<{ kind: ImageStorageKind; meaningful: boolean }> = [
    { kind: 'webdav', meaningful: !!legacy.url },
    { kind: 'r2', meaningful: !!(legacy.r2Endpoint || legacy.r2Bucket || legacy.r2AccessKeyId || legacy.r2SecretAccessKey) },
    { kind: 'tg', meaningful: !!(legacy.tgBotToken || legacy.tgChatId) },
  ];
  for (const other of others) {
    if (other.kind === activeKind || !other.meaningful) continue;
    channels.push(make(other.kind));
  }
  return { channels, activeId: active.id };
}

/**
 * 取渠道列表：优先读已保存的渠道；没有则把旧单配置折算（不落盘）。
 * 完全未配置（旧配置也不存在）时返回 null。
 */
export async function getChannelsState(locals: unknown): Promise<ChannelsState | null> {
  const stored = await loadChannelsState(locals).catch(() => null);
  if (stored && stored.channels.length) return stored;
  const legacy = await getLegacyWebdavConfig(locals).catch(() => null);
  if (!legacy) return stored;
  return deriveChannelsState(legacy, locals);
}

/** 图床自身选项（webp、公开页标题）仍存 webdav:config 记录里，与渠道分开 */
export async function readImghubLevel(locals: unknown): Promise<{ webp: boolean; pageTitle: string }> {
  try {
    const kv = await getKV(locals);
    const raw = await kv.get(KV_KEY);
    if (!raw) return { webp: true, pageTitle: '' };
    const parsed = JSON.parse(raw);
    return {
      webp: parsed?.webp !== false,
      pageTitle: normalizePageTitle(parsed?.pageTitle) ?? '',
    };
  } catch {
    return { webp: true, pageTitle: '' };
  }
}

/** 保存图床自身选项（合并进 webdav:config 记录，保留其余字段不动） */
export async function saveImghubLevel(locals: unknown, patch: { webp?: boolean; pageTitle?: string }): Promise<void> {
  const kv = await getKV(locals);
  let record: Record<string, unknown> = {};
  const raw = await kv.get(KV_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') record = parsed as Record<string, unknown>;
    } catch {}
  }
  if (patch.webp !== undefined) record.webp = patch.webp;
  if (patch.pageTitle !== undefined) record.pageTitle = patch.pageTitle;
  record.updatedAt = new Date().toISOString();
  await kv.put(KV_KEY, JSON.stringify(record));
}

/** 把一条渠道组装成存储层使用的有效配置（对外路径取渠道自己的路径） */
export function channelToConfig(ch: StorageChannel, level: { webp: boolean; pageTitle: string }): WebdavConfig {
  return {
    storage: ch.kind,
    channelId: ch.id,
    r2Endpoint: ch.r2Endpoint,
    r2Bucket: ch.r2Bucket,
    r2AccessKeyId: ch.r2AccessKeyId,
    r2SecretAccessKey: ch.r2SecretAccessKey,
    s3Endpoint: ch.s3Endpoint,
    s3Bucket: ch.s3Bucket,
    s3Region: ch.s3Region,
    s3AccessKeyId: ch.s3AccessKeyId,
    s3SecretAccessKey: ch.s3SecretAccessKey,
    url: ch.url,
    username: ch.username,
    password: ch.password,
    dir: ch.dir,
    tgChannelName: ch.name,
    tgEnabled: ch.enabled,
    tgBotToken: ch.tgBotToken,
    tgChatId: ch.tgChatId,
    webp: level.webp,
    linkPrefix: ch.path || DEFAULT_LINK_PREFIX,
    pageTitle: level.pageTitle,
  };
}

function pickActiveChannel(state: ChannelsState): StorageChannel | null {
  const byId = state.channels.find((ch) => ch.id === state.activeId);
  if (byId?.enabled) return byId;
  return state.channels.find((ch) => ch.enabled) ?? byId ?? state.channels[0] ?? null;
}

/** 取渠道列表与当前生效渠道（供设置页与存储管理页展示「使用中」） */
export async function getActiveChannel(locals: unknown): Promise<{ state: ChannelsState; active: StorageChannel } | null> {
  const state = await getChannelsState(locals).catch(() => null);
  if (!state || !state.channels.length) return null;
  const active = pickActiveChannel(state);
  return active ? { state, active } : null;
}

/**
 * 按对外连接路径找候选渠道并组装配置：路径可以重复（多个渠道共用一个路径，
 * 这样切换当前存储不影响图片链接），出图时按「当前渠道优先、其余按列表顺序」
 * 依次找持有该文件的渠道。停用渠道不参与出图。
 */
export async function getChannelConfigsByPath(locals: unknown, path: string): Promise<WebdavConfig[]> {
  const state = await getChannelsState(locals).catch(() => null);
  if (!state) return [];
  const level = await readImghubLevel(locals);
  const matches = state.channels.filter((item) => item.path === path && item.enabled);
  matches.sort((a, b) => (a.id === state.activeId ? 0 : 1) - (b.id === state.activeId ? 0 : 1));
  return matches.map((ch) => channelToConfig(ch, level));
}

/** 按渠道 ID 取原始渠道记录；不存在返回 null */
export async function getChannelById(locals: unknown, id: string): Promise<StorageChannel | null> {
  const state = await getChannelsState(locals).catch(() => null);
  return state?.channels.find((item) => item.id === id) ?? null;
}

/**
 * 按渠道 ID 组装配置（管理操作用：改名/移动/删除）。
 * forManage 时管理动作可作用于已停用渠道（Telegram 的启用闸门只管公开上传与出图）。
 */
export async function getChannelConfigById(
  locals: unknown,
  id: string,
  opts?: { forManage?: boolean },
): Promise<WebdavConfig | null> {
  const ch = await getChannelById(locals, id);
  if (!ch) return null;
  const cfg = channelToConfig(ch, await readImghubLevel(locals));
  if (opts?.forManage && cfg.storage === 'tg') cfg.tgEnabled = true;
  return cfg;
}

/** 是否有渠道占用该对外路径（含停用渠道） */
export async function hasChannelPath(locals: unknown, path: string): Promise<boolean> {
  const state = await getChannelsState(locals).catch(() => null);
  return !!state?.channels.some((item) => item.path === path);
}

/** 渠道的公开视图：密码/密钥/令牌一律只给 has 布尔值 */
export function channelToPublic(ch: StorageChannel): StorageChannelPublic {
  return {
    id: ch.id,
    name: ch.name,
    kind: ch.kind,
    enabled: ch.enabled,
    path: ch.path,
    dir: ch.dir,
    url: ch.url,
    username: ch.username,
    hasPassword: ch.password.length > 0,
    r2Endpoint: ch.r2Endpoint,
    r2Bucket: ch.r2Bucket,
    r2AccessKeyId: ch.r2AccessKeyId,
    hasR2Secret: ch.r2SecretAccessKey.length > 0,
    s3Endpoint: ch.s3Endpoint,
    s3Bucket: ch.s3Bucket,
    s3Region: ch.s3Region,
    s3AccessKeyId: ch.s3AccessKeyId,
    hasS3Secret: ch.s3SecretAccessKey.length > 0,
    hasTgBotToken: ch.tgBotToken.length > 0,
    hasTgChatId: ch.tgChatId.length > 0,
  };
}

/**
 * 当前有效图床配置：有渠道列表时取「当前渠道」组装（对外路径为该渠道的路径，
 * webp/标题取图床自身选项）；没有渠道列表时回退旧单配置。完全未配置时抛 notConfigured。
 */
export async function getWebdavConfig(locals: unknown): Promise<WebdavConfig> {
  const state = await getChannelsState(locals).catch(() => null);
  if (state && state.channels.length) {
    const active = pickActiveChannel(state);
    if (active) return channelToConfig(active, await readImghubLevel(locals));
  }
  return getLegacyWebdavConfig(locals);
}

/** 去掉密码后的公开视图（给 GET /api/settings 用） */
export function toPublic(cfg: WebdavConfig): WebdavConfigPublic {
  return {
    storage: cfg.storage,
    r2Endpoint: cfg.r2Endpoint,
    r2Bucket: cfg.r2Bucket,
    r2AccessKeyId: cfg.r2AccessKeyId,
    hasR2Secret: cfg.r2SecretAccessKey.length > 0,
    s3Endpoint: cfg.s3Endpoint,
    s3Bucket: cfg.s3Bucket,
    s3Region: cfg.s3Region,
    s3AccessKeyId: cfg.s3AccessKeyId,
    hasS3Secret: cfg.s3SecretAccessKey.length > 0,
    url: cfg.url,
    username: cfg.username,
    dir: cfg.dir,
    hasPassword: cfg.password.length > 0,
    tgChannelName: cfg.tgChannelName,
    tgEnabled: cfg.tgEnabled,
    hasTgBotToken: cfg.tgBotToken.length > 0,
    hasTgChatId: cfg.tgChatId.length > 0,
    webp: cfg.webp,
    linkPrefix: cfg.linkPrefix,
    pageTitle: cfg.pageTitle,
  };
}
