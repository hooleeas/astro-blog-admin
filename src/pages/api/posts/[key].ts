import type { APIContext } from 'astro';
import { ok, fail, type Gh } from '../../../lib/content.js';
import { resolveGroup, normalizeFrontmatter } from '../../../lib/posts.js';
import * as ghMod from '../../../lib/github.js';

export const prerender = false;

const gh = ghMod as unknown as Gh & {
  deleteFiles: (locals: unknown, paths: string[], message: string) => Promise<{ commit: string }>;
};

/** GET /api/posts/[key] — 取某 translationKey 下各语言版本 [{lang, slug, sha, frontmatter, body}] */
export async function GET({ locals, params }: APIContext) {
  const key = String(params.key ?? '');
  if (!key) return fail('缺少 key');
  try {
    const items = await resolveGroup(locals, key, true);
    if (!items.length) return fail('文章不存在', 404);
    return ok({
      key,
      items: items.map((it) => ({
        lang: it.lang,
        slug: it.slug,
        sha: it.sha,
        frontmatter: normalizeFrontmatter(it.frontmatter),
        body: it.body ?? '',
      })),
    });
  } catch (e) {
    return fail('读取失败：' + (e as Error)?.message, 500);
  }
}

/** DELETE /api/posts/[key] — 删除该 translationKey 下全部语言文件（一次 commit） */
export async function DELETE({ locals, params }: APIContext) {
  const key = String(params.key ?? '');
  if (!key) return fail('缺少 key');
  try {
    const items = await resolveGroup(locals, key, false);
    if (!items.length) return fail('文章不存在', 404);
    const paths = items.map((i) => i.path);
    const result = (await gh.deleteFiles(locals, paths, `admin: 删除文章 ${key}（${paths.length} 个文件）`)) as {
      commit: string;
    };
    return ok({ key, deleted: paths, commit: result.commit });
  } catch (e) {
    return fail('删除失败：' + (e as Error)?.message, 500);
  }
}
