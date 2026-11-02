import type { APIContext } from 'astro';

export interface RuntimeEnv {
  /** GitHub OAuth App 的 Client ID（登录用） */
  GITHUB_CLIENT_ID?: string;
  /** GitHub OAuth App 的 Client Secret（登录换 token + 会话签名密钥） */
  GITHUB_CLIENT_SECRET?: string;
  /** 允许登录的 GitHub 用户名（必填，无默认值，未配置时无法登录） */
  GITHUB_NAME?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  ADMIN_LOCAL_PREVIEW?: string;
  ADMIN_KV?: any;
  [k: string]: any;
}

/**
 * 读取运行时环境变量。
 * Cloudflare Pages 上走 locals.runtime.env（@astrojs/cloudflare 注入），
 * 本地 `astro dev` 时走 process.env。
 */
export function getEnv(locals: APIContext['locals']): RuntimeEnv {
  const r = (locals as any)?.runtime?.env;
  if (r) return r as RuntimeEnv;
  return (typeof process !== 'undefined' ? process.env : {}) as unknown as RuntimeEnv;
}
