import type { APIContext } from 'astro';
import { resolveRuntimeEnv } from './platform';

export interface RuntimeEnv {
  /** GitHub OAuth App 的 Client ID（登录用） */
  GITHUB_CLIENT_ID?: string;
  /** GitHub OAuth App 的 Client Secret（登录换 token + 会话签名密钥） */
  GITHUB_CLIENT_SECRET?: string;
  /** 允许登录的 GitHub 用户名（必填，无默认值，未配置时无法登录） */
  GITHUB_NAME?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  /** 账号密码登录：用户名（与 ADMIN_PASSWORD、GITHUB_PAT 三者齐全时启用） */
  ADMIN_USER?: string;
  /** 账号密码登录：密码（明文存于平台变量，与 CLIENT_SECRET 同级保管） */
  ADMIN_PASSWORD?: string;
  /** 账号密码登录：仓库令牌（GitHub PAT，登录时实测对 GITHUB_REPO 有写权限才放行） */
  GITHUB_PAT?: string;
  ADMIN_LOCAL_PREVIEW?: string;
  ADMIN_KV?: any;
  [k: string]: any;
}

/**
 * 读取运行时环境变量（实现收敛在 platform.ts 的平台适配层）：
 * Cloudflare Pages 上走 locals.runtime.env（@astrojs/cloudflare 注入），
 * EdgeOne Pages 上走 process.env（Node 云函数），本地开发同理。
 */
export function getEnv(locals: APIContext['locals']): RuntimeEnv {
  return resolveRuntimeEnv(locals) as RuntimeEnv;
}
