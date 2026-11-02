export const prerender = false;

import type { APIRoute } from 'astro';
// 同 upload.ts：用 'webdav/web' 自包含构建，Workers 兼容
import { createClient } from 'webdav/web';
import { AwsClient } from 'aws4fetch';
import { getWebdavConfig, normalizeR2Endpoint, normalizeR2Bucket } from '../../../lib/webdav-config';
import { getR2Binding, R2_BINDING_NAME } from '../../../lib/image-store';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 用表单中的地址和账号测试 WebDAV；密码留空时沿用已保存密码。 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const saved = await getWebdavConfig(locals);
    const body = await request.json().catch(() => null) as {
      url?: unknown;
      username?: unknown;
      password?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return json({ ok: false, error: '请求体必须是 JSON' }, 400);
    }

    // 存储方式为 Cloudflare R2 时测 R2：表单值优先，密钥留空沿用已保存的
    if ((body as any).storage === 'r2') {
      // 已绑 Pages 变量时直接测绑定连通性，不需要任何密钥字段
      const bound = getR2Binding(locals);
      if (bound) {
        await bound.list({ limit: 1 });
        return json({ ok: true, data: { message: `连接成功，Cloudflare R2 已通过 Pages 绑定（${R2_BINDING_NAME}）接入` } });
      }
      const b = body as any;
      const endpoint = normalizeR2Endpoint(typeof b.r2Endpoint === 'string' && b.r2Endpoint.trim() ? b.r2Endpoint : saved.r2Endpoint) || '';
      const bucket = normalizeR2Bucket(typeof b.r2Bucket === 'string' && b.r2Bucket.trim() ? b.r2Bucket : saved.r2Bucket) || '';
      const accessKeyId = typeof b.r2AccessKeyId === 'string' && b.r2AccessKeyId.trim() ? b.r2AccessKeyId.trim() : saved.r2AccessKeyId;
      const secretAccessKey = typeof b.r2SecretAccessKey === 'string' && b.r2SecretAccessKey ? b.r2SecretAccessKey : saved.r2SecretAccessKey;
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        return json({ ok: false, error: 'R2 配置不完整：端点、存储桶、访问密钥 ID、密钥都要填' }, 400);
      }
      const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
      const res = await aws.fetch(`${endpoint}/${bucket}`, { method: 'HEAD' });
      if (res.ok) {
        return json({ ok: true, data: { message: '连接成功，Cloudflare R2 存储桶可用' } });
      }
      if (res.status === 404) {
        return json({ ok: false, error: '连接失败：存储桶不存在（404），请核对桶名与端点' }, 404);
      }
      if (res.status === 403 || res.status === 401) {
        return json({ ok: false, error: '连接失败：R2 拒绝访问，请核对访问密钥与权限（需要读写权限）' }, 403);
      }
      return json({ ok: false, error: `连接失败：R2 返回 ${res.status}` }, 502);
    }

    const url = typeof body.url === 'string' ? body.url.trim() : saved.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      return json({ ok: false, error: 'WebDAV 地址必须以 http:// 或 https:// 开头' }, 400);
    }
    const cfg = {
      url: url.replace(/\/+$/, ''),
      username: typeof body.username === 'string' ? body.username.trim() : saved.username,
      password: typeof body.password === 'string' && body.password.length > 0
        ? body.password
        : saved.password,
    };
    const client = createClient(cfg.url, { username: cfg.username, password: cfg.password });
    await client.stat('/');
    return json({ ok: true, data: { message: '连接成功，WebDAV 服务可用' } });
  } catch (e: any) {
    if (e && typeof e.status === 'number' && e.message) {
      return json({ ok: false, error: e.message }, e.status);
    }
    return json({ ok: false, error: `连接失败：${e?.message || String(e)}` });
  }
};
