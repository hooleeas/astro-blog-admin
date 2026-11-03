// 图片存储层：按设置里的存储方式（WebDAV / Cloudflare R2）统一提供存取接口。
// WebDAV 实现沿用原有逻辑；R2 走 S3 兼容接口（aws4fetch 签名，原生 fetch，Workers 可用）。
// EdgeOne 运行时（platform 层判定）：「R2」这一档改走 EdgeOne Blob 对象存储，不用 S3 密钥。
// 注意：不要用默认入口 'webdav'（依赖 node-fetch），'webdav/web' 是官方自包含 web 构建。
import { createClient } from 'webdav/web';
import { AwsClient } from 'aws4fetch';
import { getBinding, getImageBlobStore, getKVStore } from './platform';
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

/* ---------------- Telegram 渠道 ----------------
 * 图片以「文件」（sendDocument）形式发进指定频道/群，避免按照片发送被 Telegram 压缩。
 * Telegram 没有列目录接口：文件名 → file_id / message_id 的清单自存在配置存储（tg:index），
 * 列表/查重/删除都查这份清单；读取时先 getFile 换取下载路径再拉原文件（路径现取现用）。
 * 图片对外仍走本站 /<前缀>/<文件名> 路由由服务器中转，机器人令牌不出现在任何链接里。
 */

interface TgIndexItem {
  filename: string;
  fileId: string;
  messageId: number;
  size: number;
  /** ISO 时间字符串 */
  lastmod: string;
}

const TG_INDEX_KEY = 'tg:index';

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

async function tgLoadIndex(locals: unknown): Promise<TgIndexItem[]> {
  const kv = await getKVStore(locals);
  if (!kv) fail(500, '配置存储不可用（KV 未绑定）：无法读取 Telegram 图片清单');
  const raw = await kv!.get(TG_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (it): it is TgIndexItem =>
        it && typeof it.filename === 'string' && typeof it.fileId === 'string' && typeof it.messageId === 'number',
    );
  } catch {
    return [];
  }
}

async function tgSaveIndex(locals: unknown, items: TgIndexItem[]): Promise<void> {
  const kv = await getKVStore(locals);
  if (!kv) fail(500, '配置存储不可用（KV 未绑定）：无法保存 Telegram 图片清单');
  await kv!.put(TG_INDEX_KEY, JSON.stringify(items));
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

export async function storeFileExists(locals: unknown, cfg: WebdavConfig, filename: string): Promise<boolean> {
  if (cfg.storage === 'tg') {
    requireTg(cfg);
    const index = await tgLoadIndex(locals);
    return index.some((it) => it.filename === filename);
  }
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
  if (cfg.storage === 'tg') {
    requireTg(cfg);
    const form = new FormData();
    form.set('chat_id', cfg.tgChatId);
    form.set('caption', filename);
    form.set('document', new Blob([data], { type: imageContentType(filename) }), filename);
    const message = await tgApi(cfg, 'sendDocument', form, true);
    const doc = message?.document;
    if (!doc?.file_id || typeof message?.message_id !== 'number') {
      fail(502, 'Telegram sendDocument 失败：返回数据不完整');
    }
    const index = await tgLoadIndex(locals);
    const existing = index.findIndex((it) => it.filename === filename);
    const item: TgIndexItem = {
      filename,
      fileId: doc.file_id,
      messageId: message.message_id,
      size: typeof doc.file_size === 'number' ? doc.file_size : data.byteLength,
      lastmod: new Date().toISOString(),
    };
    if (existing >= 0) {
      const old = index[existing];
      index[existing] = item;
      // 同名覆盖：旧消息尽力删掉（失败不影响新图已存入）
      await tgApi(cfg, 'deleteMessage', { chat_id: cfg.tgChatId, message_id: old.messageId }).catch(() => {});
    } else {
      index.push(item);
    }
    await tgSaveIndex(locals, index);
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
  if (cfg.storage === 'tg') {
    requireTg(cfg);
    const index = await tgLoadIndex(locals);
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
  if (cfg.storage === 'tg') {
    requireTg(cfg);
    const index = await tgLoadIndex(locals);
    return index.map((it) => ({ filename: it.filename, size: it.size, lastmod: it.lastmod }));
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
  if (cfg.storage === 'tg') {
    requireTg(cfg);
    const index = await tgLoadIndex(locals);
    const at = index.findIndex((it) => it.filename === filename);
    if (at >= 0) {
      const [item] = index.splice(at, 1);
      // 频道里的原消息尽力删除（消息可能已被手动删掉，失败不拦清单移除）
      await tgApi(cfg, 'deleteMessage', { chat_id: cfg.tgChatId, message_id: item.messageId }).catch(() => {});
      await tgSaveIndex(locals, index);
    }
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
    const res = await r2Client(cfg).fetch(r2ObjectUrl(cfg, filename), { method: 'DELETE' });
    if (!res.ok && res.status !== 204) await r2Error(res, '删除');
    return;
  }
  const client = webdavClient(cfg);
  await client.deleteFile(`/${imageDir(cfg)}/${filename}`);
}
