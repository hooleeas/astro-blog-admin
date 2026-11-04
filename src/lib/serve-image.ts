import { isImageFilename } from './image-assets';
import { getChannelsState, channelToConfig, readImghubLevel, getWebdavConfig, type WebdavConfig } from './webdav-config';
import { imageContentType, storeFileExists, storeGetFile } from './image-store';
import { registryFindByFilename, registryUpsert } from './image-registry';

/** 按文件名从指定存储渠道回源读图并返回响应；不给配置时用当前渠道。文件名不合法或读取失败一律 404。 */
export async function serveImage(locals: unknown, filename: string, cfg?: WebdavConfig): Promise<Response> {
  if (!isImageFilename(filename)) {
    return new Response('Not found', { status: 404 });
  }
  try {
    const config = cfg ?? await getWebdavConfig(locals);
    const body = await storeGetFile(locals, config, filename);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': imageContentType(filename),
        'cache-control': 'public, max-age=3600',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function imageResponse(filename: string, body: Uint8Array): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': imageContentType(filename),
      'cache-control': 'public, max-age=3600',
    },
  });
}

/**
 * 按对外连接路径出图。路径可被多个渠道共用（切换当前存储不影响链接）：
 * 先查图片登记表——记录了这张图在哪个渠道就直接去那个渠道取；
 * 登记表没有时再依次问占用该路径的渠道（当前渠道优先），找到后回填登记表。
 * 没有任何渠道占用该路径时返回 null，调用方决定是否回退旧行为。
 */
export async function serveImageByPath(locals: unknown, path: string, filename: string): Promise<Response | null> {
  if (!isImageFilename(filename)) {
    return new Response('Not found', { status: 404 });
  }
  const state = await getChannelsState(locals).catch(() => null);
  if (!state || !state.channels.length) return null;
  const level = await readImghubLevel(locals);
  // 当前路径命中的渠道优先，其次是把该路径留作历史别名的渠道（改路径后旧链接不断，用户定）；组内当前渠道优先
  const candidates = state.channels
    .filter((ch) => ch.enabled && (ch.path === path || (ch.aliases ?? []).includes(path)))
    .sort((a, b) =>
      ((a.path === path ? 0 : 1) - (b.path === path ? 0 : 1))
      || ((a.id === state.activeId ? 0 : 1) - (b.id === state.activeId ? 0 : 1)));
  if (!candidates.length) return null;

  // 1) 登记表定位
  const records = await registryFindByFilename(locals, filename).catch(() => []);
  const registeredIds = new Set(records.map((rec) => rec.channelId));
  for (const ch of candidates) {
    if (!registeredIds.has(ch.id)) continue;
    const body = await storeGetFile(locals, channelToConfig(ch, level), filename).catch(() => null);
    if (body) return imageResponse(filename, body);
  }
  // 2) 逐渠道探（登记表还没记到的旧图），命中后回填登记表
  for (const ch of candidates) {
    const cfg = channelToConfig(ch, level);
    const exists = await storeFileExists(locals, cfg, filename).catch(() => false);
    if (!exists) continue;
    const body = await storeGetFile(locals, cfg, filename).catch(() => null);
    if (!body) continue;
    void registryUpsert(locals, {
      filename,
      channelId: ch.id,
      size: body.byteLength,
      lastmod: new Date().toISOString(),
    }).catch(() => {});
    return imageResponse(filename, body);
  }
  return new Response('Not found', { status: 404 });
}
