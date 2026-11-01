import type { APIContext } from 'astro';
import { getFile, putFile, deleteFile } from '../../../lib/github.js';
import { ok, fail, PAGE_SLUG_RE, PROTECTED_PAGES, type Gh } from '../../../lib/content.js';
import { getEnv } from '../../../lib/env.js';

export const prerender = false;

const PAGES_PREFIX = 'src/pages/';
const gh = { getFile, putFile, deleteFile } as unknown as Gh;

function validSlug(params: APIContext['params']): string | null {
  const slug = String(params.slug ?? '');
  return PAGE_SLUG_RE.test(slug) ? slug : null;
}

function isLocalPreview(locals: APIContext['locals'], request: Request) {
  const hostname = new URL(request.url).hostname;
  return import.meta.env.DEV &&
    getEnv(locals).ADMIN_LOCAL_PREVIEW === 'true' &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
}

/** GET /api/pages/[slug] — 读页面源码 */
export async function GET({ locals, params, request }: APIContext) {
  const slug = validSlug(params);
  if (!slug) return fail('slug 不合法（仅允许字母、数字、_-）');
  const file = `${slug}.astro`;
  if (isLocalPreview(locals, request)) {
    try {
      const { readLocalPage } = await import('../../../lib/local-data.js');
      const { sha, content } = await readLocalPage(slug);
      return ok({ slug, file, sha, content });
    } catch (error) {
      const status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
      return fail(status === 404 ? '页面不存在' : `读取本地页面失败：${(error as Error).message}`, status);
    }
  }
  try {
    const { sha, content } = await gh.getFile(locals, PAGES_PREFIX + file);
    return ok({ slug, file, sha, content });
  } catch {
    return fail('页面不存在', 404);
  }
}

/** PUT /api/pages/[slug] — 原样写回，body: { content, sha } */
export async function PUT({ locals, params, request }: APIContext) {
  const slug = validSlug(params);
  if (!slug) return fail('slug 不合法');
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail('请求体不是合法 JSON');
  }
  const content = String(body?.content ?? '');
  const sha = String(body?.sha ?? '');
  if (!sha) return fail('缺少 sha（请先重新加载再保存）');
  const file = `${slug}.astro`;
  if (isLocalPreview(locals, request)) {
    try {
      const { writeLocalPage } = await import('../../../lib/local-data.js');
      const nextSha = await writeLocalPage(slug, content, sha);
      return ok({ slug, file, sha: nextSha });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'CONFLICT') return fail('本地页面已被其他操作修改，请重新加载后再保存', 409);
      if (code === 'ENOENT') return fail('页面不存在', 404);
      return fail(`保存本地页面失败：${(error as Error).message}`, 500);
    }
  }
  try {
    await gh.putFile(locals, PAGES_PREFIX + file, content, `admin: 更新页面 ${file}`, sha);
  } catch (e) {
    return fail('保存失败：' + (e as Error)?.message, 500);
  }
  return ok({ slug, file });
}

/** DELETE /api/pages/[slug] — 删除，body: { sha }（或 ?sha=）；默认页面禁止删除 */
export async function DELETE({ locals, params, request }: APIContext) {
  const slug = validSlug(params);
  if (!slug) return fail('slug 不合法');
  if (PROTECTED_PAGES.has(slug)) return fail('默认页面不允许删除', 403);
  let sha = '';
  try {
    const b = await request.json();
    sha = String((b as Record<string, unknown>)?.sha ?? '');
  } catch {
    /* 无 body 时走 query */
  }
  if (!sha) sha = new URL(request.url).searchParams.get('sha') ?? '';
  if (!sha) return fail('缺少 sha');
  const file = `${slug}.astro`;
  if (isLocalPreview(locals, request)) {
    try {
      const { deleteLocalPage } = await import('../../../lib/local-data.js');
      await deleteLocalPage(slug, sha);
      return ok({
        slug,
        file,
        warning: `页面已删除，访问 /${slug} 会返回 404`,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'CONFLICT') return fail('本地页面已被其他操作修改，请重新加载后再删除', 409);
      if (code === 'ENOENT') return fail('页面不存在', 404);
      return fail(`删除本地页面失败：${(error as Error).message}`, 500);
    }
  }
  try {
    await gh.deleteFile(locals, PAGES_PREFIX + file, sha, `admin: 删除页面 ${file}`);
  } catch (e) {
    return fail('删除失败：' + (e as Error)?.message, 500);
  }
  return ok({
    slug,
    file,
    warning: `页面已删除，访问 /${slug} 会返回 404`,
  });
}
