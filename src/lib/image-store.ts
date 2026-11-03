// 图片存储层：按设置里的存储方式（WebDAV / Cloudflare R2）统一提供存取接口。
// WebDAV 实现沿用原有逻辑；R2 走 S3 兼容接口（aws4fetch 签名，原生 fetch，Workers 可用）。
// EdgeOne 运行时（platform 层判定）：「R2」这一档改走 EdgeOne Blob 对象存储，不用 S3 密钥。
// 注意：不要用默认入口 'webdav'（依赖 node-fetch），'webdav/web' 是官方自包含 web 构建。
import { createClient } from 'webdav/web';
import { AwsClient } from 'aws4fetch';
import { getBinding, getImageBlobStore } from './platform';
import { imageDir, type WebdavConfig } from './webdav-config';
import {
  registryListByChannel,
  registryUpsert,
  registryRemove,
} from './image-registry';

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
function requireS3(cfg: WebdavConfig): void {
  if (!cfg.s3Endpoint || !cfg.s3Bucket || !cfg.s3AccessKeyId || !cfg.s3SecretAccessKey) {
    fail(500, 'S3 渠道参数不完整：请先到「存储」页填写端点、存储桶与密钥');
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

/* ---------------- S3 兼容存储（R2 密钥模式与 S3 渠道共用） ---------------- */

interface S3Params {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 报错文案里的存储名（Cloudflare R2 / S3） */
  label: string;
}

function r2S3Params(cfg: WebdavConfig): S3Params {
  requireR2(cfg);
  return {
    endpoint: cfg.r2Endpoint,
    bucket: cfg.r2Bucket,
    region: 'auto',
    accessKeyId: cfg.r2AccessKeyId,
    secretAccessKey: cfg.r2SecretAccessKey,
    label: 'Cloudflare R2',
  };
}

function s3Params(cfg: WebdavConfig): S3Params {
  requireS3(cfg);
  return {
    endpoint: cfg.s3Endpoint,
    bucket: cfg.s3Bucket,
    region: cfg.s3Region || 'auto',
    accessKeyId: cfg.s3AccessKeyId,
    secretAccessKey: cfg.s3SecretAccessKey,
    label: 'S3',
  };
}

function s3Client(p: S3Params): AwsClient {
  return new AwsClient({
    accessKeyId: p.accessKeyId,
    secretAccessKey: p.secretAccessKey,
    service: 's3',
    region: p.region,
  });
}

function s3ObjectUrl(p: S3Params, cfg: WebdavConfig, filename: string): string {
  const key = `${imageDir(cfg)}/${filename}`;
  const encodedKey = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `${p.endpoint}/${p.bucket}/${encodedKey}`;
}

async function s3Error(res: Response, action: string, label: string): Promise<never> {
  let detail = '';
  try {
    const text = await res.text();
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    detail = code ? `：${code}` : '';
  } catch {}
  fail(502, `${label} ${action}失败（${res.status}）${detail}`);
}

/** 测试 S3 渠道连通性：签一个列桶请求（只列 1 条），通了即参数可用 */
export async function testS3Connection(p: {
  endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string;
}): Promise<void> {
  const params: S3Params = { ...p, label: 'S3' };
  const res = await s3Client(params).fetch(`${p.endpoint}/${p.bucket}?list-type=2&max-keys=1`);
  if (!res.ok) await s3Error(res, '连接测试', 'S3');
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ---------------- Telegram 渠道 ----------------
 * 图片以「文件」（sendDocument）形式发进指定频道/群，避免按照片发送被 Telegram 压缩。
 * Telegram 没有列目录接口：文件名 → file_id / message_id 存图片登记表
 * （该渠道名下的记录，见 image-registry.ts），列表/查重/删除都查登记表；
 * 读取时先 getFile 换取下载路径再拉原文件（路径现取现用）。
 * 图片对外仍走本站 /<路径>/<文件名> 路由由服务器中转，机器人令牌不出现在任何链接里。
 */

interface TgIndexItem {
  filename: string;
  fileId: string;
  messageId: number;
  size: number;
  /** ISO 时间字符串 */
  lastmod: string;
  /** 逻辑目录（渠道上传目录）：Telegram 没有真实目录，靠登记记录上的这个字段归属 */
  dir?: string;
}

/** 登记表里该 Telegram 渠道的键：优先渠道 ID，旧单配置形态回退到会话维度 */
function tgRegKey(cfg: WebdavConfig): string {
  return cfg.channelId ?? `tg:${cfg.tgChatId}`;
}

function requireTg(cfg: WebdavConfig): void {
  if (!cfg.tgEnabled) fail(500, 'Telegram 渠道未启用，请先到图床设置页启用该渠道');
  if (!cfg.tgBotToken || !cfg.tgChatId) {
    fail(500, '未配置 Telegram：请先到图床设置页填写 Bot Token 与 Chat ID');
  }
}

async function tgApi(cfg: WebdavConfig, method: string, body?: unknown, isForm = false): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${cfg.tgBotToken}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'content-type': 'application/json' },
      body: isForm ? (body as FormData) : JSON.stringify(body ?? {}),
    });
  } catch (e) {
    fail(502, `Telegram ${method} 请求失败：网络错误（${(e as Error)?.message || String(e)}）`);
  }
  const data: any = await res!.json().catch(() => null);
  if (!res!.ok || !data?.ok) {
    fail(502, `Telegram ${method} 失败：${data?.description || `HTTP ${res!.status}`}`);
  }
  return data.result;
}

async function tgLoadIndex(locals: unknown, cfg: WebdavConfig): Promise<TgIndexItem[]> {
  const dir = imageDir(cfg);
  const records = await registryListByChannel(locals, tgRegKey(cfg));
  return records
    .filter((it) => typeof it.tgFileId === 'string' && typeof it.tgMessageId === 'number')
    // 按目录认：记录带了目录就只在该目录下可见；没带目录的是早期记录，不分目录都认（不弄丢）
    .filter((it) => !it.dir || it.dir === dir)
    .map((it) => ({
      filename: it.filename,
      fileId: it.tgFileId as string,
      messageId: it.tgMessageId as number,
      size: it.size,
      lastmod: it.lastmod,
      dir: it.dir,
    }));
}

async function tgSaveIndex(locals: unknown, cfg: WebdavConfig, items: TgIndexItem[]): Promise<void> {
  const key = tgRegKey(cfg);
  const dir = imageDir(cfg);
  const current = await registryListByChannel(locals, key);
  const keep = new Set(items.map((it) => it.filename));
  for (const rec of current) {
    if (keep.has(rec.filename)) continue;
    // 只销本目录范围内的记录（没带目录的早期记录也在范围内）；其他目录的记录不动
    if (!rec.dir || rec.dir === dir) await registryRemove(locals, key, rec.filename);
  }
  for (const it of items) {
    await registryUpsert(locals, {
      filename: it.filename,
      channelId: key,
      size: it.size,
      lastmod: it.lastmod,
      tgFileId: it.fileId,
      tgMessageId: it.messageId,
      dir: it.dir,
    });
  }
}

/** 测试 Telegram 渠道连通性：验令牌、验会话可达、验机器人在会话内的身份（频道须为管理员） */
export async function testTelegramConnection(
  botToken: string,
  chatId: string,
): Promise<{ botUsername: string; chatLabel: string }> {
  const probe = { tgBotToken: botToken, tgChatId: chatId, tgEnabled: true } as WebdavConfig;
  const me = await tgApi(probe, 'getMe');
  const chat = await tgApi(probe, 'getChat', { chat_id: chatId }).catch((e) => {
    const ce = e as StoreError;
    throw {
      status: 502,
      message: `连接失败：机器人无法访问该会话（${ce.message.replace(/^Telegram getChat 失败：/, '')}），请确认 Chat ID 正确、且机器人已加入该频道/群`,
    } as StoreError;
  });
  const member = await tgApi(probe, 'getChatMember', { chat_id: chatId, user_id: me.id }).catch(() => null);
  const status = member?.status as string | undefined;
  if (status === 'left' || status === 'kicked') {
    fail(400, '连接失败：机器人不在该频道/群里，请先把机器人加入并设为管理员');
  }
  if ((chat.type === 'channel') && status !== 'administrator' && status !== 'creator') {
    fail(400, '连接失败：机器人在该频道里不是管理员，无法发送图片，请把机器人设为频道管理员');
  }
  const kindLabel = chat.type === 'channel' ? '频道' : chat.type === 'supergroup' || chat.type === 'group' ? '群组' : '会话';
  const title = chat.title || chat.username || String(chat.id);
  return { botUsername: me.username ? `@${me.username}` : String(me.id), chatLabel: `${kindLabel}「${title}」` };
}

/* ---------------- 统一接口 ---------------- */

/** 登记表里该配置所属渠道的键（channelToConfig/旧配置读取都会带 channelId，此处仅兜底） */
function regChannelId(cfg: WebdavConfig): string {
  return cfg.channelId ?? `legacy-${cfg.storage}`;
}

export async function storeFileExists(locals: unknown, cfg: WebdavConfig, filename: string): Promise<boolean> {
  if (cfg.storage === 'tg') {
    requireTg(cfg);
    const index = await tgLoadIndex(locals, cfg);
    return index.some((it) => it.filename === filename);
  }
  if (cfg.storage === 's3') {
    const p = s3Params(cfg);
    const res = await s3Client(p).fetch(s3ObjectUrl(p, cfg, filename), { method: 'HEAD' });
    return res.ok;
  }
  if (cfg.storage === 'r2') {
    const bucket = getR2Binding(locals);
    if (bucket) return (await bucket.head(r2Key(cfg, filename))) !== null;
    const blob = await getImageBlobStore(locals);
    if (blob) return blob.exists(r2Key(cfg, filename));
    const p = r2S3Params(cfg);
    const res = await s3Client(p).fetch(s3ObjectUrl(p, cfg, filename), { method: 'HEAD' });
    return res.ok;
  }
  const client = webdavClient(cfg);
  return client.exists(`/${imageDir(cfg)}/${filename}`);
}

/** 存图并登记：非 Telegram 渠道存成功后在图片登记表记一条（Telegram 的登记即其清单，分支内已维护） */
export async function storePutFile(locals: unknown, cfg: WebdavConfig, filename: string, data: ArrayBuffer): Promise<void> {
  await storePutFileRaw(locals, cfg, filename, data);
  if (cfg.storage !== 'tg') {
    await registryUpsert(locals, {
      filename,
      channelId: regChannelId(cfg),
      size: data.byteLength,
      lastmod: new Date().toISOString(),
    });
  }
}

async function storePutFileRaw(locals: unknown, cfg: WebdavConfig, filename: string, data: ArrayBuffer): Promise<void> {
  if (cfg.storage === 'tg') {
    requireTg(cfg);
    const form = new FormData();
    form.set('chat_id', cfg.tgChatId);
    form.set('caption', filename);
    form.set('document', new Blob([data], { type: imageContentType(filename) }), filename);
    const message = await tgApi(cfg, 'sendDocument', form, true);
    // Telegram 对 webp 有特殊处理：文件会被当作贴纸收下，返回消息里没有 document、
    // 文件信息在 sticker 字段（file_id / file_size 齐全，出图照样走 getFile）
    const doc = message?.document ?? message?.sticker;
    if (!doc?.file_id || typeof message?.message_id !== 'number') {
      fail(502, 'Telegram sendDocument 失败：返回数据不完整');
    }
    const index = await tgLoadIndex(locals, cfg);
    const existing = index.findIndex((it) => it.filename === filename);
    const item: TgIndexItem = {
      filename,
      fileId: doc.file_id,
      messageId: message.message_id,
      size: typeof doc.file_size === 'number' ? doc.file_size : data.byteLength,
      lastmod: new Date().toISOString(),
      dir: imageDir(cfg),
    };
    if (existing >= 0) {
      const old = index[existing];
      index[existing] = item;
      // 同名覆盖：旧消息尽力删掉（失败不影响新图已存入）
      await tgApi(cfg, 'deleteMessage', { chat_id: cfg.tgChatId, message_id: old.messageId }).catch(() => {});
    } else {
      index.push(item);
    }
    await tgSaveIndex(locals, cfg, index);
    return;
  }
  if (cfg.storage === 's3') {
    const p = s3Params(cfg);
    const res = await s3Client(p).fetch(s3ObjectUrl(p, cfg, filename), {
      method: 'PUT',
      body: data,
      headers: { 'content-type': imageContentType(filename) },
    });
    if (!res.ok) await s3Error(res, '上传', p.label);
    return;
  }
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
    const p = r2S3Params(cfg);
    const res = await s3Client(p).fetch(s3ObjectUrl(p, cfg, filename), {
      method: 'PUT',
      body: data,
      headers: { 'content-type': imageContentType(filename) },
    });
    if (!res.ok) await s3Error(res, '上传', p.label);
    return;
  }
  await webdavEnsureDir(cfg);
  const client = webdavClient(cfg);
  await client.putFileContents(`/${imageDir(cfg)}/${filename}`, data, { overwrite: false });
}

export async function storeGetFile(locals: unknown, cfg: WebdavConfig, filename: string): Promise<Uint8Array> {
  if (cfg.storage === 'tg') {
    requireTg(cfg);
    const index = await tgLoadIndex(locals, cfg);
    const item = index.find((it) => it.filename === filename);
    if (!item) fail(404, '图片不存在');
    const file = await tgApi(cfg, 'getFile', { file_id: item!.fileId });
    if (!file?.file_path) fail(502, 'Telegram getFile 失败：未返回文件路径');
    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/file/bot${cfg.tgBotToken}/${file.file_path}`);
    } catch (e) {
      fail(502, `Telegram 文件下载失败：网络错误（${(e as Error)?.message || String(e)}）`);
    }
    if (!res!.ok) fail(502, `Telegram 文件下载失败（${res!.status}）`);
    return new Uint8Array(await res!.arrayBuffer());
  }
  if (cfg.storage === 's3') {
    const p = s3Params(cfg);
    const res = await s3Client(p).fetch(s3ObjectUrl(p, cfg, filename));
    if (!res.ok) await s3Error(res, '读取', p.label);
    return new Uint8Array(await res.arrayBuffer());
  }
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
    const p = r2S3Params(cfg);
    const res = await s3Client(p).fetch(s3ObjectUrl(p, cfg, filename));
    if (!res.ok) await s3Error(res, '读取', p.label);
    return new Uint8Array(await res.arrayBuffer());
  }
  const client = webdavClient(cfg);
  const data = await client.getFileContents(`/${imageDir(cfg)}/${filename}`);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as unknown as ArrayLike<number>);
}

/** S3 协议列目录（R2 密钥模式与 S3 渠道共用）：ListObjects V2 + XML 解析 */
async function s3ListFiles(p: S3Params, cfg: WebdavConfig): Promise<StoredImage[]> {
  const prefix = `${imageDir(cfg)}/`;
  const url = `${p.endpoint}/${p.bucket}?list-type=2&encoding-type=url&prefix=${encodeURIComponent(prefix)}`;
  const res = await s3Client(p).fetch(url);
  if (!res.ok) await s3Error(res, '读取列表', p.label);
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

export async function storeListFiles(locals: unknown, cfg: WebdavConfig): Promise<StoredImage[]> {
  if (cfg.storage === 'tg') {
    requireTg(cfg);
    const index = await tgLoadIndex(locals, cfg);
    return index.map((it) => ({ filename: it.filename, size: it.size, lastmod: it.lastmod }));
  }
  if (cfg.storage === 's3') {
    return s3ListFiles(s3Params(cfg), cfg);
  }
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
    return s3ListFiles(r2S3Params(cfg), cfg);
  }
  const client = webdavClient(cfg);
  const directory = `/${imageDir(cfg)}`;
  if (!await client.exists(directory)) return [];
  const files = await client.getDirectoryContents(directory);
  return files
    .filter((file) => file.type === 'file')
    .map((file) => ({ filename: file.basename, size: file.size, lastmod: file.lastmod }));
}

/** 删图并销登记：非 Telegram 渠道删成功后移除登记表记录（Telegram 的登记即其清单，分支内已维护） */
export async function storeDeleteFile(locals: unknown, cfg: WebdavConfig, filename: string): Promise<void> {
  await storeDeleteFileRaw(locals, cfg, filename);
  if (cfg.storage !== 'tg') {
    await registryRemove(locals, regChannelId(cfg), filename);
  }
}

async function storeDeleteFileRaw(locals: unknown, cfg: WebdavConfig, filename: string): Promise<void> {
  if (cfg.storage === 'tg') {
    requireTg(cfg);
    const index = await tgLoadIndex(locals, cfg);
    const at = index.findIndex((it) => it.filename === filename);
    if (at >= 0) {
      const [item] = index.splice(at, 1);
      // 频道里的原消息尽力删除（消息可能已被手动删掉，失败不拦清单移除）
      await tgApi(cfg, 'deleteMessage', { chat_id: cfg.tgChatId, message_id: item.messageId }).catch(() => {});
      await tgSaveIndex(locals, cfg, index);
    }
    return;
  }
  if (cfg.storage === 's3') {
    const p = s3Params(cfg);
    const res = await s3Client(p).fetch(s3ObjectUrl(p, cfg, filename), { method: 'DELETE' });
    if (!res.ok && res.status !== 204) await s3Error(res, '删除', p.label);
    return;
  }
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
    const p = r2S3Params(cfg);
    const res = await s3Client(p).fetch(s3ObjectUrl(p, cfg, filename), { method: 'DELETE' });
    if (!res.ok && res.status !== 204) await s3Error(res, '删除', p.label);
    return;
  }
  const client = webdavClient(cfg);
  await client.deleteFile(`/${imageDir(cfg)}/${filename}`);
}
