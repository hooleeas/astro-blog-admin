// Worker 3 共享工具：随记 / 页面 / 变量模块
// GitHub API 由 Worker 2 的 src/lib/github.ts 提供，本文件只放纯逻辑与白名单。

export const LANGS = ['zh-Hans', 'zh-Hant', 'ja', 'ko', 'en'] as const;

/** Worker 2 的 github.ts 期望契约（首参一律传 Astro locals） */
export interface Gh {
  getFile: (locals: unknown, path: string) => Promise<{ sha: string; content: string }>;
  putFile: (locals: unknown, path: string, content: string, message: string, sha?: string) => Promise<unknown>;
  deleteFile: (locals: unknown, path: string, sha: string, message: string) => Promise<unknown>;
  listTree: (locals: unknown) => Promise<string[]>;
  commitFiles: (locals: unknown, files: Array<{ path: string; content: string }>, message: string) => Promise<unknown>;
}

/** slugify：NFKC → 小写 → 去非 [\p{L}\p{N}\s-] → [\s-]+ 转 - → 去首尾 - */
export function slugify(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Asia/Shanghai 时区今日，YYYY-MM-DD */
export function shanghaiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** 严格校验 YYYY-MM-DD 为真实日期 */
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function ok(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

export function fail(error: string, status = 400): Response {
  return Response.json({ ok: false, error }, { status });
}

export interface ParsedNote {
  fm: Record<string, string>;
  body: string;
}

/** 极简 frontmatter 解析（只取 key: value 行） */
export function parseFrontmatter(content: string): ParsedNote {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2].trim();
  }
  return { fm, body: content.slice(m[0].length) };
}

/** frontmatter 序列化（保留传入的全部字段） */
export function serializeFrontmatter(fm: Record<string, unknown>, body: string): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/** 转义后嵌入 "双引号 JS 字符串字面量"（页面标题用） */
export function escapeJsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

/** 文本 offset → 行列（1-based，用于 jsonc 错误定位） */
export function offsetToLineCol(text: string, offset: number): { line: number; character: number } {
  const before = text.slice(0, Math.max(0, offset));
  const line = before.split('\n').length;
  const character = offset - (before.lastIndexOf('\n') + 1) + 1;
  return { line, character };
}

/** 读仓库模板文件，404/失败返回 null（调用方用内置模板兜底） */
export async function readRepoTemplate(gh: Gh, locals: unknown, path: string): Promise<string | null> {
  try {
    const f = await gh.getFile(locals, path);
    return typeof f.content === 'string' ? f.content : null;
  } catch {
    return null;
  }
}

// ---- 白名单 ----
export const NOTE_FILE_RE = /^[A-Za-z0-9._-]+\.md$/; // 随记文件名（防路径穿越）
export const PAGE_SLUG_RE = /^[A-Za-z0-9_-]+$/; // 页面 slug（防路径穿越）
export const DATA_NAMES = ['config', 'posts', 'about', 'apple', 'services'] as const;
export type DataName = (typeof DATA_NAMES)[number];
export function isDataName(n: string): n is DataName {
  return (DATA_NAMES as readonly string[]).includes(n);
}
