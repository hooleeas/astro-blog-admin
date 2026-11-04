// 注意：不要用默认入口 'webdav'（dist/node，依赖 node-fetch，在 Workers 上跑不起来）。
// 'webdav/web' 是官方自包含 web 构建（原生 fetch，显式支持 WorkerGlobalScope），
// 在 Cloudflare Pages Functions / workerd 里可直接运行。
import { getWebdavConfig, getChannelsState, channelToConfig, readImghubLevel, type WebdavConfig } from './webdav-config';
import { storeFileExists, storePutFile } from './image-store';
import { registryGet } from './image-registry';
import { getImageUrl, isImageFilename } from './image-assets';

const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'];
const TYPE_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

export interface UploadedImage {
  url: string;
  filename: string;
}

function fail(status: number, message: string): never {
  throw { status, message };
}

/**
 * 校验并把一张图片存入 WebDAV 图床目录，返回公开链接。
 * 后台上传与公开图床页共用这一套逻辑；失败抛 {status, message}，由调用方转成 {ok:false,error}。
 */
export async function processImageUpload(locals: unknown, requestUrl: string, file: File): Promise<UploadedImage> {
  if (file.size === 0) fail(400, '文件为空');
  if (file.size > MAX_SIZE) fail(400, '文件超过 10MB 限制');

  // 扩展名白名单；保留原始文件名（转换后的 WebP 已由浏览器换好扩展名）。
  let filename = file.name;
  if (/[\\/\u0000-\u001f\u007f]/.test(filename) || new TextEncoder().encode(filename).length > 240) {
    fail(400, '文件名无效或过长');
  }
  let ext = (filename.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ALLOWED_EXT.includes(ext)) {
    ext = TYPE_TO_EXT[file.type] || '';
    if (ext) {
      const extensionStart = filename.lastIndexOf('.');
      filename = `${extensionStart > 0 ? filename.slice(0, extensionStart) : filename}.${ext}`;
    }
  }
  const isImage = file.type.startsWith('image/') || ALLOWED_EXT.includes(ext);
  if (!isImage) fail(400, '只允许上传图片文件');
  if (!ALLOWED_EXT.includes(ext)) {
    fail(400, `不支持的图片格式（仅支持 ${ALLOWED_EXT.join(' / ')}）`);
  }
  if (!isImageFilename(filename)) {
    fail(400, '文件名无效或过长');
  }

  const cfg = await getWebdavConfig(locals);
  const data = await file.arrayBuffer();
  // 存放位置取渠道的 dir（留空为根目录）；存储方式（WebDAV / R2 / S3 / Telegram）由存储层按渠道分发
  // 重名查重范围（用户定）：与当前渠道共用同一对外路径的全部启用渠道——同一链接路径下
  // 文件名必须唯一（登记表记着的、存储里实际有的都算占用）；重名了在扩展名前加 _1、_2…
  // 纯数字递增找空位，原文件不覆盖、不动
  const groupCfgs: WebdavConfig[] = [cfg];
  try {
    const state = await getChannelsState(locals);
    const level = await readImghubLevel(locals);
    const active = state?.channels.find((ch) => ch.id === cfg.channelId);
    const sharedPath = active?.path ?? cfg.linkPrefix;
    for (const ch of state?.channels ?? []) {
      if (!ch.enabled || ch.path !== sharedPath || ch.id === active?.id) continue;
      groupCfgs.push(channelToConfig(ch, level));
    }
  } catch {}
  const taken = async (name: string) => {
    for (const c of groupCfgs) {
      if (c.channelId) {
        const rec = await registryGet(locals, c.channelId, name).catch(() => null);
        if (rec) return true;
      }
      try { if (await storeFileExists(locals, c, name)) return true; } catch {}
    }
    return false;
  };
  if (await taken(filename)) {
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const suffix = dot > 0 ? filename.slice(dot) : '';
    let n = 1;
    let candidate = `${stem}_${n}${suffix}`;
    while (n < 999 && (await taken(candidate))) {
      n += 1;
      candidate = `${stem}_${n}${suffix}`;
    }
    filename = candidate;
  }
  await storePutFile(locals, cfg, filename, data);

  // 只存 WebDAV 这一份，不再往任何 GitHub 仓库发布副本
  return { url: getImageUrl(locals, filename, false, requestUrl, cfg.linkPrefix), filename };
}
