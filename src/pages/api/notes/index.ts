import type { APIContext } from 'astro';
import { getFile, putFile, listTree } from '../../../lib/github.js';
import {
  ok,
  fail,
  slugify,
  shanghaiToday,
  parseFrontmatter,
  NOTE_FILE_RE,
  readRepoTemplate,
  type Gh,
} from '../../../lib/content.js';
import { getEnv } from '../../../lib/env.js';

export const prerender = false;

const NOTES_PREFIX = 'src/content/notes/';
const TEMPLATE_PATH = 'templates/notes/note.md';
const BUILTIN_TPL = (date: string) => `---\ndate: ${date}\ndraft: false\n---\n\n`;

const gh = { getFile, putFile, listTree } as unknown as Gh;

function isLocalPreview(locals: APIContext['locals'], request: Request) {
  const hostname = new URL(request.url).hostname;
  return import.meta.env.DEV &&
    getEnv(locals).ADMIN_LOCAL_PREVIEW === 'true' &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
}

/** GET /api/notes — 随记列表（按 date 倒序） */
export async function GET({ locals, request }: APIContext) {
  if (isLocalPreview(locals, request)) {
    try {
      const { listLocalRepoFiles } = await import('../../../lib/local-data.js');
      const files = await listLocalRepoFiles('src/content/notes');
      const items = files
        .filter((entry) => entry.path.startsWith(NOTES_PREFIX) && NOTE_FILE_RE.test(entry.path.slice(NOTES_PREFIX.length)))
        .map((entry) => {
          const file = entry.path.slice(NOTES_PREFIX.length);
          const { fm } = parseFrontmatter(entry.content);
          return { file, path: entry.path, date: fm.date ?? '', draft: fm.draft === 'true' };
        })
        .sort((a, b) => b.date.localeCompare(a.date));
      return ok({ notes: items });
    } catch (e) {
      return fail('读取本地随记列表失败：' + (e as Error)?.message, 500);
    }
  }

  try {
    const paths = await gh.listTree(locals);
    const files = paths.filter(
      (p) => p.startsWith(NOTES_PREFIX) && NOTE_FILE_RE.test(p.slice(NOTES_PREFIX.length)),
    );
    const items: Array<{ file: string; path: string; date: string; draft: boolean }> = [];
    for (const p of files) {
      const file = p.slice(NOTES_PREFIX.length);
      try {
        const { content } = await gh.getFile(locals, p);
        const { fm } = parseFrontmatter(content);
        items.push({ file, path: p, date: fm.date ?? '', draft: fm.draft === 'true' });
      } catch {
        items.push({ file, path: p, date: '', draft: false });
      }
    }
    items.sort((a, b) => b.date.localeCompare(a.date));
    return ok({ notes: items });
  } catch (e) {
    return fail('读取随记列表失败：' + (e as Error)?.message, 500);
  }
}

/** POST /api/notes — 新建随记，body: { slug } */
export async function POST({ locals, request }: APIContext) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail('请求体不是合法 JSON');
  }
  const slug = slugify(String(body?.slug ?? '').trim());
  if (!slug) return fail('slug 不能为空（需包含字母或数字）');

  const date = shanghaiToday();
  const file = `${date}-${slug}.md`;
  const path = NOTES_PREFIX + file;

  if (isLocalPreview(locals, request)) {
    try {
      const { createLocalNote, listLocalRepoFiles, readLocalNoteTemplate } = await import('../../../lib/local-data.js');
      const files = await listLocalRepoFiles('src/content/notes');
      if (files.some((entry) => entry.path === path)) return fail(`随记已存在：${file}`, 409);

      let tpl = await readLocalNoteTemplate();
      if (!tpl) tpl = BUILTIN_TPL(date);
      tpl = tpl.replace(/^date:.*$/m, `date: ${date}`);
      await createLocalNote(file, tpl);
      return ok({ file, path, date }, 201);
    } catch (e) {
      const error = e as NodeJS.ErrnoException;
      if (error.code === 'EEXIST') return fail(`随记已存在：${file}`, 409);
      return fail('本地创建随记失败：' + (error.message || String(e)), 500);
    }
  }

  try {
    await gh.getFile(locals, path);
    return fail(`随记已存在：${file}`, 409);
  } catch {
    /* 不存在，继续新建 */
  }

  let tpl = await readRepoTemplate(gh, locals, TEMPLATE_PATH);
  if (!tpl) tpl = BUILTIN_TPL(date);
  tpl = tpl.replace(/^date:.*$/m, `date: ${date}`);

  try {
    await gh.putFile(locals, path, tpl, `admin: 新建随记 ${file}`);
  } catch (e) {
    return fail((e as Error)?.message || String(e), 500);
  }
  return ok({ file, path, date }, 201);
}
