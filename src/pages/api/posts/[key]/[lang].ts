import type { APIContext } from 'astro';
import { validatePostFrontmatter, serializePost } from '../../../../lib/frontmatter.js';
import { ok, fail, type Gh } from '../../../../lib/content.js';
import { postRefsFromPaths, resolveGroup } from '../../../../lib/posts.js';
import * as ghMod from '../../../../lib/github.js';
import { getEnv } from '../../../../lib/env.js';

export const prerender = false;

type GhEx = Omit<Gh, 'putFile'> & {
  deleteFiles: (locals: unknown, paths: string[], message: string) => Promise<{ commit: string }>;
  putFile: (
    locals: unknown,
    path: string,
    content: string,
    message: string,
    sha?: string,
  ) => Promise<{ sha: string; path: string }>;
};
const gh = ghMod as unknown as GhEx;

function isLocalPreview(locals: APIContext['locals'], request: Request) {
  const hostname = new URL(request.url).hostname;
  return import.meta.env.DEV &&
    getEnv(locals).ADMIN_LOCAL_PREVIEW === 'true' &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
}

/**
 * 双段路由 /api/posts/:a/:b。
 *
 * 注意：任务定义的 PUT /api/posts/[lang]/[slug] 与 DELETE /api/posts/[key]/[lang]
 * 在 Astro 文件路由里是同一个模式（两个动态段），拆成两个文件会路由冲突，
 * 因此合并在此文件实现，URL 约定保持不变：
 *
 * - PUT    /api/posts/:lang/:slug — 保存单语言版本，body: { frontmatter, body, sha }
 *          （此时 params.key 实际是语言代码，params.lang 实际是 slug）
 * - DELETE /api/posts/:key/:lang  — 删除单个语言版本（慎用）
 *          （此时 params.key 是 translationKey，params.lang 是语言代码）
 */

/** PUT /api/posts/:lang/:slug — 校验 frontmatter，sha 乐观锁，保存 */
export async function PUT({ locals, params, request }: APIContext) {
  // URL 约定为 /api/posts/:lang/:slug
  const lang = String(params.key ?? '');
  const slug = String(params.lang ?? '');
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail('请求体不是合法 JSON');
  }
  const fmIn = body?.frontmatter;
  const text = String(body?.body ?? '');
  const sha = String(body?.sha ?? '');

  const v = validatePostFrontmatter(fmIn);
  if (!v.valid) return fail('frontmatter 校验失败：' + v.errors.join('；'));
  if (!sha) return fail('缺少 sha（请先重新加载再保存）');

  if (isLocalPreview(locals, request)) {
    try {
      const { hashLocalContent, listLocalRepoFiles, writeLocalPost } = await import('../../../../lib/local-data.js');
      const files = await listLocalRepoFiles('src/content/posts');
      const ref = postRefsFromPaths(files.map((file) => file.path))
        .find((item) => item.lang === lang && item.slug === slug);
      if (!ref) return fail('文件不存在', 404);
      const content = files.find((file) => file.path === ref.path)?.content;
      if (content === undefined) return fail('文件不存在', 404);
      if (hashLocalContent(content) !== sha) {
        return fail('文件已被他人修改（sha 不一致），请刷新后重试', 409);
      }

      const serialized = serializePost(fmIn as Record<string, any>, text);
      const nextSha = await writeLocalPost(ref.path, serialized, sha);
      return ok({ path: ref.path, sha: nextSha });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'CONFLICT') return fail('文件已被他人修改（sha 不一致），请刷新后重试', 409);
      if (code === 'ENOENT') return fail('文件不存在', 404);
      return fail('保存本地文章失败：' + (error as Error).message, 500);
    }
  }

  try {
    // 用已存在的真实路径（防路径穿越；同时兼容 .md/.mdx）
    const refs = postRefsFromPaths(await gh.listTree(locals));
    const ref = refs.find((r) => r.lang === lang && r.slug === slug);
    if (!ref) return fail('文件不存在', 404);

    const cur = await gh.getFile(locals, ref.path);
    if (cur.sha !== sha) return fail('文件已被他人修改（sha 不一致），请刷新后重试', 409);

    const content = serializePost(fmIn as Record<string, any>, text);
    const saved = await gh.putFile(locals, ref.path, content, `admin: 更新文章 ${ref.path}`, sha);
    return ok({ path: ref.path, sha: saved.sha });
  } catch (e) {
    return fail('保存失败：' + (e as Error)?.message, 500);
  }
}

/** DELETE /api/posts/:key/:lang — 删除单个语言版本（慎用），一次 commit */
export async function DELETE({ locals, params }: APIContext) {
  // URL 约定为 /api/posts/:key/:lang
  const key = String(params.key ?? '');
  const lang = String(params.lang ?? '');
  if (!key || !lang) return fail('缺少 key 或 lang');
  try {
    const items = await resolveGroup(locals, key, false);
    const it = items.find((i) => i.lang === lang);
    if (!it) return fail('该语言版本不存在', 404);
    const result = await gh.deleteFiles(locals, [it.path], `admin: 删除文章 ${key} 的 ${lang} 版本`);
    return ok({ key, lang, deleted: [it.path], commit: result.commit });
  } catch (e) {
    return fail('删除失败：' + (e as Error)?.message, 500);
  }
}
