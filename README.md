# astro-blog-admin

Astro 博客内容仓库的管理后台，用于管理文章、随记、页面、站点设置和图床。内容仓库不写死在代码里，必须通过环境变量 `GITHUB_REPO` 指定（见下表）。

- 框架：Astro 5，SSR
- 云端部署：Cloudflare Pages（`@astrojs/cloudflare` adapter）
- 云端鉴权：GitHub OAuth，仅 `GITHUB_NAME` 指定的账号可登录
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

启动博客站点只是为了预览博客本身的页面效果；后台的本地文件模式不依赖它，可以跳过。

### 3. 验证功能

打开 http://127.0.0.1:4321/images 上传图片，然后进入“管理”检查图片列表、搜索、复制链接和删除。图片预览链接应指向 `127.0.0.1:4323/img/...`。

本地预览会将文章、随记、页面和站点设置的编辑直接写入本地文件；图片与云端一样走图床存储（WebDAV 或 Cloudflare R2，按图床设置），配置保存在本地 KV。因此测试删除图片前应确认目标存储与目录，避免使用真实内容测试删除。

## 环境变量与绑定

在 Cloudflare Pages 项目的「设置 → 环境变量」中配置（Production 与 Preview 建议填一致），改动后需要重新部署一次才生效。本地开发则写在 `.dev.vars` 里（模板见 `.dev.vars.example`）。代码里不写死任何仓库名或用户名，下列必填项缺失时后台会直接报错并提示缺哪个。

### 云端必填（缺一不可）

| 名称 | 填什么 |
|---|---|
| `GITHUB_CLIENT_ID` | GitHub OAuth App 的 Client ID。获取方式：GitHub → Settings → Developer settings → OAuth Apps → New OAuth App，其中 Authorization callback URL 填 `https://你的后台域名/api/auth/callback`；创建后在应用页面复制 Client ID |
| `GITHUB_CLIENT_SECRET` | 同一个 OAuth App 的 Client Secret（在应用页面点 Generate a new client secret 生成）；它同时用作后台登录会话的签名密钥，不要外泄 |
| `GITHUB_NAME` | 唯一允许登录本后台的 GitHub 用户名，填你自己的（即个人主页地址 `github.com/` 后面那串）；未设置时任何人无法登录 |
| `GITHUB_REPO` | 博客内容仓库，格式为「用户名/仓库名」；文章、随记、页面、站点设置都读写这个仓库，登录账号需要对它有写权限 |

### 云端可选

| 名称 | 填什么 |
|---|---|
| `GITHUB_BRANCH` | 内容仓库的分支，默认 `main`；只有仓库默认分支不是 `main` 时才需要填 |

### 绑定（在 Pages「设置 → 函数」里添加，不是环境变量）

| 绑定名 | 填什么 |
|---|---|
| `ADMIN_KV` | **必需**。先在 Cloudflare 创建一个 KV 命名空间，再绑定到本项目，变量名必须正好是 `ADMIN_KV`；图床的设置（存储方式、WebDAV 配置等）保存在这个 KV 里 |
| `IMGS_R2` | 可选，图床用 Cloudflare R2 时才需要。在 Pages 里把 R2 存储桶绑定到本项目、变量名填 `IMGS_R2` 即可（推荐，图床设置里不用再填任何密钥）；也可以不绑定，改在图床「设置」页填写 R2 的 S3 端点与密钥，二选一。绑定增删后同样需要重新部署一次 |

### 仅本地开发

| 名称 | 填什么 |
|---|---|
| `ADMIN_LOCAL_PREVIEW` | 本地免登录及本地文件模式开关，只写在 `.dev.vars` 里并设为 `true`；**云端不要设置** |

图床的 WebDAV 地址、账号、密码不走环境变量：登录后台后在图床「设置」中填写，保存到 `ADMIN_KV`。**本地 KV 和 Cloudflare KV 相互独立**，需要分别配置。

## 图床

- 存储方式二选一，在图床「设置」页切换：WebDAV，或 Cloudflare R2（Pages 绑定 `IMGS_R2` 优先；没有绑定时在设置页填 R2 的 S3 端点与密钥）。
- 图片存放在所选存储的目录里（默认 `img`，可在设置里改、支持多级目录）；上传保留原始文件名，PNG/JPEG 可在浏览器端自动转 WebP（仅换扩展名）；同名文件自动改名为 `_1`、`_2`……，不覆盖原文件。
- 图片链接是本站相对路径 `/<前缀>/<文件名>`，前缀默认 `images`、可在设置里改，不依赖任何外部域名。
- 站点根路径 `/` 是免登录的公开上传页，只能上传并拿到链接；“管理”页需登录，可查看、搜索、复制链接和删除图片。

## 部署到 Cloudflare Pages

1. 在 Cloudflare Pages 创建项目并连接仓库。若后台位于 `astro-blog-admin` 子目录，设置项目 Root directory 为 `astro-blog-admin`。
2. Build command 使用 `npm run build`，Build output directory 使用 `dist`。
3. 确认已绑定 KV 命名空间，绑定名为 `ADMIN_KV`；图床想用 R2 时再把 R2 存储桶以 `IMGS_R2` 绑定（可选，见上文绑定表）。
4. 在 Pages 的 Production 和 Preview 环境变量中分别填好四个必填变量（`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_NAME`、`GITHUB_REPO`）。不要设置 `ADMIN_LOCAL_PREVIEW=true`。
5. 在 GitHub OAuth App 中将授权回调 URL 配置为 `https://你的后台域名/api/auth/callback`。登录账号需与 `GITHUB_NAME` 一致，并对 `GITHUB_REPO` 有写权限。
6. 部署完成后，登录云端后台，在图床“设置”中选择存储方式并测试连接。云端图床配置保存在云端 KV，不会从本地复制过去。

云端内容编辑通过 GitHub API 修改 `GITHUB_REPO` 指定的仓库；图床图片按设置保存到 WebDAV 或 Cloudflare R2。

## API 约定

成功响应：`{ "ok": true, "data": ... }`；失败响应：`{ "ok": false, "error": "错误信息" }`。
