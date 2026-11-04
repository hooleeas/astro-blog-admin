import type { APIRoute } from 'astro';
import { getEnv } from '../../../lib/env';
import { getKVStore } from '../../../lib/platform';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  signSessionV2,
  timingSafeEqual,
} from '../../../lib/session';

export const prerender = false;

/**
 * POST /api/auth/password { username, password }
 * 账号密码登录（与 GitHub OAuth 并存）：
 * - 启用条件：环境变量 ADMIN_USER / ADMIN_PASSWORD / GITHUB_PAT 三者齐全；
 * - 密码只认人不带仓库权限：放行前拿 GITHUB_PAT 实测 GitHub——
 *   令牌主人必须是 GITHUB_NAME、且对 GITHUB_REPO 有 push 权限，任一不过都不签发会话；
 * - 会话载荷与 OAuth 登录同构（v2，access 位放 PAT、无 refresh），middleware 等下游零改动；
 * - 连续失败 8 次锁定 15 分钟（计数存平台 KV，KV 不可用时跳过锁定不阻断登录）。
 */

const LOCK_KEY = 'auth:pwd-lock';
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60 * 1000;

function cookieHeader(value: string, isHttps: boolean): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(isHttps ? ['Secure'] : []),
  ].join('; ');
}

async function ghJson(token: string, path: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'astro-blog-admin',
    },
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);
  const url = new URL(request.url);
  const isHttps = url.protocol === 'https:';

  const adminUser = (env.ADMIN_USER || '').trim();
  const adminPassword = env.ADMIN_PASSWORD || '';
  const pat = (env.GITHUB_PAT || '').trim();
  if (!adminUser || !adminPassword || !pat) {
    return Response.json({ ok: false, error: '未启用账号密码登录' }, { status: 403 });
  }
  if (!env.GITHUB_CLIENT_SECRET) {
    return Response.json(
      { ok: false, error: '服务端未配置 GITHUB_CLIENT_SECRET' },
      { status: 500 }
    );
  }
  const owner = (env.GITHUB_NAME || '').trim();
  const repo = (env.GITHUB_REPO || '').trim();
  if (!owner || !repo) {
    return Response.json(
      { ok: false, error: '服务端未配置 GITHUB_NAME / GITHUB_REPO' },
      { status: 500 }
    );
  }

  let body: { username?: string; password?: string };
  try {
    body = (await request.json()) as { username?: string; password?: string };
  } catch {
    return Response.json({ ok: false, error: '请求格式不对' }, { status: 400 });
  }
  const username = (body.username || '').trim();
  const password = body.password || '';

  // 失败锁定（KV 尽力而为：读不到/写不进都不阻断正常登录）
  const kv = await getKVStore(locals).catch(() => null);
  let lock: { fails: number; until: number } = { fails: 0, until: 0 };
  if (kv) {
    try {
      const raw = await kv.get(LOCK_KEY);
      if (raw) lock = { fails: 0, until: 0, ...JSON.parse(raw) };
    } catch {
      lock = { fails: 0, until: 0 };
    }
  }
  if (lock.until > Date.now()) {
    const mins = Math.max(1, Math.ceil((lock.until - Date.now()) / 60000));
    return Response.json(
      { ok: false, error: `尝试次数过多，请 ${mins} 分钟后再试` },
      { status: 429 }
    );
  }

  const userOk = timingSafeEqual(username, adminUser);
  const passOk = timingSafeEqual(password, adminPassword);
  if (!userOk || !passOk) {
    if (kv) {
      try {
        const fails = lock.fails + 1;
        const next =
          fails >= MAX_FAILS
            ? { fails: 0, until: Date.now() + LOCK_MS }
            : { fails, until: 0 };
        await kv.put(LOCK_KEY, JSON.stringify(next));
      } catch {
        /* 锁定写失败不影响本次拒绝 */
      }
    }
    await new Promise((r) => setTimeout(r, 600));
    return Response.json({ ok: false, error: '账号或密码不正确' }, { status: 401 });
  }

  // 实测仓库令牌：主人对 + 写权限有，缺一不可
  let me: { status: number; data: any };
  let repoInfo: { status: number; data: any };
  try {
    me = await ghJson(pat, '/user');
    // GITHUB_REPO 是全站统一的「用户名/仓库名」全名格式（见 lib/github.ts），直接用；
    // 万一配的是裸仓库名，再退回拼主人名的写法。
    const repoPath = repo.includes('/') ? repo : `${owner}/${repo}`;
    repoInfo = await ghJson(pat, `/repos/${repoPath}`);
  } catch {
    return Response.json(
      { ok: false, error: '连不上 GitHub，仓库令牌验证不了，请稍后再试' },
      { status: 502 }
    );
  }
  if (me.status === 401 || repoInfo.status === 401) {
    return Response.json(
      { ok: false, error: '仓库令牌已失效，请更新 GITHUB_PAT 后重新部署' },
      { status: 502 }
    );
  }
  if (!me.data || me.data.login !== owner) {
    return Response.json(
      { ok: false, error: '仓库令牌不是仓库主人的，请换仓库主人的令牌' },
      { status: 502 }
    );
  }
  if (repoInfo.status !== 200) {
    return Response.json(
      { ok: false, error: '仓库令牌访问不到目标仓库，请检查令牌的仓库范围' },
      { status: 502 }
    );
  }
  if (!repoInfo.data?.permissions?.push) {
    return Response.json(
      { ok: false, error: '仓库令牌没有该仓库的写权限，请给它 Contents 读写权限' },
      { status: 502 }
    );
  }

  // 验证全过：清失败计数，签发与 OAuth 同构的 v2 会话（access 位放 PAT）
  if (kv) {
    try {
      await kv.put(LOCK_KEY, JSON.stringify({ fails: 0, until: 0 }));
    } catch {
      /* 清计数失败无碍 */
    }
  }
  const sessionValue = await signSessionV2(
    env.GITHUB_CLIENT_SECRET,
    pat,
    '',
    Date.now() + 15 * 60 * 1000
  );
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  headers.append('set-cookie', cookieHeader(sessionValue, isHttps));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
