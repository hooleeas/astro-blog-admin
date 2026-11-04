export const prerender = false;

import type { APIRoute } from 'astro';
import {
  getChannelsState,
  saveChannelsState,
  getActiveChannel,
  channelToPublic,
  readImghubLevel,
  saveImghubLevel,
  normalizePageTitle,
} from '../../lib/webdav-config';
import { getR2Binding } from '../../lib/image-store';
import { isEdgeOne, resolveDataStore, setDataStorePref } from '../../lib/platform';
import { migrateDataStore } from '../../lib/datastore';

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

/**
 * 图床设置读取：只负责「选用哪个存储渠道」与图床自身选项（webp、公开页标题）。
 * 各渠道的参数（地址、密钥、对外连接路径等）在「存储」管理页维护，这里不返回任何密钥。
 */
export const GET: APIRoute = async ({ locals }) => {
  try {
    const found = await getActiveChannel(locals);
    const level = await readImghubLevel(locals);
    // 数据存储（账本存 KV 还是 D1）：仅 Cloudflare 有这个选择，EdgeOne 固定 Blob 返回 null
    let dataStore: { active: string; pref: string; d1Bound: boolean } | null = null;
    if (!isEdgeOne(locals)) {
      const state = await resolveDataStore(locals);
      dataStore = { active: state.kind, pref: state.pref, d1Bound: state.d1Bound };
    }
    return json({
      ok: true,
      data: {
        channels: found ? found.state.channels.map(channelToPublic) : [],
        activeChannelId: found?.active.id ?? '',
        webp: level.webp,
        pageTitle: level.pageTitle,
        hasR2Binding: getR2Binding(locals) !== null,
        hasBlobBackend: isEdgeOne(locals),
        dataStore,
      },
    });
  } catch (e) {
    return err(e);
  }
};

/** 保存图床设置：切换当前渠道 / webp 开关 / 公开页标题。存储参数不在这里保存。 */
export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as {
      activeChannelId?: unknown;
      webp?: unknown;
      pageTitle?: unknown;
      dataStore?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return json({ ok: false, error: '请求体必须是 JSON' }, 400);
    }

    if (body.activeChannelId !== undefined) {
      const state = await getChannelsState(locals);
      if (!state || !state.channels.length) {
        return json({ ok: false, error: '尚未添加任何存储渠道，请先到「存储」页添加' }, 400);
      }
      const target = state.channels.find((ch) => ch.id === String(body.activeChannelId));
      if (!target) return json({ ok: false, error: '所选存储渠道不存在' }, 400);
      if (!target.enabled) return json({ ok: false, error: '所选存储渠道已停用，请先在「存储」页启用' }, 400);
      state.activeId = target.id;
      await saveChannelsState(locals, state);
    }

    const patch: { webp?: boolean; pageTitle?: string } = {};
    if (body.webp !== undefined) patch.webp = body.webp !== false;
    if (body.pageTitle !== undefined) {
      const normalized = normalizePageTitle(body.pageTitle);
      if (normalized === null) {
        return json({ ok: false, error: '公开页标题不合法：最多 60 个字符，不能包含换行' }, 400);
      }
      patch.pageTitle = normalized;
    }
    if (patch.webp !== undefined || patch.pageTitle !== undefined) {
      await saveImghubLevel(locals, patch);
    }

    // 数据存储切换（放最后：前面的校验都过了才搬家）：搬家成功后才写新偏好
    if (body.dataStore !== undefined) {
      if (body.dataStore !== 'kv' && body.dataStore !== 'd1') {
        return json({ ok: false, error: '数据存储取值不合法' }, 400);
      }
      if (isEdgeOne(locals)) {
        return json({ ok: false, error: 'EdgeOne 的数据固定存 Blob，没有此选择' }, 400);
      }
      const target = body.dataStore;
      const state = await resolveDataStore(locals);
      if (target === 'd1' && !state.d1Bound) {
        return json(
          { ok: false, error: '未检测到 D1 绑定（ADMIN_D1），请先在 Cloudflare Pages 里绑定 D1 数据库' },
          400,
        );
      }
      if (target !== state.kind) {
        await migrateDataStore(locals, target);
      }
      await setDataStorePref(locals, target);
    }
    return json({ ok: true });
  } catch (e) {
    return err(e);
  }
};
