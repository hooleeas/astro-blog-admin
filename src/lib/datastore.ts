import {
  getBinding,
  getD1Binding,
  resolveDataStore,
  ensureD1MetaTable,
  DATASTORE_PREF_KEY,
  type DataStoreKind,
  type D1Like,
} from './platform';
import { ensureD1ImagesTable, type ImageRecord } from './image-registry';

/**
 * 数据存储搬家（仅 Cloudflare）：把账本整体从 KV 搬到 D1、或反向搬回 KV。
 * 搬家语义（用户定）：拷贝到目标端并校验条数一致后，源端彻底清空，一个键、
 * 一行都不留，只留一份数据。标记（settings:datastore）随数据一起搬：写进
 * 目标端（D1 时是 meta 表的一行，KV 时是普通数据键），表示「当前生效的是谁」；
 * 判定逻辑先查 D1 的标记，所以标记必须在清空源端之前先落进目标端，
 * 中途失败时标记还在源端、应用继续按旧存储读，不会丢账。
 *
 * 搬家范围 = ADMIN_KV 命名空间里的全部键（该命名空间为本应用专用）：
 * - 一般键 → D1 的 meta 表（反向同理）；
 * - images:registry 这个 JSON 键 ↔ D1 的 images 表逐条对应。
 */

const REGISTRY_KEY = 'images:registry';

interface RawKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

function rawKv(locals: unknown): RawKv {
  const b = getBinding(locals, 'ADMIN_KV');
  if (!b || typeof b.get !== 'function' || typeof b.list !== 'function') {
    throw { status: 500, message: 'KV 绑定不可用，无法搬家' };
  }
  return b as RawKv;
}

async function listAllKvKeys(kv: RawKv): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await kv.list(cursor ? { cursor } : undefined);
    for (const k of page.keys ?? []) names.push(k.name);
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return names;
}

interface ImageRowFull {
  channel_id: string;
  filename: string;
  size: number;
  lastmod: string;
  tg_file_id: string | null;
  tg_message_id: number | null;
  dir: string | null;
}

function validRecords(records: unknown[]): ImageRecord[] {
  return records.filter(
    (r): r is ImageRecord =>
      !!r &&
      typeof (r as ImageRecord).filename === 'string' &&
      typeof (r as ImageRecord).channelId === 'string',
  );
}

/** 把数据存储从当前生效端搬到 target；已在 target 时不动。返回搬动的条数。 */
export async function migrateDataStore(
  locals: unknown,
  target: DataStoreKind,
): Promise<{ metaKeys: number; images: number }> {
  const db = getD1Binding(locals);
  if (!db) {
    throw {
      status: 400,
      message: '未检测到 D1 绑定（ADMIN_D1），请先在 Cloudflare Pages 里绑定 D1 数据库',
    };
  }
  const state = await resolveDataStore(locals);
  if (state.kind === target) return { metaKeys: 0, images: 0 };
  const kv = rawKv(locals);
  await ensureD1MetaTable(db);
  await ensureD1ImagesTable(db);
  return target === 'd1' ? moveToD1(kv, db) : moveToKv(kv, db);
}

async function moveToD1(kv: RawKv, db: D1Like): Promise<{ metaKeys: number; images: number }> {
  // KV 的全部键都要搬走/清掉（含旧标记键），一个不留
  const names = await listAllKvKeys(kv);
  const metaEntries: [string, string][] = [];
  let records: ImageRecord[] = [];
  for (const name of names) {
    const value = await kv.get(name);
    if (value === null) continue;
    if (name === REGISTRY_KEY) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) records = validRecords(parsed);
      } catch {
        records = [];
      }
    } else if (name !== DATASTORE_PREF_KEY) {
      // 标记键不按原值拷贝：下面统一在 D1 里写 'd1'
      metaEntries.push([name, value]);
    }
  }

  for (const [k, v] of metaEntries) {
    await db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .bind(k, v)
      .run();
  }
  // 标记最后落进 D1：从这一行起，判定逻辑认 D1 为当前存储
  await db
    .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .bind(DATASTORE_PREF_KEY, 'd1')
    .run();
  for (const rec of records) {
    await db
      .prepare(
        'INSERT OR REPLACE INTO images (channel_id, filename, size, lastmod, tg_file_id, tg_message_id, dir) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        rec.channelId,
        rec.filename,
        rec.size || 0,
        rec.lastmod || '',
        rec.tgFileId ?? null,
        rec.tgMessageId ?? null,
        rec.dir ?? null,
      )
      .run();
  }

  // 校验条数（目标端只多不少于本次搬入量，含标记行）后才彻底清源端
  const metaCount = await db.prepare('SELECT COUNT(*) AS n FROM meta').first<{ n: number }>();
  const imgCount = await db.prepare('SELECT COUNT(*) AS n FROM images').first<{ n: number }>();
  if (Number(metaCount?.n ?? -1) < metaEntries.length + 1 || Number(imgCount?.n ?? -1) < records.length) {
    throw { status: 500, message: '搬家校验失败：D1 里的条数对不上，KV 原数据已保留' };
  }
  for (const name of names) await kv.delete(name);
  return { metaKeys: metaEntries.length, images: records.length };
}

async function moveToKv(kv: RawKv, db: D1Like): Promise<{ metaKeys: number; images: number }> {
  const metaRes = await db.prepare('SELECT key, value FROM meta').all<{ key: string; value: string }>();
  // 标记行不按原值（'d1'）拷贝：下面统一在 KV 里写 'kv'
  const metaRows = (metaRes.results ?? []).filter((r) => r.key !== DATASTORE_PREF_KEY);
  const imgRes = await db
    .prepare('SELECT channel_id, filename, size, lastmod, tg_file_id, tg_message_id, dir FROM images')
    .all<ImageRowFull>();
  const imgRows = imgRes.results ?? [];

  for (const row of metaRows) await kv.put(row.key, row.value);
  // 标记落进 KV（就是普通数据键之一）：当前存储 = KV
  await kv.put(DATASTORE_PREF_KEY, 'kv');
  const records: ImageRecord[] = imgRows.map((r) => {
    const rec: ImageRecord = {
      channelId: r.channel_id,
      filename: r.filename,
      size: Number(r.size) || 0,
      lastmod: r.lastmod || '',
    };
    if (r.tg_file_id) rec.tgFileId = r.tg_file_id;
    if (typeof r.tg_message_id === 'number') rec.tgMessageId = r.tg_message_id;
    if (r.dir) rec.dir = r.dir;
    return rec;
  });
  await kv.put(REGISTRY_KEY, JSON.stringify(records));

  // 校验 KV 已落盘后才清 D1
  const back = await kv.get(REGISTRY_KEY);
  let backCount = -1;
  try {
    const parsed = back ? JSON.parse(back) : null;
    if (Array.isArray(parsed)) backCount = parsed.length;
  } catch {
    backCount = -1;
  }
  if (backCount !== records.length) {
    throw { status: 500, message: '搬家校验失败：登记表回写 KV 的条数对不上，D1 数据已保留' };
  }
  await db.prepare('DELETE FROM meta').run();
  await db.prepare('DELETE FROM images').run();
  return { metaKeys: metaRows.length, images: records.length };
}
