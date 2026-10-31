// Worker 2：文章 frontmatter 解析 / 序列化 / 校验（gray-matter，保留完整类型）
import matter from 'gray-matter';

export interface PostFrontmatter {
  [k: string]: any;
}

export function parsePost(raw: string): { frontmatter: PostFrontmatter; body: string } {
  const parsed = matter(raw || '');
  return { frontmatter: (parsed.data || {}) as PostFrontmatter, body: parsed.content ?? '' };
}

export function serializePost(frontmatter: PostFrontmatter, body: string): string {
  return matter.stringify(body ?? '', frontmatter ?? {});
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isValidDateValue(v: unknown): boolean {
  if (v instanceof Date) return !isNaN(v.getTime());
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return !isNaN(d.getTime());
  }
  return false;
}

/**
 * 按 astro-blog src/content.config.ts 的 posts schema 校验。
 * 注意：subtitle 允许空字符串（scripts/new.js 新建时即写 subtitle: ""，
 * 若要求非空则新建的草稿无法保存）。其余按 schema 严格校验。
 */
export function validatePostFrontmatter(fm: unknown): ValidationResult {
  const errors: string[] = [];
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
    return { valid: false, errors: ['frontmatter 必须是对象'] };
  }
  const f = fm as Record<string, any>;

  if (typeof f.title !== 'string' || !f.title.trim()) errors.push('title 必填且不能为空');
  if (typeof f.subtitle !== 'string') errors.push('subtitle 必须是字符串');
  if (!isValidDateValue(f.pubDate)) errors.push('pubDate 必须是可解析的日期');

  if (f.cover != null && f.cover !== '') {
    if (typeof f.cover !== 'string') {
      errors.push('cover 必须是字符串');
    } else {
      try {
        new URL(f.cover);
      } catch {
        errors.push('cover 不是合法 URL');
      }
    }
  }

  if (!Array.isArray(f.tags) || !f.tags.every((t: unknown) => typeof t === 'string')) {
    errors.push('tags 必须是字符串数组');
  }
  if (typeof f.category !== 'string') errors.push('category 必须是字符串');
  if (typeof f.draft !== 'boolean') errors.push('draft 必须是布尔值');
  if (typeof f.popular !== 'boolean') errors.push('popular 必须是布尔值');
  if (typeof f.translationKey !== 'string' || !f.translationKey.trim()) {
    errors.push('translationKey 必填且不能为空');
  }

  return { valid: errors.length === 0, errors };
}
