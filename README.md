# astro-blog-admin

Astro 博客内容仓库的管理后台，用于管理文章、随记、页面、站点设置和图床。内容仓库不写死在代码里，必须通过环境变量 `GITHUB_REPO` 指定（见下表）。

- 框架：Astro 5，SSR
- 云端部署：Cloudflare Pages（`@astrojs/cloudflare` adapter）
- 云端鉴权：GitHub OAuth，仅 `GITHUB_OWNER` 指定的账号可登录
- 本地预览：显式开启后，限本机回环地址免登录，内容 API 使用本地文件
- 仓库公开，**不要把密钥写入代码或提交历史**；本地密钥放在已忽略的 `.dev.vars`，云端密钥放 Cloudflare 环境变量

## 本地测试

需要 Node.js、npm，以及可访问的 WebDAV 服务。后台和博客站点要分别启动：

### 1. 配置并启动管理后台

在管理后台目录执行：

```bash
cd astro-blog-admin
npm install
cp .dev.vars.example .dev.vars
npm run dev -- --host 127.0.0.1 --port 4321
```

`.dev.vars.example` 已设置 `ADMIN_LOCAL_PREVIEW=true`。此模式仅在开发环境且通过 `localhost`、`127.0.0.1` 或 `::1` 访问时生效，可直接打开 http://127.0.0.1:4321，不需要 GitHub OAuth。不要把本地后台暴露到公网。

本地仍需 `ADMIN_KV` 绑定，用于保存图床的 WebDAV 设置；项目通过 `wrangler.toml` 配置此绑定，Astro/Cloudflare 本地开发时使用本地模拟的 KV。首次使用时打开图床“设置”，填写 WebDAV 地址、账号、密码并测试连接。此配置只保存在本地 KV，不会同步到 Cloudflare。

### 2. 启动博客站点

在另一个终端回到仓库根目录（`astro-blog-admin` 的上一级）：

```bash
npm install
npm run dev -- --host 127.0.0.1 --port 4323
```

`LOCAL_SITE_URL` 默认是 `http://127.0.0.1:4323`。后台通过这个站点预览本地图片；若修改端口，也要同步修改 `.dev.vars` 中的 `LOCAL_SITE_URL`。

### 3. 验证功能

打开 http://127.0.0.1:4321/images 上传图片，然后进入“管理”检查图片列表、搜索、复制链接和删除。图片预览链接应指向 `127.0.0.1:4323/img/...`。

本地预览会将文章、随记、页面和站点设置的编辑直接写入仓库文件；图片原图仍会上传到 WebDAV，同时图片副本写入博客的 `public/img/`。删除图片也会删除 WebDAV 原图和本地副本。因此测试前应确认目标文件和 WebDAV 目录，避免使用真实内容测试删除。

## 环境变量与绑定

| 名称 | 用途 |
|---|---|
| `GITHUB_CLIENT_ID` | GitHub OAuth App Client ID；云端登录必填，本地预览不需要 |
| `GITHUB_CLIENT_SECRET` | OAuth Client Secret，同时用于会话签名；云端必填 |
| `GITHUB_OWNER` | 唯一允许登录的 GitHub 用户名；**必填**，无默认值，未设置时任何人都无法登录 |
| `GITHUB_REPO` | 博客内容仓库，格式为「用户名/仓库名」；**必填**，无默认值 |
| `GITHUB_BRANCH` | 博客仓库分支，默认 `main` |
| `ADMIN_LOCAL_PREVIEW` | 本地免登录及本地文件预览开关；本地测试设为 `true`，不要在云端启用 |
| `LOCAL_SITE_URL` | 本地博客站点地址，默认 `http://127.0.0.1:4323` |
| `ADMIN_KV` | Cloudflare KV 命名空间绑定；必需，用于保存 WebDAV 配置。项目绑定名为 `ADMIN_KV` |

WebDAV 地址、账号、密码通过图床“设置”保存到当前环境的 KV。**本地 KV 和 Cloudflare KV 相互独立**，需要分别配置。

## 图床

图片统一存放在 WebDAV 的 `/img/` 目录，上传保留原始文件名（开启 WebP 转换时仅将扩展名改为 `.webp`）；遇到同名文件会失败，不覆盖现有文件。

- 本地预览：图片写入博客仓库的 `public/img/`，返回 `LOCAL_SITE_URL` 地址，不会发布到 GitHub Pages 图片仓库。
- 云端：图片发布到 `GITHUB_PAGES_REPO` 的根目录 `img/`，返回 jsDelivr CDN 地址。
- “管理”页可查看、搜索、复制链接和删除图片；删除会清理当前环境的站点副本和 WebDAV 原图。

## 部署到 Cloudflare Pages

1. 在 Cloudflare Pages 创建项目并连接仓库。若后台位于 `astro-blog-admin` 子目录，设置项目 Root directory 为 `astro-blog-admin`。
2. Build command 使用 `npm run build`，Build output directory 使用 `dist`。
3. 确认已绑定 KV 命名空间，binding 名为 `ADMIN_KV`（`wrangler.toml` 中已有绑定配置）。
4. 在 Pages 的 Production 和 Preview 环境变量中分别配置 OAuth、内容仓库及图片仓库变量。不要设置 `ADMIN_LOCAL_PREVIEW=true`。
5. 在 GitHub OAuth App 中将授权回调 URL 配置为 `https://你的后台域名/api/auth/callback`。登录账号需与 `GITHUB_OWNER` 一致，并具有内容仓库和图片仓库所需权限。
6. 部署完成后，登录云端后台，在图床“设置”中单独配置并测试 WebDAV。云端 WebDAV 配置不会从本地复制过去。

云端内容编辑通过 GitHub API 修改博客仓库；图床图片保存到 WebDAV，并发布到配置的 GitHub Pages 图片仓库。

## API 约定

成功响应：`{ "ok": true, "data": ... }`；失败响应：`{ "ok": false, "error": "错误信息" }`。
