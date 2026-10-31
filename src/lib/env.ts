import type { APIContext } from 'astro';

export interface RuntimeEnv {
  GITHUB_PAT?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  ADMIN_PASSWORD?: string;
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
