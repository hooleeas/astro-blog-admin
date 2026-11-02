export const prerender = false;

import type { APIRoute } from 'astro';
import { serveImage } from '../../lib/serve-image';

/**
 * 图床图片回源（默认前缀 /images/<文件名>）：图片只存 WebDAV 一份，本路由从 WebDAV 读出返回。
 * 中间件对图片文件路径放行（公开可读），复制到文章里的链接可直接打开。
 * 前缀在图床设置里改成自定义值后，本路由保留，旧的 /images/ 链接仍可打开。
 */
export const GET: APIRoute = async ({ locals, params }) => serveImage(locals, params.filename ?? '');
