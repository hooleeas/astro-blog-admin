# astro-blog-admin

[astro-blog](https://github.com/hooleeas/astro-blog) 的中文管理后台：管理文章、随记、页面、站点变量与图床。

- 框架：Astro 5（`output: 'server'`，SSR）
- 部署目标：Cloudflare Pages（`@astrojs/cloudflare` adapter）
- 鉴权：管理员密码 + HMAC-SHA256 签名的 httpOnly 会话 cookie（7 天有效期）
- 仓库公开，**任何密钥都不得进入代码或提交历史**，一律走环境变量

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | ✅ | 管理员登录密码（部署者自行设定，强密码） |
| `GITHUB_PAT` | ✅ | GitHub 个人访问令牌，需要 `repo` 权限，用于读写博客仓库 |
| `GITHUB_REPO` | ✅ | 博客仓库，如 `hooleeas/astro-blog` |
| `GITHUB_BRANCH` | | 博客仓库分支，默认 `main` |

可选：`ADMIN_KV`（KV 命名空间绑定，当前鉴权不依赖 KV，预留扩展用）。

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填写真实值（.dev.vars 已 gitignore，不会提交）
npm install
npm run dev
```

打开 http://localhost:4321/login 登录。

## 部署到 Cloudflare Pages

1. 在 Cloudflare Dashboard 新建 Pages 项目，连接本仓库。
2. Build 配置：Framework preset 选 Astro，Build command `npm run build`，Build output directory `dist`。
3. （可选）如需 KV：创建 KV 命名空间，把 `wrangler.toml` 里 `REPLACE_WITH_KV_ID` 换成真实 id，再提交。
4. 在 Pages 项目 **Settings → Environment variables**（Production 与 Preview）配置上面表格中的环境变量。
5. （可选）绑定自定义域名 `admin.hooleeas.com`：Pages 项目 → Custom domains。

## API 约定

所有 API 统一返回：

- 成功：`{ ok: true, data }`
- 失败：`{ ok: false, error: '错误信息' }`

## 目录结构

```
src/
├── lib/
│   ├── env.ts        # 运行时环境变量读取（Pages 上走 locals.runtime.env）
│   └── session.ts    # 会话 cookie 签发 / 校验（Web Crypto HMAC-SHA256）
├── middleware.ts     # 全局守卫：保护 /admin/* 与 /api/*
├── layouts/
│   └── AdminLayout.astro  # 后台布局（导航 + 退出）
└── pages/
    ├── login.astro         # 登录页
    ├── admin/
    │   └── index.astro     # 仪表盘
    └── api/auth/
        ├── login.ts
        └── logout.ts
```
