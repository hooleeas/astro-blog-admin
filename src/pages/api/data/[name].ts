import type { APIContext } from 'astro';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { getFile, putFile } from '../../../lib/github.js';
import { ok, fail, isDataName, offsetToLineCol, type Gh } from '../../../lib/content.js';
import { getEnv } from '../../../lib/env.js';

export const prerender = false;

const gh = { getFile, putFile } as unknown as Gh;
const dataPath = (name: string) => `src/data/${name}.jsonc`;

function describeErrors(content: string, errors: ParseError[]) {
  return errors.slice(0, 5).map((e) => {
    const { line, character } = offsetToLineCol(content, e.offset);
    return { message: printParseErrorCode(e.error), offset: e.offset, line, character };
  });
}

function isLocalDataPreview(locals: APIContext['locals'], request: Request) {
  const hostname = new URL(request.url).hostname;
  return import.meta.env.DEV &&
    getEnv(locals).ADMIN_LOCAL_PREVIEW === 'true' &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
}

function parseData(name: string, content: string, sha: string) {
  const errors: ParseError[] = [];
  const parsed = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
  const out: Record<string, unknown> = { name, raw: content, parsed: errors.length ? null : parsed, sha };
  if (errors.length) out.parseError = describeErrors(content, errors);
  return out;
}

/** GET /api/data/[name] — 读 jsonc：{ raw, parsed, sha, parseError? } */
export async function GET({ locals, params, request }: APIContext) {
  const name = String(params.name ?? '');
  if (!isDataName(name)) return fail('name 不合法，仅支持 config | posts | about | apple | services');
  if (isLocalDataPreview(locals, request)) {
    try {
      const { readLocalData } = await import('../../../lib/local-data.js');
      const { sha, content } = await readLocalData(name);
      return ok(parseData(name, content, sha));
    } catch (error) {
      const status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
      return fail(status === 404 ? `本地变量文件不存在：${dataPath(name)}` : `读取本地变量失败：${(error as Error).message}`, status);
    }
  }
  try {
    const { sha, content } = await gh.getFile(locals, dataPath(name));
    return ok(parseData(name, content, sha));
  } catch {
    return fail(`变量文件不存在：${dataPath(name)}`, 404);
  }
}

/** PUT /api/data/[name] — 保存，body: { content }；先用 jsonc-parser 校验，有错 400 */
export async function PUT({ locals, params, request }: APIContext) {
  const name = String(params.name ?? '');
  if (!isDataName(name)) return fail('name 不合法，仅支持 config | posts | about | apple | services');
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail('请求体不是合法 JSON');
  }
  const content = String(body?.content ?? '');
  const sha = String(body?.sha ?? '');
  if (!sha) return fail('缺少 sha（请先重新加载再保存）');

  const errors: ParseError[] = [];
  parse(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    return Response.json(
      { ok: false, error: 'JSONC 语法错误，保存已中止', parseErrors: describeErrors(content, errors) },
      { status: 400 },
    );
  }

  if (isLocalDataPreview(locals, request)) {
    try {
      const { writeLocalData } = await import('../../../lib/local-data.js');
      const nextSha = await writeLocalData(name, content, sha);
      return ok({ name, path: dataPath(name), sha: nextSha });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'CONFLICT') return fail('本地文件已被其他操作修改，请重新加载后再保存', 409);
      if (code === 'ENOENT') return fail(`本地变量文件不存在：${dataPath(name)}`, 404);
      return fail(`保存本地变量失败：${(error as Error).message}`, 500);
    }
  }

  try {
    await gh.putFile(locals, dataPath(name), content, `admin: 更新变量 ${name}.jsonc`, sha);
  } catch (e) {
    return fail('保存失败：' + (e as Error)?.message, 500);
  }
  return ok({ name, path: dataPath(name) });
}
