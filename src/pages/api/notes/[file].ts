import type { APIContext } from 'astro';
import { getFile, putFile, deleteFile } from '../../../lib/github.js';
import {
  ok,
  fail,
  parseFrontmatter,
  serializeFrontmatter,
  isValidDate,
  NOTE_FILE_RE,
  type Gh,
} from '../../../lib/content.js';

export const prerender = false;

const NOTES_PREFIX = 'src/content/notes/';
const gh = { getFile, putFile, deleteFile } as unknown as Gh;

function validFile(params: APIContext['params']): string | null {
  const file = String(params.file ?? '');
  return NOTE_FILE_RE.test(file) ? file : null;
}

/** GET /api/notes/[file] — 读单篇随记 */
export async function GET({ locals, params }: APIContext) {
  const file = validFile(params);
  if (!file) return fail('文件名不合法（仅允许字母、数字、._- 且以 .md 结尾）');
  try {
    const { sha, content } = await gh.getFile(locals, NOTES_PREFIX + file);
    const { fm, body } = parseFrontmatter(content);
    return ok({
      file,
      sha,
      frontmatter: { date: fm.date ?? '', draft: fm.draft === 'true' },
      body,
      raw: content,
    });
  } catch {
    return fail('随记不存在', 404);
  }
}

/** PUT /api/notes/[file] — 保存，body: { frontmatter: { date, draft }, body, sha } */
export async function PUT({ locals, params, request }: APIContext) {
  const file = validFile(params);
  if (!file) return fail('文件名不合法');
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail('请求体不是合法 JSON');
  }
  const fmIn = (body?.frontmatter ?? {}) as Record<string, unknown>;
  const date = String(fmIn.date ?? '');
  const draft = fmIn.draft === true;
  const text = String(body?.body ?? '');
  const sha = String(body?.sha ?? '');
  if (!isValidDate(date)) return fail('date 不合法，需为 YYYY-MM-DD 有效日期');
  if (!sha) return fail('缺少 sha（请先重新加载再保存）');

  // 保留原有其他 frontmatter 字段，只更新 date/draft
  let fm: Record<string, unknown> = {};
  try {
    const cur = await gh.getFile(locals, NOTES_PREFIX + file);
    fm = parseFrontmatter(cur.content).fm as Record<string, unknown>;
  } catch {
    return fail('随记不存在', 404);
  }
  fm.date = date;
  fm.draft = draft ? 'true' : 'false';

  try {
    await gh.putFile(locals, NOTES_PREFIX + file, serializeFrontmatter(fm, text), `admin: 更新随记 ${file}`, sha);
  } catch (e) {
    return fail('保存失败：' + (e as Error)?.message, 500);
  }
  return ok({ file });
}

/** DELETE /api/notes/[file] — 删除，body: { sha }（或 ?sha=） */
export async function DELETE({ locals, params, request }: APIContext) {
  const file = validFile(params);
  if (!file) return fail('文件名不合法');
  let sha = '';
  try {
    const b = await request.json();
    sha = String((b as Record<string, unknown>)?.sha ?? '');
  } catch {
    /* 无 body 时走 query */
  }
  if (!sha) sha = new URL(request.url).searchParams.get('sha') ?? '';
  if (!sha) return fail('缺少 sha');
  try {
    await gh.deleteFile(locals, NOTES_PREFIX + file, sha, `admin: 删除随记 ${file}`);
  } catch (e) {
    return fail('删除失败：' + (e as Error)?.message, 500);
  }
  return ok({ file });
}
