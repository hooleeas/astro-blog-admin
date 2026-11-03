export const prerender = false;

import type { APIRoute } from 'astro';
import {
  getChannelsState,
  saveChannelsState,
  channelToPublic,
  newChannelId,
  normalizeChannelName,
  normalizeLinkPrefix,
  normalizeS3Endpoint,
  normalizeS3Region,
  DEFAULT_S3_REGION,
  normalizeTgChatId,
  type StorageChannel,
  type ImageStorageKind,
} from '../../lib/webdav-config';
import { getR2Binding } from '../../lib/image-store';
import { isEdgeOne } from '../../lib/platform';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function err(e: unknown): Response {
  const ce = e as { status?: number; message?: string } | null;
  if (ce && typeof ce.status === 'number' && ce.message) {
    return json({ ok: false, error: ce.message }, ce.status);
  }
  return json({ ok: false, error: `操作失败：${(e as Error)?.message || String(e)}` }, 500);
}

/** 与后台页面路径冲突的保留路径（单级页面/接口前缀），不允许用作对外连接路径 */
const RESERVED_PATHS = ['api', 'posts', 'notes', 'pages', 'data', 'settings', 'login', 'admin'];

interface ChannelInput {
  name?: unknown;
  kind?: unknown;
  enabled?: unknown;
  path?: unknown;
  dir?: unknown;
  url?: unknown;
  username?: unknown;
  password?: unknown;
  r2Endpoint?: unknown;
  r2Bucket?: unknown;
  r2AccessKeyId?: unknown;
  r2SecretAccessKey?: unknown;
  s3Endpoint?: unknown;
  s3Bucket?: unknown;
  s3Region?: unknown;
  s3AccessKeyId?: unknown;
  s3SecretAccessKey?: unknown;
  tgBotToken?: unknown;
  tgChatId?: unknown;
}

/**
 * 把表单值组装成一条渠道并做完整校验；old 为编辑时的原渠道（密钥类字段留空保留旧值）。
 * 校验不过返回 { error } （400 文案），通过返回 { channel }。
 */
function buildChannel(
  locals: unknown,
  body: ChannelInput,
  old: StorageChannel | null,
): { channel: StorageChannel } | { error: string } {
  const kind: ImageStorageKind | null = body.kind === 'r2' || body.kind === 's3' || body.kind === 'tg' || body.kind === 'webdav'
    ? body.kind
    : old?.kind ?? null;
  if (!kind) return { error: '存储类型不合法' };
  if (old && kind !== old.kind) return { error: '已创建的渠道不能更换存储类型，如需更换请新建渠道' };

  const name = normalizeChannelName(body.name ?? old?.name ?? '');
  if (name === null) return { error: '渠道名称不合法：最长 30 个字符，不能包含控制字符' };
  if (!String(body.name ?? old?.name ?? '').trim()) return { error: '渠道名称必填' };

  const rawPath = String(body.path ?? old?.path ?? '').trim();
  if (!rawPath) return { error: '对外连接路径必填' };
  const path = normalizeLinkPrefix(rawPath);
  if (path === null) return { error: '对外连接路径不合法：只能是单级路径（不含 / 和空格），如 images' };
  if (RESERVED_PATHS.includes(path)) return { error: '该路径与后台路径冲突，请换一个' };

  const dir = String(body.dir ?? old?.dir ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (dir.includes('..')) return { error: '上传目录不能包含 ..' };

  const channel: StorageChannel = {
    id: old?.id ?? newChannelId(),
    name,
    kind,
    enabled: body.enabled === undefined ? (old?.enabled ?? true) : body.enabled !== false,
    path,
    dir,
    url: old?.url ?? '',
    username: old?.username ?? '',
    password: old?.password ?? '',
    r2Endpoint: old?.r2Endpoint ?? '',
    r2Bucket: old?.r2Bucket ?? '',
    r2AccessKeyId: old?.r2AccessKeyId ?? '',
    r2SecretAccessKey: old?.r2SecretAccessKey ?? '',
    s3Endpoint: old?.s3Endpoint ?? '',
    s3Bucket: old?.s3Bucket ?? '',
    s3Region: old?.s3Region ?? DEFAULT_S3_REGION,
    s3AccessKeyId: old?.s3AccessKeyId ?? '',
    s3SecretAccessKey: old?.s3SecretAccessKey ?? '',
    tgBotToken: old?.tgBotToken ?? '',
    tgChatId: old?.tgChatId ?? '',
  };

  if (kind === 'webdav') {
    channel.url = String(body.url ?? old?.url ?? '').trim().replace(/\/+$/, '');
    if (!channel.url) return { error: 'WebDAV 地址必填' };
    if (!/^https?:\/\//i.test(channel.url)) return { error: 'WebDAV 地址必须以 http:// 或 https:// 开头' };
    channel.username = String(body.username ?? old?.username ?? '').trim();
    const password = String(body.password ?? '');
    if (password) channel.password = password;
  } else if (kind === 'r2') {
    // R2 渠道只走平台绑定（CF 的 IMGS_R2 / EO 的 Blob），没有后端时根本不可用；
    // 用端点+密钥连 S3 存储是「S3 渠道」的活，两者不再混用一套参数
    if (getR2Binding(locals) === null && !isEdgeOne(locals)) {
      return { error: '当前部署未绑定 R2 存储桶（变量名 IMGS_R2），R2 渠道不可用；如需用端点+密钥连接，请改建 S3 渠道' };
    }
    channel.r2Endpoint = '';
    channel.r2Bucket = '';
    channel.r2AccessKeyId = '';
    channel.r2SecretAccessKey = '';
  } else if (kind === 's3') {
    if (body.s3Endpoint !== undefined) {
      const normalized = normalizeS3Endpoint(body.s3Endpoint);
      if (normalized === null) return { error: 'S3 端点不合法：必须以 http:// 或 https:// 开头，如 https://<账号ID>.r2.cloudflarestorage.com' };
      channel.s3Endpoint = normalized;
    }
    if (body.s3Bucket !== undefined) channel.s3Bucket = String(body.s3Bucket || '').trim();
    if (body.s3Region !== undefined) {
      const normalized = normalizeS3Region(body.s3Region);
      if (normalized === null) return { error: 'S3 区域不合法：只能是字母、数字与连字符，如 auto、us-east-1' };
      channel.s3Region = normalized;
    }
    if (body.s3AccessKeyId !== undefined) channel.s3AccessKeyId = String(body.s3AccessKeyId || '').trim();
    const secret = String(body.s3SecretAccessKey ?? '');
    if (secret) channel.s3SecretAccessKey = secret;
    if (!channel.s3Endpoint) return { error: 'S3 端点必填' };
    if (!channel.s3Bucket) return { error: 'S3 存储桶名必填' };
    if (!channel.s3AccessKeyId) return { error: 'S3 访问密钥 ID 必填' };
    if (!channel.s3SecretAccessKey) return { error: 'S3 密钥必填' };
  } else if (kind === 'tg') {
    const token = String(body.tgBotToken ?? '').trim();
    if (token) channel.tgBotToken = token;
    if (body.tgChatId !== undefined && String(body.tgChatId ?? '').trim() !== '') {
      const normalized = normalizeTgChatId(body.tgChatId);
      if (normalized === null) return { error: 'Chat ID 不合法：应为数字 ID（频道通常是 -100 开头）或 @频道用户名' };
      channel.tgChatId = normalized;
    }
    if (!channel.tgBotToken) return { error: 'Bot Token 必填' };
    if (!channel.tgChatId) return { error: 'Chat ID 必填' };
  }
  return { channel };
}

async function loadState(locals: unknown) {
  const state = await getChannelsState(locals);
  return state ?? { channels: [], activeId: '' };
}

/** 渠道列表（公开视图，密钥只给 has 布尔）+ 当前渠道 + 平台后端信息 */
export const GET: APIRoute = async ({ locals }) => {
  try {
    const state = await loadState(locals);
    const active = state.channels.find((ch) => ch.id === state.activeId && ch.enabled)
      ?? state.channels.find((ch) => ch.enabled)
      ?? state.channels[0]
      ?? null;
    return json({
      ok: true,
      data: {
        channels: state.channels.map(channelToPublic),
        activeId: active?.id ?? '',
        hasR2Binding: getR2Binding(locals) !== null,
        hasBlobBackend: isEdgeOne(locals),
      },
    });
  } catch (e) {
    return err(e);
  }
};

/** 新建渠道：第一条渠道自动成为当前存储 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as ChannelInput | null;
    if (!body || typeof body !== 'object') return json({ ok: false, error: '请求体必须是 JSON' }, 400);
    const built = buildChannel(locals, body, null);
    if ('error' in built) return json({ ok: false, error: built.error }, 400);
    const state = await loadState(locals);
    state.channels.push(built.channel);
    if (state.channels.length === 1) state.activeId = built.channel.id;
    await saveChannelsState(locals, state);
    return json({ ok: true, data: { channel: channelToPublic(built.channel), activeId: state.activeId } });
  } catch (e) {
    return err(e);
  }
};

/** 编辑渠道（body.id 指定）；正在使用的渠道不能停用 */
export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as (ChannelInput & { id?: unknown }) | null;
    if (!body || typeof body !== 'object') return json({ ok: false, error: '请求体必须是 JSON' }, 400);
    const id = String(body.id ?? '');
    const state = await loadState(locals);
    const at = state.channels.findIndex((ch) => ch.id === id);
    if (at < 0) return json({ ok: false, error: '渠道不存在' }, 404);
    const built = buildChannel(locals, body, state.channels[at]);
    if ('error' in built) return json({ ok: false, error: built.error }, 400);
    if (!built.channel.enabled && state.activeId === id) {
      return json({ ok: false, error: '该渠道正在使用中，请先在图床设置里切换到其他存储再停用' }, 400);
    }
    state.channels[at] = built.channel;
    await saveChannelsState(locals, state);
    return json({ ok: true, data: { channel: channelToPublic(built.channel), activeId: state.activeId } });
  } catch (e) {
    return err(e);
  }
};

/** 删除渠道（body.id 指定）；正在使用的渠道不能删除 */
export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    const id = String(body?.id ?? '');
    const state = await loadState(locals);
    const at = state.channels.findIndex((ch) => ch.id === id);
    if (at < 0) return json({ ok: false, error: '渠道不存在' }, 404);
    if (state.activeId === id) {
      return json({ ok: false, error: '不能删除正在使用的存储，请先在图床设置里切换到其他存储' }, 400);
    }
    state.channels.splice(at, 1);
    await saveChannelsState(locals, state);
    return json({ ok: true, data: { activeId: state.activeId } });
  } catch (e) {
    return err(e);
  }
};
