export const prerender = false;

import type { APIRoute } from 'astro';
import { serveImage, serveImageByPath } from '../../lib/serve-image';

/**
 * 默认路径 /images/<文件名> 回源：有渠道占用 images 路径时按路径规则出图
 * （先查登记表定位渠道，没有再逐个渠道找）；没有任何渠道占用时回退当前渠道出图，
 * 兼容多渠道改造之前上传的旧 /images/ 链接。
 * 中间件对图片文件路径放行（公开可读），复制到文章里的链接可直接打开。
 */
export const GET: APIRoute = async ({ locals, params }) => {
  const filename = params.filename ?? '';
  const res = await serveImageByPath(locals, 'images', filename);
  return res ?? serveImage(locals, filename);
};
