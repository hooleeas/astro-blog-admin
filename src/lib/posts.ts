// Worker 2：文章模块共享逻辑（分组、模板渲染、语言配置、并发池）
import { getFile } from './github.js';
import { parsePost } from './frontmatter.js';
import { readRepoTemplate, type Gh } from './content.js';
import * as ghMod from './github.js';

const gh = ghMod as unknown as Gh;

export const POSTS_DIR = 'src/content/posts';
/** 语言展示与创建顺序：简中、繁中、英语、日语、韩语 */
export const POST_LANGS = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko'];
const CONFIG_PATH = 'src/data/config.jsonc';
const TEMPLATE_PREFIX = 'templates/posts/post.';

export interface PostFileRef {
  lang: string;
  slug: string;
  path: string;
}
export interface PostMeta extends PostFileRef {
  sha: string;
  frontmatter: Record<string, any>;
}
export interface PostDetail extends PostMeta {
  body: string;
}
export interface LangSlot {
  slug: string;
  draft: boolean;
  pubDate: string;
}
export interface PostGroup {
  key: string;
  title: string;
  pubDate: string;
  langs: Record<string, LangSlot | null>;
  count: number;
}

/** 简单并发池 */
export async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  const n = Math.min(Math.max(size, 1), items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/** 从 tree 路径列表中筛出文章文件引用 */
export function postRefsFromPaths(paths: string[]): PostFileRef[] {
  const prefix = POSTS_DIR + '/';
  const refs: PostFileRef[] = [];
  for (const p of paths) {
    if (!p.startsWith(prefix) || !/\.(md|mdx)$/i.test(p)) continue;
    const rest = p.slice(prefix.length).split('/');
    if (rest.length < 2) continue; // 语言目录缺失，跳过
    const lang = rest[0];
    const slug = rest[rest.length - 1].replace(/\.(md|mdx)$/i, '');
    refs.push({ lang, slug, path: p });
  }
  return refs;
}

/** 取全部文章的 frontmatter 元信息（withBody=true 时连正文一起取） */
export async function getAllPostMeta(locals: unknown, withBody: boolean): Promise<PostDetail[]> {
  const refs = postRefsFromPaths(await gh.listTree(locals));
  return mapPool(refs, 8, async (r) => {
    try {
      const { sha, content } = await gh.getFile(locals, r.path);
      const { frontmatter, body } = parsePost(content);
      return { ...r, sha, frontmatter, body: withBody ? body : '' };
    } catch {
      // 单个文件读失败不影响整体，记空 frontmatter
      return { ...r, sha: '', frontmatter: {}, body: '' };
    }
  });
}

/** 分组键：有 translationKey 用它，否则按自身路径单独成组 */
export function groupKeyOf(m: { frontmatter: Record<string, any>; path: string }): string {
  const tk = m.frontmatter?.translationKey;
  return typeof tk === 'string' && tk.trim() ? tk : `path:${m.path}`;
}

/** pubDate 归一化为 YYYY-MM-DD（Date 或字符串均可），取不到返回 '' */
export function normDate(v: unknown): string {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return '';
}

/** frontmatter 归一化（供编辑页表单使用：Date→YYYY-MM-DD 字符串） */
export function normalizeFrontmatter(fm: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...(fm || {}) };
  const d = normDate(out.pubDate);
  if (d) out.pubDate = d;
  if (!Array.isArray(out.tags)) out.tags = [];
  return out;
}

/** 按 translationKey 分组，标题优先取 zh-Hans 版本，按 pubDate 倒序 */
export function groupPosts(metas: PostMeta[]): PostGroup[] {
  const map = new Map<string, PostMeta[]>();
  for (const m of metas) {
    const k = groupKeyOf(m);
    const arr = map.get(k);
    if (arr) arr.push(m);
    else map.set(k, [m]);
  }
  const groups: PostGroup[] = [];
  for (const [key, items] of map) {
    const zh = items.find((i) => i.lang === 'zh-Hans') ?? items[0];
    const rawTitle = zh?.frontmatter?.title;
    const title = typeof rawTitle === 'string' && rawTitle ? rawTitle : key;
    const langs: Record<string, LangSlot | null> = {};
    for (const L of POST_LANGS) {
      const it = items.find((i) => i.lang === L);
      langs[L] = it
        ? { slug: it.slug, draft: it.frontmatter?.draft === true, pubDate: normDate(it.frontmatter?.pubDate) }
        : null;
    }
    const dates = items.map((i) => normDate(i.frontmatter?.pubDate)).filter(Boolean).sort();
    groups.push({ key, title, pubDate: dates[dates.length - 1] ?? '', langs, count: items.length });
  }
  groups.sort((a, b) => b.pubDate.localeCompare(a.pubDate));
  return groups;
}

/** 取某分组的全部版本（按 POST_LANGS 排序），不存在返回 [] */
export async function resolveGroup(locals: unknown, key: string, withBody: boolean): Promise<PostDetail[]> {
  const all = await getAllPostMeta(locals, withBody);
  const order = new Map(POST_LANGS.map((L, i) => [L, i]));
  return all
    .filter((m) => groupKeyOf(m) === key)
    .sort((a, b) => (order.get(a.lang) ?? 99) - (order.get(b.lang) ?? 99));
}

/** JSONC 去注释（字符串内的 // 不误伤） */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 启用的语言列表：读仓库 src/data/config.jsonc 的 languages（enabled），
 * 读不到时回退到内置五语言。顺序按 POST_LANGS，多余的排后面。
 */
export async function getEnabledLanguages(locals: unknown): Promise<string[]> {
  let codes: string[] = [];
  try {
    const f = await getFile(locals, CONFIG_PATH);
    const cfg = JSON.parse(stripJsonc(f.content));
    const arr = Array.isArray(cfg?.languages) ? cfg.languages : [];
    codes = arr.filter((l: any) => l && l.enabled && typeof l.code === 'string').map((l: any) => l.code as string);
  } catch {
    codes = [];
  }
  if (!codes.length) return [...POST_LANGS];
  return [...POST_LANGS.filter((c) => codes.includes(c)), ...codes.filter((c) => !POST_LANGS.includes(c))];
}

/** 模板 404 时的内置最小模板（含全部必需字段，保证字段替换能命中） */
export const MINIMAL_TEMPLATE = `---
title: ''
subtitle: ''
pubDate: 2000-01-01
tags: []
category: 'Notes'
cover: ''
translationKey: ''
draft: false
popular: false
---

正文写在这里。
`;

/** 取某语言的文章模板（仓库实时取，404 用内置最小模板兜底） */
export async function getPostTemplate(locals: unknown, code: string): Promise<string> {
  const tpl = await readRepoTemplate(gh, locals, `${TEMPLATE_PREFIX}${code}.md`);
  return tpl ?? MINIMAL_TEMPLATE;
}

/**
 * 模板字段替换，复刻 scripts/new.js 的 replaceRequired：
 * 缺必需字段行直接抛错（500），而不是静默生成坏文件。
 */
export function renderPostTemplate(
  template: string,
  vars: { title: string; date: string; translationKey: string },
): string {
  const replaceRequired = (content: string, pattern: RegExp, replacement: string, field: string): string => {
    if (!pattern.test(content)) {
      const err = new Error(`模板缺少 ${field} 字段，无法生成文件`);
      (err as any).status = 500;
      throw err;
    }
    return content.replace(pattern, replacement);
  };
  let out = template;
  out = replaceRequired(out, /^title:.*$/m, `title: ${JSON.stringify(vars.title)}`, 'title');
  out = replaceRequired(out, /^subtitle:.*$/m, 'subtitle: ""', 'subtitle');
  out = replaceRequired(out, /^pubDate:.*$/m, `pubDate: ${vars.date}`, 'pubDate');
  out = replaceRequired(
    out,
    /^translationKey:.*$/m,
    `translationKey: ${JSON.stringify(vars.translationKey)}`,
    'translationKey',
  );
  out = replaceRequired(out, /^draft:.*$/m, 'draft: true', 'draft');
  return out;
}
