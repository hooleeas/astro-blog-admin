import type { APIContext } from 'astro';
import { getFile, putFile, listTree } from '../../../lib/github.js';
import {
  ok,
  fail,
  escapeJsString,
  PAGE_SLUG_RE,
  PROTECTED_PAGES,
  readRepoTemplate,
  type Gh,
} from '../../../lib/content.js';

export const prerender = false;

const PAGES_PREFIX = 'src/pages/';
const TEMPLATE_PATH = 'templates/pages/page.astro.txt';
const BUILTIN_TPL = `---
const pageTitle = "...";
const pageSubtitle = "...";
---

<html lang="zh-Hans">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{pageTitle}</title>
  </head>
  <body>
    <main style="max-width: 720px; margin: 4rem auto; padding: 0 1rem; font-family: sans-serif;">
      <h1>{pageTitle}</h1>
      <p>{pageSubtitle}</p>
    </main>
  </body>
</html>
`;

const gh = { getFile, putFile, listTree } as unknown as Gh;

/** GET /api/pages — 页面 slug 列表 */
export async function GET({ locals }: APIContext) {
  try {
    const paths = await gh.listTree(locals);
    const slugs = paths
      .filter((p) => p.startsWith(PAGES_PREFIX) && p.endsWith('.astro') && !p.slice(PAGES_PREFIX.length).includes('/'))
      .map((p) => p.slice(PAGES_PREFIX.length, -'.astro'.length))
      .filter((s) => PAGE_SLUG_RE.test(s))
      .sort();
    return ok({ pages: slugs.map((slug) => ({ slug, path: `${PAGES_PREFIX}${slug}.astro`, protected: PROTECTED_PAGES.has(slug) })) });
  } catch (e) {
    return fail('读取页面列表失败：' + (e as Error)?.message, 500);
  }
}

/** POST /api/pages — 新建页面，body: { slug, title, subtitle } */
export async function POST({ locals, request }: APIContext) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail('请求体不是合法 JSON');
  }
  const slug = String(body?.slug ?? '').trim();
  if (!PAGE_SLUG_RE.test(slug)) return fail('slug 不合法（仅允许字母、数字、_-）');
  const title = String(body?.title ?? '').trim();
  const subtitle = String(body?.subtitle ?? '').trim();
  if (!title) return fail('标题不能为空');

  const file = `${slug}.astro`;
  const path = PAGES_PREFIX + file;

  try {
    await gh.getFile(locals, path);
    return fail(`页面已存在：${file}`);
  } catch {
    /* 不存在，继续新建 */
  }

  let tpl = await readRepoTemplate(gh, locals, TEMPLATE_PATH);
  if (!tpl) tpl = BUILTIN_TPL;
  tpl = tpl
    .replace(/^const pageTitle = .*;$/m, `const pageTitle = "${escapeJsString(title)}";`)
    .replace(/^const pageSubtitle = .*;$/m, `const pageSubtitle = "${escapeJsString(subtitle)}";`);

  try {
    await gh.putFile(locals, path, tpl, `admin: 新建页面 ${file}`);
  } catch (e) {
    return fail('创建失败：' + (e as Error)?.message, 500);
  }
  return ok({ slug, file, path }, 201);
}
