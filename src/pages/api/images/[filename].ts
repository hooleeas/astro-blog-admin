export const prerender = false;

import type { APIRoute } from 'astro';
import { getImageUrl, isImageFilename, isLocalImagePreview } from '../../../lib/image-assets';
import { getWebdavConfig, getChannelConfigById, getChannelById } from '../../../lib/webdav-config';
import { storeDeleteFile, storeFileExists, storeGetFile, storePutFile } from '../../../lib/image-store';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message :
    typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
}

function extensionOf(filename: string): string {
  const at = filename.lastIndexOf('.');
  return at >= 0 ? filename.slice(at).toLowerCase() : '';
}

/** 删除图片：带 channelId 时删该渠道里的那张（管理页用）；不带时按当前渠道（旧行为）。 */
export const DELETE: APIRoute = async ({ locals, params, url }) => {
  const filename = params.filename ?? '';
  if (!isImageFilename(filename)) return json({ ok: false, error: '图片文件名无效' }, 400);

  try {
    const channelId = url.searchParams.get('channelId') ?? '';
    const config = channelId
      ? await getChannelConfigById(locals, channelId, { forManage: true })
      : await getWebdavConfig(locals);
    if (!config) return json({ ok: false, error: '存储渠道不存在' }, 404);
    if (!await storeFileExists(locals, config, filename)) {
      return json({ ok: false, error: '该渠道中不存在这张图片' }, 404);
    }
    await storeDeleteFile(locals, config, filename);
    return json({ ok: true, data: { filename } });
  } catch (error) {
    return json({ ok: false, error: `删除图片失败：${errorMessage(error)}` }, 502);
  }
};

/**
 * 编辑图片：改文件名和/或更换存储渠道（管理页「编辑」）。
 * body: { channelId（原渠道，必填）, newFilename?, targetChannelId? }
 * 顺序：先读原图 → 写入目标（渠道/文件名）→ 再删原图；写入失败则什么都不变。
 */
export const PATCH: APIRoute = async ({ locals, params, request }) => {
  const filename = params.filename ?? '';
  if (!isImageFilename(filename)) return json({ ok: false, error: '图片文件名无效' }, 400);

  try {
    const body = (await request.json().catch(() => null)) as {
      channelId?: unknown; newFilename?: unknown; targetChannelId?: unknown;
    } | null;
    if (!body || typeof body !== 'object') return json({ ok: false, error: '请求体必须是 JSON' }, 400);
    const sourceId = String(body.channelId ?? '');
    if (!sourceId) return json({ ok: false, error: '缺少原渠道' }, 400);
    const sourceCfg = await getChannelConfigById(locals, sourceId, { forManage: true });
    if (!sourceCfg) return json({ ok: false, error: '原存储渠道不存在' }, 404);

    const targetId = String(body.targetChannelId ?? '') || sourceId;
    const targetChannel = await getChannelById(locals, targetId);
    if (!targetChannel) return json({ ok: false, error: '目标存储渠道不存在' }, 404);
    if (targetId !== sourceId && !targetChannel.enabled) {
      return json({ ok: false, error: '目标存储渠道已停用，不能移入' }, 400);
    }
    const targetCfg = targetId === sourceId
      ? sourceCfg
      : await getChannelConfigById(locals, targetId, { forManage: true });
    if (!targetCfg) return json({ ok: false, error: '目标存储渠道不存在' }, 404);

    let newFilename = filename;
    if (body.newFilename !== undefined && String(body.newFilename ?? '').trim() !== '') {
      newFilename = String(body.newFilename).trim();
      if (!isImageFilename(newFilename)) return json({ ok: false, error: '新文件名无效' }, 400);
      if (extensionOf(newFilename) !== extensionOf(filename)) {
        return json({ ok: false, error: '不能修改图片扩展名' }, 400);
      }
    }
    const moving = targetId !== sourceId;
    const renaming = newFilename !== filename;
    if (!moving && !renaming) {
      return json({ ok: false, error: '文件名和存储渠道都没有变化' }, 400);
    }
    if (!await storeFileExists(locals, sourceCfg, filename)) {
      return json({ ok: false, error: '原渠道中不存在这张图片' }, 404);
    }
    if (await storeFileExists(locals, targetCfg, newFilename)) {
      return json({ ok: false, error: moving ? '目标渠道已有同名图片' : '已有同名图片' }, 409);
    }

    const data = await storeGetFile(locals, sourceCfg, filename);
    await storePutFile(locals, targetCfg, newFilename, data.buffer as ArrayBuffer);
    try {
      await storeDeleteFile(locals, sourceCfg, filename);
    } catch {
      return json({
        ok: false,
        error: `新图片已保存到「${targetChannel.name}」，但原图删除失败，请到原渠道手动删除`,
        data: { partial: true, filename: newFilename, channelId: targetId },
      }, 502);
    }
    const localPreview = isLocalImagePreview(locals, request);
    return json({
      ok: true,
      data: {
        filename: newFilename,
        channelId: targetId,
        channelName: targetChannel.name,
        channelKind: targetChannel.kind,
        url: getImageUrl(locals, newFilename, localPreview, request.url, targetCfg.linkPrefix),
      },
    });
  } catch (error) {
    return json({ ok: false, error: `编辑图片失败：${errorMessage(error)}` }, 502);
  }
};
