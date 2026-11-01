import type { APIContext } from 'astro';
import { getFile, putFile, deleteFile, moveFile } from '../../../lib/github.js';
import {
  ok,
  fail,
  parseFrontmatter,
  serializeFrontmatter,
  isValidDate,
  NOTE_FILE_RE,
  type Gh,
} from '../../../lib/content.js';
import { getEnv } from '../../../lib/env.js';

export const prerender = false;

const NOTES_PREFIX = 'src/content/notes/';
const gh = { getFile, putFile, deleteFile } as unknown as Gh;

function validFile(params: APIContext['params']): string | null {
  const file = String(params.file ?? '');
  return NOTE_FILE_RE.test(file) ? file : null;
}

function isLocalPreview(locals: APIContext['locals'], request: Request) {
  const hostname = new URL(request.url).hostname;
  return import.meta.env.DEV &&
    getEnv(locals).ADMIN_LOCAL_PREVIEW === 'true' &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
}

/** GET /api/notes/[file] — 读单篇随记 */
export async function GET({ locals, params, request }: APIContext) {
  const file = validFile(params);
  if (!file) return fail('文件名不合法（仅允许字母、数字、._- 且以 .md 结尾）');
  if (isLocalPreview(locals, request)) {
    try {
      const { readLocalNote } = await import('../../../lib/local-data.js');
      const { sha, content } = await readLocalNote(file);
      const { fm, body } = parseFrontmatter(content);
      return ok({
        file,
        sha,
        frontmatter: { date: fm.date ?? '', draft: fm.draft === 'true' },
        body,
        raw: content,
      });
    } catch (e) {
      const error = e as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') return fail('随记不存在', 404);
      return fail('读取本地随记失败：' + (error.message || String(e)), 500);
    }
  }
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

  if (isLocalPreview(locals, request)) {
    try {
      const { readLocalNote, updateLocalNote } = await import('../../../lib/local-data.js');
      const cur = await readLocalNote(file);
      const fm = parseFrontmatter(cur.content).fm as Record<string, unknown>;
      fm.date = date;
      fm.draft = draft ? 'true' : 'false';
      const updatedContent = serializeFrontmatter(fm, text);
      const slug = file.replace(/^\d{4}-\d{2}-\d{2}-/u, '').replace(/\.md$/u, '');
      const nextFile = `${date}-${slug}.md`;
      await updateLocalNote(file, nextFile, updatedContent, sha);
      return ok({ file: nextFile });
    } catch (e) {
      const error = e as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') return fail('随记不存在', 404);
      if (error.code === 'CONFLICT') return fail('随记已被其他操作修改，请重新加载后再保存', 409);
      if (error.code === 'EEXIST') return fail('目标文件名已存在，请修改日期或处理同名随记', 409);
      return fail('本地保存随记失败：' + (error.message || String(e)), 500);
    }
  }

  let current: { sha: string; content: string };
  try {
    current = await gh.getFile(locals, NOTES_PREFIX + file);
  } catch {
    return fail('随记不存在', 404);
  }
  if (current.sha !== sha) return fail('随记已被其他操作修改，请重新加载后再保存', 409);

  const fm = parseFrontmatter(current.content).fm as Record<string, unknown>;
  fm.date = date;
  fm.draft = draft ? 'true' : 'false';
  const updatedContent = serializeFrontmatter(fm, text);
  const slug = file.replace(/^\d{4}-\d{2}-\d{2}-/u, '').replace(/\.md$/u, '');
  const nextFile = `${date}-${slug}.md`;

  try {
    if (nextFile === file) {
      await gh.putFile(locals, NOTES_PREFIX + file, updatedContent, `admin: 更新随记 ${file}`, sha);
    } else {
      await moveFile(
        locals,
        NOTES_PREFIX + file,
        NOTES_PREFIX + nextFile,
        updatedContent,
        sha,
        `admin: 更新随记日期 ${file} → ${nextFile}`,
      );
    }
  } catch (e) {
    const error = e as { status?: number; message?: string };
    return fail(error.message || String(e), error.status === 409 ? 409 : 500);
  }
  return ok({ file: nextFile });
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
  if (isLocalPreview(locals, request)) {
    try {
      const { deleteLocalNote } = await import('../../../lib/local-data.js');
      await deleteLocalNote(file, sha);
      return ok({ file });
    } catch (e) {
      const error = e as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') return fail('随记不存在', 404);
      if (error.code === 'CONFLICT') return fail('随记已被其他操作修改，请重新加载后再删除', 409);
      return fail('本地删除随记失败：' + (error.message || String(e)), 500);
    }
  }
  try {
    await gh.deleteFile(locals, NOTES_PREFIX + file, sha, `admin: 删除随记 ${file}`);
  } catch (e) {
    return fail('删除失败：' + (e as Error)?.message, 500);
  }
  return ok({ file });
}
