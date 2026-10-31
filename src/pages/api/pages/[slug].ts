import type { APIContext } from 'astro';
import { getFile, putFile, deleteFile } from '../../../lib/github.js';
import { ok, fail, PAGE_SLUG_RE, PROTECTED_PAGES, type Gh } from '../../../lib/content.js';

export const prerender = false;

const PAGES_PREFIX = 'src/pages/';
const gh = { getFile, putFile, deleteFile } as unknown as Gh;

function validSlug(params: APIContext['params']): string | null {
  const slug = String(params.slug ?? '');
  return PAGE_SLUG_RE.test(slug) ? slug : null;
}

/** GET /api/pages/[slug] — 读页面源码 */
export async function GET({ locals, params }: APIContext) {
  const slug = validSlug(params);
  if (!slug) return fail('slug 不合法（仅允许字母、数字、_-）');
  const file = `${slug}.astro`;
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
