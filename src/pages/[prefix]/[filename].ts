export const prerender = false;

import type { APIRoute } from 'astro';
import { serveImageByPath } from '../../lib/serve-image';

/**
 * 按对外连接路径回源：/<路径>/<文件名>。
 * 路径可被多个存储渠道共用（见「存储」管理页）：依次在占用该路径的启用渠道里
 * 找持有文件的渠道出图，切换当前存储不影响链接；没有渠道占用该路径一律 404
 * （默认路径 images 由 /images/[filename] 处理，含旧链接兼容）。
 */
export const GET: APIRoute = async ({ locals, params }) => {
  const res = await serveImageByPath(locals, params.prefix ?? '', params.filename ?? '');
  return res ?? new Response('Not found', { status: 404 });
};
