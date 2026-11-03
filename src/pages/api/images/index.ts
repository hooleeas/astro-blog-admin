export const prerender = false;

import type { APIRoute } from 'astro';
import { getImageUrl, isImageFilename, isLocalImagePreview } from '../../../lib/image-assets';
import { getChannelsState, channelToConfig, readImghubLevel, imageDir } from '../../../lib/webdav-config';
import { storeListFiles } from '../../../lib/image-store';
import { registryListByChannel, registryUpsert, registryRemove } from '../../../lib/image-registry';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message :
    typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
}

/**
 * 图片管理列表：聚合所有启用渠道的图片（每张标注所属渠道与该渠道路径下的链接）。
 * 单个渠道读取失败不拖垮整个列表，失败信息随 channelErrors 返回。
 */
export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const state = await getChannelsState(locals);
    const level = await readImghubLevel(locals);
    const localPreview = isLocalImagePreview(locals, request);
    const images: Array<{
      filename: string; url: string; size: number; lastmod: string;
      channelId: string; channelName: string; channelKind: string;
    }> = [];
    const channelErrors: Array<{ channelId: string; name: string; error: string }> = [];
    const channelList: Array<{ id: string; name: string; kind: string; enabled: boolean }> = [];

    if (state) {
      for (const ch of state.channels) {
        channelList.push({ id: ch.id, name: ch.name, kind: ch.kind, enabled: ch.enabled });
        if (!ch.enabled) continue;
        const cfg = channelToConfig(ch, level);
        try {
          const files = await storeListFiles(locals, cfg);
          const foundNames = new Set<string>();
          // 渠道里文件的身份 = 目录 + 文件名（对象存储渠道全桶列出后，同一渠道可有多个目录）
          const foundKeys = new Set<string>();
          for (const file of files) {
            foundNames.add(file.filename);
            foundKeys.add(`${file.dir ?? imageDir(cfg)}/${file.filename}`);
          }
          for (const file of files) {
            if (!isImageFilename(file.filename)) continue;
            images.push({
              filename: file.filename,
              url: getImageUrl(locals, file.filename, localPreview, request.url, cfg.linkPrefix),
              size: file.size,
              lastmod: file.lastmod,
              channelId: ch.id,
              channelName: ch.name,
              channelKind: ch.kind,
            });
          }
          // 与登记表对账：渠道里有的补登记（带实际目录），登记里有但渠道已没有的销记（自愈，不让失败拖垮列表）
          try {
            for (const file of files) {
              if (!isImageFilename(file.filename)) continue;
              await registryUpsert(locals, {
                filename: file.filename,
                channelId: ch.id,
                size: file.size,
                lastmod: file.lastmod,
                dir: file.dir,
              });
            }
            const registered = await registryListByChannel(locals, ch.id);
            for (const rec of registered) {
              if (!foundKeys.has(`${rec.dir ?? imageDir(cfg)}/${rec.filename}`)) {
                await registryRemove(locals, ch.id, rec.filename);
              }
            }
          } catch {}
        } catch (error) {
          channelErrors.push({ channelId: ch.id, name: ch.name, error: errorMessage(error) });
        }
      }
    }
    // 渠道内按时间倒序；渠道之间保持渠道列表顺序（前端按渠道分组渲染）
    const order = new Map(channelList.map((ch, i) => [ch.id, i]));
    images.sort((a, b) =>
      (order.get(a.channelId) ?? 0) - (order.get(b.channelId) ?? 0) || b.lastmod.localeCompare(a.lastmod));
    return json({ ok: true, data: { images, channels: channelList, channelErrors } });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error &&
      typeof error.status === 'number' ? error.status : 500;
    return json({ ok: false, error: `读取图片列表失败：${errorMessage(error)}` }, status);
  }
};
