export const prerender = false;

import type { APIRoute } from 'astro';
// 同 upload.ts：用 'webdav/web' 自包含构建，Workers 兼容
import { createClient } from 'webdav/web';
import { getWebdavConfig, getChannelById, channelToConfig, readImghubLevel, normalizeS3Endpoint, normalizeS3Region, normalizeTgChatId, type WebdavConfig } from '../../../lib/webdav-config';
import { getR2Binding, R2_BINDING_NAME, testTelegramConnection, testS3Connection } from '../../../lib/image-store';
import { getImageBlobStore } from '../../../lib/platform';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 用表单中的地址和账号测试 WebDAV；密码留空时沿用已保存密码。 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json().catch(() => null) as {
      url?: unknown;
      username?: unknown;
      password?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return json({ ok: false, error: '请求体必须是 JSON' }, 400);
    }

    // 留空字段的沿用来源：带 channelId 时取该渠道已保存的参数（存储管理页编辑测试）；
    // 否则取当前有效配置；完全未配置时用空值兜底（新建第一个渠道时表单值即全部）
    const emptySaved = {
      url: '', username: '', password: '',
      r2Endpoint: '', r2Bucket: '', r2AccessKeyId: '', r2SecretAccessKey: '',
      s3Endpoint: '', s3Bucket: '', s3Region: 'auto', s3AccessKeyId: '', s3SecretAccessKey: '',
      tgBotToken: '', tgChatId: '',
    } as WebdavConfig;
    let saved: WebdavConfig = emptySaved;
    const channelId = String((body as any).channelId ?? '');
    const channel = channelId ? await getChannelById(locals, channelId).catch(() => null) : null;
    if (channel) {
      saved = channelToConfig(channel, await readImghubLevel(locals));
    } else {
      saved = await getWebdavConfig(locals).catch(() => emptySaved);
    }
    const testKind = (body as any).storage ?? channel?.kind;

    // R2 渠道只走平台绑定：测绑定/Blob 连通性，不涉及任何密钥字段
    if (testKind === 'r2') {
      const bound = getR2Binding(locals);
      if (bound) {
        await bound.list({ limit: 1 });
        return json({ ok: true, data: { message: `连接成功，Cloudflare R2 已通过 Pages 绑定（${R2_BINDING_NAME}）接入` } });
      }
      const blob = await getImageBlobStore(locals);
      if (blob) {
        await blob.list('');
        return json({ ok: true, data: { message: '连接成功，EdgeOne Blob 可用' } });
      }
      return json({ ok: false, error: `连接失败：未检测到 Pages 绑定（${R2_BINDING_NAME}），R2 渠道不可用；如需用端点+密钥连接，请使用 S3 渠道` }, 400);
    }

    // S3 渠道：表单值优先，密钥留空沿用已保存的；签一个列桶请求验参数
    if (testKind === 's3') {
      const b = body as any;
      const endpoint = normalizeS3Endpoint(typeof b.s3Endpoint === 'string' && b.s3Endpoint.trim() ? b.s3Endpoint : saved.s3Endpoint) || '';
      const bucket = typeof b.s3Bucket === 'string' && b.s3Bucket.trim() ? b.s3Bucket.trim() : saved.s3Bucket;
      const region = normalizeS3Region(typeof b.s3Region === 'string' && b.s3Region.trim() ? b.s3Region : saved.s3Region) || 'auto';
      const accessKeyId = typeof b.s3AccessKeyId === 'string' && b.s3AccessKeyId.trim() ? b.s3AccessKeyId.trim() : saved.s3AccessKeyId;
      const secretAccessKey = typeof b.s3SecretAccessKey === 'string' && b.s3SecretAccessKey ? b.s3SecretAccessKey : saved.s3SecretAccessKey;
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        return json({ ok: false, error: 'S3 配置不完整：端点、存储桶、访问密钥 ID、密钥都要填' }, 400);
      }
      await testS3Connection({ endpoint, bucket, region, accessKeyId, secretAccessKey });
      return json({ ok: true, data: { message: '连接成功，S3 存储桶可用' } });
    }

    // 存储方式为 Telegram 时测 TG 渠道：表单值优先，令牌与 Chat ID 留空沿用已保存的
    if (testKind === 'tg') {
      const b = body as any;
      const botToken = typeof b.tgBotToken === 'string' && b.tgBotToken.trim() ? b.tgBotToken.trim() : saved.tgBotToken;
      const rawChatId = typeof b.tgChatId === 'string' && b.tgChatId.trim() ? b.tgChatId : saved.tgChatId;
      const chatId = normalizeTgChatId(rawChatId);
      if (!botToken || !chatId) {
        return json({ ok: false, error: 'Telegram 配置不完整：Bot Token 与 Chat ID 都要填（Chat ID 应为数字 ID 或 @频道用户名）' }, 400);
      }
      const { botUsername, chatLabel } = await testTelegramConnection(botToken, chatId);
      return json({ ok: true, data: { message: `连接成功，Telegram 渠道可用（机器人 ${botUsername}，${chatLabel}）` } });
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
