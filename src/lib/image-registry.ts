import { getD1Binding, getMetaStore, isEdgeOne, type D1Like } from './platform';

/**
 * 图片登记表：每张图一条记录，只记「文件名 + 渠道 ID + 大小 + 时间」，
 * Telegram 的图另存 fileId / messageId（读图与删消息要用）。
 * 归属判断、出图定位、管理页分组都查这张表，不再挨个渠道现查目录。
 *
 * 存储后端与账本一致：Cloudflare 绑了 D1（ADMIN_D1）时用 D1 的 images 表
 * （一行一条）；否则整表存配置存储里一个 JSON 键（images:registry）；
 * EdgeOne 走 Blob 配置存储里的同一个键。
 */

export interface ImageRecord {
  filename: string;
  channelId: string;
  size: number;
  /** ISO 时间字符串 */
  lastmod: string;
  /** 逻辑目录（渠道的上传目录）：Telegram 没有真实目录，靠这条记录按目录归属；
      文件类渠道的目录由实物位置决定，此字段可缺省 */
  dir?: string;
  tgFileId?: string;
  tgMessageId?: number;
}

const REGISTRY_KEY = 'images:registry';

function useD1(locals: unknown): D1Like | null {
  if (isEdgeOne(locals)) return null;
  return getD1Binding(locals);
}

let d1ImagesReady: Promise<void> | null = null;

function ensureD1ImagesTable(db: D1Like): Promise<void> {
  if (!d1ImagesReady) {
    d1ImagesReady = db
      .prepare(
        'CREATE TABLE IF NOT EXISTS images (' +
          'channel_id TEXT NOT NULL, filename TEXT NOT NULL, ' +
          'size INTEGER NOT NULL DEFAULT 0, lastmod TEXT NOT NULL DEFAULT \'\', ' +
          'tg_file_id TEXT, tg_message_id INTEGER, ' +
          'PRIMARY KEY (channel_id, filename))',
      )
      .run()
      .then(() => undefined)
      .catch(() => {
        d1ImagesReady = null;
      });
  }
  return d1ImagesReady;
}

interface ImageRow {
  channel_id: string;
  filename: string;
  size: number;
  lastmod: string;
  tg_file_id: string | null;
  tg_message_id: number | null;
}

function rowToRecord(row: ImageRow): ImageRecord {
  const rec: ImageRecord = {
    channelId: row.channel_id,
    filename: row.filename,
    size: Number(row.size) || 0,
    lastmod: row.lastmod || '',
  };
  if (row.tg_file_id) rec.tgFileId = row.tg_file_id;
  if (typeof row.tg_message_id === 'number') rec.tgMessageId = row.tg_message_id;
  return rec;
}

/* ---------------- JSON 后端（KV / Blob） ---------------- */

async function jsonLoad(locals: unknown): Promise<ImageRecord[]> {
  const store = await getMetaStore(locals);
  if (!store) return [];
  const raw = await store.get(REGISTRY_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (it): it is ImageRecord =>
        it && typeof it.filename === 'string' && typeof it.channelId === 'string',
    );
  } catch {
    return [];
  }
}

async function jsonSave(locals: unknown, items: ImageRecord[]): Promise<void> {
  const store = await getMetaStore(locals);
  if (!store) throw { status: 500, message: '配置存储不可用：无法保存图片登记表' };
  await store.put(REGISTRY_KEY, JSON.stringify(items));
}

/* ---------------- 对外接口 ---------------- */

/** 登记表全部记录 */
export async function registryListAll(locals: unknown): Promise<ImageRecord[]> {
  const db = useD1(locals);
  if (db) {
    await ensureD1ImagesTable(db);
    const res = await db
      .prepare('SELECT channel_id, filename, size, lastmod, tg_file_id, tg_message_id, dir FROM images')
      .all<ImageRow>();
    return (res.results ?? []).map(rowToRecord);
  }
  return jsonLoad(locals);
}

/** 某个渠道名下的全部记录 */
export async function registryListByChannel(locals: unknown, channelId: string): Promise<ImageRecord[]> {
  const db = useD1(locals);
  if (db) {
    await ensureD1ImagesTable(db);
    const res = await db
      .prepare('SELECT channel_id, filename, size, lastmod, tg_file_id, tg_message_id, dir FROM images WHERE channel_id = ?')
      .bind(channelId)
      .all<ImageRow>();
    return (res.results ?? []).map(rowToRecord);
  }
  return (await jsonLoad(locals)).filter((it) => it.channelId === channelId);
}

/** 按文件名找记录（可能命中多个渠道） */
export async function registryFindByFilename(locals: unknown, filename: string): Promise<ImageRecord[]> {
  const db = useD1(locals);
  if (db) {
    await ensureD1ImagesTable(db);
    const res = await db
      .prepare('SELECT channel_id, filename, size, lastmod, tg_file_id, tg_message_id, dir FROM images WHERE filename = ?')
      .bind(filename)
      .all<ImageRow>();
    return (res.results ?? []).map(rowToRecord);
  }
  return (await jsonLoad(locals)).filter((it) => it.filename === filename);
}

/** 取一条记录；不存在返回 null */
export async function registryGet(locals: unknown, channelId: string, filename: string): Promise<ImageRecord | null> {
  const db = useD1(locals);
  if (db) {
    await ensureD1ImagesTable(db);
    const row = await db
      .prepare('SELECT channel_id, filename, size, lastmod, tg_file_id, tg_message_id, dir FROM images WHERE channel_id = ? AND filename = ?')
      .bind(channelId, filename)
      .first<ImageRow>();
    return row ? rowToRecord(row) : null;
  }
  return (await jsonLoad(locals)).find((it) => it.channelId === channelId && it.filename === filename) ?? null;
}

/**
 * 新增或更新一条记录。合并规则：新记录没带的 Telegram 字段保留旧值
 * （管理页对账回填时只有文件名/大小/时间，不能把 fileId 冲掉）。
 */
export async function registryUpsert(locals: unknown, rec: ImageRecord): Promise<void> {
  const db = useD1(locals);
  if (db) {
    await ensureD1ImagesTable(db);
    const old = await registryGet(locals, rec.channelId, rec.filename);
    await db
      .prepare(
        'INSERT OR REPLACE INTO images (channel_id, filename, size, lastmod, tg_file_id, tg_message_id, dir) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        rec.channelId,
        rec.filename,
        rec.size || 0,
        rec.lastmod || '',
        rec.tgFileId ?? old?.tgFileId ?? null,
        rec.tgMessageId ?? old?.tgMessageId ?? null,
        rec.dir ?? old?.dir ?? null,
      )
      .run();
    return;
  }
  const items = await jsonLoad(locals);
  const at = items.findIndex((it) => it.channelId === rec.channelId && it.filename === rec.filename);
  if (at >= 0) {
    const old = items[at];
    items[at] = {
      ...rec,
      tgFileId: rec.tgFileId ?? old.tgFileId,
      tgMessageId: rec.tgMessageId ?? old.tgMessageId,
      dir: rec.dir ?? old.dir,
    };
  } else {
    items.push(rec);
  }
  await jsonSave(locals, items);
}

/** 删除一条记录；不存在时静默通过 */
export async function registryRemove(locals: unknown, channelId: string, filename: string): Promise<void> {
  const db = useD1(locals);
  if (db) {
    await ensureD1ImagesTable(db);
    await db
      .prepare('DELETE FROM images WHERE channel_id = ? AND filename = ?')
      .bind(channelId, filename)
      .run();
    return;
  }
  const items = await jsonLoad(locals);
  const next = items.filter((it) => !(it.channelId === channelId && it.filename === filename));
  if (next.length !== items.length) await jsonSave(locals, next);
}
