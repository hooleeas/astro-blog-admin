import type { APIContext } from 'astro';
import { parsePost } from '../../../lib/frontmatter.js';
import { ok, fail, slugify, shanghaiToday, type Gh } from '../../../lib/content.js';
import {
  postRefsFromPaths,
  groupPosts,
  getEnabledLanguages,
  getPostTemplate,
  renderPostTemplate,
  mapPool,
  type PostMeta,
} from '../../../lib/posts.js';
import * as ghMod from '../../../lib/github.js';
import { getEnv } from '../../../lib/env.js';

export const prerender = false;

const gh = ghMod as unknown as Gh;

function isLocalPreview(locals: APIContext['locals'], request: Request) {
  const hostname = new URL(request.url).hostname;
  return import.meta.env.DEV &&
    getEnv(locals).ADMIN_LOCAL_PREVIEW === 'true' &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
}

/** GET /api/posts — 文章列表，按 translationKey 分组，pubDate 倒序 */
export async function GET({ locals, request }: APIContext) {
  if (isLocalPreview(locals, request)) {
    try {
      const { listLocalRepoFiles } = await import('../../../lib/local-data.js');
      const files = await listLocalRepoFiles('src/content/posts');
      const contentByPath = new Map(files.map((file) => [file.path, file.content]));
      const metas: PostMeta[] = postRefsFromPaths(files.map((file) => file.path)).map((ref) => ({
        ...ref,
        sha: '',
        frontmatter: parsePost(contentByPath.get(ref.path) ?? '').frontmatter,
      }));
      return ok({ groups: groupPosts(metas) });
    } catch (e) {
      return fail('读取本地文章列表失败：' + (e as Error)?.message, 500);
    }
  }

  try {
    const refs = postRefsFromPaths(await gh.listTree(locals));
    const metas: PostMeta[] = await mapPool(refs, 8, async (r) => {
      try {
        const { sha, content } = await gh.getFile(locals, r.path);
        return { ...r, sha, frontmatter: parsePost(content).frontmatter };
      } catch {
        return { ...r, sha: '', frontmatter: {} as Record<string, any> };
      }
    });
    return ok({ groups: groupPosts(metas) });
  } catch (e) {
    return fail('读取文章列表失败：' + (e as Error)?.message, 500);
  }
}

/**
 * POST /api/posts — 新建文章，body: { title }
 * 复刻 scripts/new.js：slugify → Asia/Shanghai 今日日期 → translationKey=`${date}-${slug}` →
 * translationKey 全库去重 → 任一目标文件已存在则全部不建 → 5 语言 draft 文件一次 commit。
 */
export async function POST({ locals, request }: APIContext) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail('请求体不是合法 JSON');
  }
  const title = String(body?.title ?? '').trim();
  if (!title) return fail('标题不能为空');
  const slug = slugify(title);
  if (!slug) return fail('标题至少需要包含一个字母或数字');
  const date = shanghaiToday();
  const translationKey = `${date}-${slug}`;

  try {
    const langs = await getEnabledLanguages(locals);
    if (!langs.length) return fail('没有启用的语言', 500);

    // translationKey 全库去重：扫全部文章 frontmatter
    const paths = await gh.listTree(locals);
    const refs = postRefsFromPaths(paths);
    const metas = await mapPool(refs, 8, async (r) => {
      try {
        const { content } = await gh.getFile(locals, r.path);
        const tk = parsePost(content).frontmatter.translationKey;
        return { ...r, tk: typeof tk === 'string' ? tk : '' };
      } catch {
        return { ...r, tk: '' };
      }
    });
    const dup = metas.filter((m) => m.tk === translationKey);
    if (dup.length) {
      return fail(`translationKey 已被使用：${translationKey}（${dup.map((d) => d.path).join('、')}）`);
    }

    // 任一目标文件已存在则全部不建
    const existing = new Set(paths);
    const targets = langs.map((code) => `src/content/posts/${code}/${slug}.md`);
    const clash = targets.filter((p) => existing.has(p));
    if (clash.length) {
      return fail(`以下文章文件已存在，未创建任何文件：${clash.join('、')}`);
    }

    // 模板实时取仓库，404 用内置最小模板兜底；字段替换复刻 new.js
    const files: Array<{ path: string; content: string }> = [];
    for (const code of langs) {
      const tpl = await getPostTemplate(locals, code);
      files.push({
        path: `src/content/posts/${code}/${slug}.md`,
        content: renderPostTemplate(tpl, { title, date, translationKey }),
      });
    }
    const result = (await gh.commitFiles(locals, files, `admin: 新建文章 ${title}（${translationKey}）`)) as {
      commit: string;
    };
    return ok(
      { translationKey, slug, langs, files: files.map((f) => f.path), commit: result.commit },
      201,
    );
  } catch (e) {
    return fail('新建失败：' + (e as Error)?.message, 500);
  }
}
