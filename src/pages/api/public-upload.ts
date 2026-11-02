export const prerender = false;

import type { APIRoute } from 'astro';
import { processImageUpload } from '../../lib/upload-image';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * 公开图床页的上传接口（中间件放行、无需登录）。
 * 与后台上传共用 processImageUpload：同样的格式/大小校验、同样的存放目录与链接规则；
 * 这里只能上传，列表、删除、设置一概不开放。
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return json({ ok: false, error: '未收到文件（表单字段名应为 file）' }, 400);
    }
    const data = await processImageUpload(locals, request.url, file);
    return json({ ok: true, data });
  } catch (e: any) {
    if (e && typeof e.status === 'number' && e.message) {
      return json({ ok: false, error: e.message }, e.status);
    }
    return json({ ok: false, error: `上传失败：${e?.message || String(e)}` }, 500);
  }
};
