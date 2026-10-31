// Worker 2：GitHub Contents API / Git Data API 封装
// 首参一律传 Astro locals；GitHub token 由 middleware 在校验会话后写入 locals.githubToken
// （GITHUB_REPO 默认 hooleeas/astro-blog，GITHUB_BRANCH 默认 main）。
// 兼容 Cloudflare Workers：base64 用 TextEncoder + btoa 分段实现，不用 Node Buffer。
import { getEnv } from './env.js';

const API_BASE = 'https://api.github.com';
const DEFAULT_REPO = 'hooleeas/astro-blog';
const DEFAULT_BRANCH = 'main';

export class GithubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
  }
}

interface RepoConfig {
  repo: string;
  branch: string;
  token: string;
}

function repoConfig(locals: unknown): RepoConfig {
  const env = getEnv(locals as any);
  // token 由 middleware 校验会话后写入 locals（OAuth 登录时签发）
  const token = (locals as any)?.githubToken as string | undefined;
  if (!token) throw new GithubError(401, '未登录或会话已失效');
  return {
    repo: env.GITHUB_REPO || DEFAULT_REPO,
    branch: env.GITHUB_BRANCH || DEFAULT_BRANCH,
    token,
  };
}

/** base64 编码（Workers 无 Buffer，分段避免大字符串栈溢出） */
export function b64encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 解码 */
export function b64decode(input: string): string {
  const binary = atob(input.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

/** 通用请求。非 2xx 抛 GithubError（带 status，便于调用方识别 404）。 */
export async function gh(locals: unknown, path: string, method = 'GET', body?: unknown): Promise<any> {
  const { repo, token } = repoConfig(locals);
  const res = await fetch(`${API_BASE}/repos/${repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'astro-blog-admin',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GithubError(res.status, `GitHub API ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

export interface RepoFile {
  sha: string;
  content: string;
  path: string;
}

/** 读单个文件，content 为解码后的 utf8 文本。404 抛 GithubError(status=404)。 */
export async function getFile(locals: unknown, path: string): Promise<RepoFile> {
  const { branch } = repoConfig(locals);
  const data = await gh(locals, `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
  if (!data || Array.isArray(data) || data.type !== 'file') {
    throw new GithubError(404, `不是文件：${path}`);
  }
  // 超大文件（>1MB）Contents API 不返回 content
  if (typeof data.content !== 'string') throw new GithubError(413, `文件过大无法读取：${path}`);
  return { sha: data.sha as string, path: (data.path as string) || path, content: b64decode(data.content) };
}

/** 写文件（sha 缺省=新建，传 sha=更新）。返回新 sha。 */
export async function putFile(
  locals: unknown,
  path: string,
  content: string,
  message: string,
  sha?: string,
): Promise<{ sha: string; path: string }> {
  const { branch } = repoConfig(locals);
  const data = await gh(locals, `/contents/${encodePath(path)}`, 'PUT', {
    message,
    content: b64encode(content),
    branch,
    ...(sha ? { sha } : {}),
  });
  return { sha: data.content.sha as string, path: (data.content.path as string) || path };
}

/** 删除单个文件（需 sha）。 */
export async function deleteFile(locals: unknown, path: string, sha: string, message: string): Promise<void> {
  const { branch } = repoConfig(locals);
  await gh(locals, `/contents/${encodePath(path)}`, 'DELETE', { message, sha, branch });
}

/**
 * 全仓库文件路径列表（git trees recursive=1，仅 blob）。
 * 注意：超大仓库可能被截断（truncated），本博客规模可忽略。
 */
export async function listTree(locals: unknown): Promise<string[]> {
  const { branch } = repoConfig(locals);
  const data = await gh(locals, `/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const tree = Array.isArray(data?.tree) ? data.tree : [];
  return tree.filter((e: any) => e?.type === 'blob' && typeof e?.path === 'string').map((e: any) => e.path as string);
}

interface TreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  sha: string | null; // null = 删除该路径
}

/** 低层：基于 base tree 构建新 tree → commit → 更新分支引用（单 commit）。 */
async function commitTree(locals: unknown, entries: TreeEntry[], message: string): Promise<{ commit: string }> {
  const { branch } = repoConfig(locals);
  const ref = await gh(locals, `/git/ref/heads/${encodeURIComponent(branch)}`);
  const baseCommitSha = ref.object.sha as string;
  const baseCommit = await gh(locals, `/git/commits/${baseCommitSha}`);
  const baseTreeSha = baseCommit.tree.sha as string;
  const newTree = await gh(locals, '/git/trees', 'POST', { base_tree: baseTreeSha, tree: entries });
  const commit = await gh(locals, '/git/commits', 'POST', {
    message,
    tree: newTree.sha,
    parents: [baseCommitSha],
  });
  await gh(locals, `/git/refs/heads/${encodeURIComponent(branch)}`, 'PATCH', { sha: commit.sha });
  return { commit: commit.sha as string };
}

/** 批量写文件（单 commit）：先逐个建 blob，再一次提交。用于新建文章的 5 语言文件打包。 */
export async function commitFiles(
  locals: unknown,
  files: Array<{ path: string; content: string }>,
  message: string,
): Promise<{ commit: string }> {
  const entries: TreeEntry[] = [];
  for (const f of files) {
    const blob = await gh(locals, '/git/blobs', 'POST', { content: b64encode(f.content), encoding: 'base64' });
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha as string });
  }
  return commitTree(locals, entries, message);
}

/**
 * 批量删除（单 commit）：Git Trees API 无原生批量删除，
 * 建 tree 时对应 path 的 sha 置 null 即删除。
 */
export async function deleteFiles(locals: unknown, paths: string[], message: string): Promise<{ commit: string }> {
  const entries: TreeEntry[] = paths.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null }));
  return commitTree(locals, entries, message);
}
