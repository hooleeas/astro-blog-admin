# astro-blog-admin

Astro 博客内容仓库的管理后台——**[astro-blog](https://github.com/hooleeas/astro-blog)** 的配套项目：管理文章、随记、页面、站点设置，并**内置一个完整的图床**——双存储可切换、带免登录的公开上传页、图片链接用不依赖域名的相对路径（详见下文「图床」一节）。内容仓库不写死在代码里，必须通过环境变量 `GITHUB_REPO` 指定（见下表）。

- 框架：Astro 5，SSR
- 云端部署：同一仓库可同时部署到 Cloudflare Pages 与 EdgeOne Pages，两边构建命令相同（`npm run build`），构建时按环境特征自动识别平台并选用对应 adapter（`@astrojs/cloudflare` / `@edgeone/astro`），业务代码不感知平台；一般无需手动设置，特殊情况可用环境变量 `PLATFORM=cloudflare` / `PLATFORM=edgeone` 显式覆盖
- 云端鉴权：GitHub OAuth，仅 `GITHUB_NAME` 指定的账号可登录；也可另开账号密码登录（可选，见下文「账号密码登录」）
- 本地预览：显式开启后，限本机回环地址免登录，内容 API 使用本地文件
- 仓库公开，**不要把密钥写入代码或提交历史**；本地密钥放在已忽略的 `.dev.vars`，云端密钥放部署平台的环境变量（Cloudflare Pages 设置或 EdgeOne 控制台）

## 图床

图床是本后台的内置功能（不是外挂服务）：上传的图片只存一份在所选存储里，不进 GitHub 仓库；博客内容里引用图片时用相对路径，换域名、换平台都不用改链接。

### 存储

- 存储方式二选一，在图床「设置」页切换：WebDAV，或平台对象存储——设置页第二档按所在平台显示，Cloudflare 上是 Cloudflare R2（Pages 绑定 `IMGS_R2` 优先；没有绑定时在设置页填 R2 的 S3 端点与密钥），EdgeOne 上是 EdgeOne Blob（无需任何配置，部署后自动可用）。WebDAV 两个平台都能用。
- 切换存储**不迁移**已有图片：另一个存储里的图切回去才可见。
- 图片存放在所选存储的目录里（默认 `img`，可在设置里改、支持多级目录）；上传保留原始文件名，PNG/JPEG 可在浏览器端自动转 WebP（仅换扩展名）；同名文件自动改名为 `_1`、`_2`……，不覆盖原文件。

### 链接

- 图片链接是本站相对路径 `/<前缀>/<文件名>`，前缀默认 `images`、可在设置里改，不依赖任何外部域名天然跟随当前访问域名；旧的 `/images/` 链接仍可打开。
- 上传结果卡提供四种复制格式：URL（相对路径）、Markdown、HTML、BBCode（后三种自动拼当前域名成完整网址）；后台“管理”页的「复制链接」复制的也是完整网址。

### 上传页与管理

- 站点根路径 `/` 是免登录的**公开上传页**（页面标题可在图床设置里改），与后台共用同一套上传与存储逻辑，只能上传并拿到链接，不能管理图片、不能改设置；后台入口是 `/admin`（未登录先跳登录页）。
- 上传支持多文件同时进行：页面顶部每个文件一条细进度条（文件名 + 百分比），不弹模态框、不挡页面操作；结果卡与管理页的图片预览都可点击放大查看（灯箱）。
- “管理”页需登录，可查看、搜索、复制链接和删除图片。

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

本地仍需 `ADMIN_KV` 绑定，用于保存图床设置；项目通过 `wrangler.toml` 配置此绑定，Astro/Cloudflare 本地开发时使用本地模拟的 KV。首次使用时打开图床“设置”，填写 WebDAV 地址、账号、密码并测试连接。此配置只保存在本地 KV，不会同步到云端。本地默认按 Cloudflare 平台构建；EdgeOne 的 Blob 存储依赖部署流水线注入的凭证，本地不可用（会显示未配置），本地测试图床请用 WebDAV 或 R2。

### 2. 启动博客站点

在另一个终端回到仓库根目录（`astro-blog-admin` 的上一级）：

```bash
npm install
npm run dev -- --host 127.0.0.1 --port 4323
```

启动博客站点只是为了预览博客本身的页面效果；后台的本地文件模式不依赖它，可以跳过。

### 3. 验证功能

打开 http://127.0.0.1:4321/images 上传图片，然后进入“管理”检查图片列表、搜索、复制链接和删除。图片预览链接应指向 `127.0.0.1:4323/img/...`。

本地预览会将文章、随记、页面和站点设置的编辑直接写入本地文件；图片与云端一样走图床存储（WebDAV，或平台对象存储——Cloudflare 上是 R2、EdgeOne 上是 Blob，按图床设置），配置保存在本地 KV。因此测试删除图片前应确认目标存储与目录，避免使用真实内容测试删除。

## 环境变量与绑定

两个平台各配一份，互不影响：Cloudflare 在 Pages 项目的「设置 → 环境变量」中配置（Production 与 Preview 建议填一致），EdgeOne 在项目控制台的环境变量中配置；改动后都需要重新部署一次才生效。本地开发则写在 `.dev.vars` 里（模板见 `.dev.vars.example`）。代码里不写死任何仓库名或用户名，下列必填项缺失时后台会直接报错并提示缺哪个。

### 云端必填（缺一不可）

| 名称 | 填什么 |
|---|---|
| `GITHUB_CLIENT_ID` | GitHub OAuth App 的 Client ID。获取方式：GitHub → Settings → Developer settings → OAuth Apps → New OAuth App，其中 Authorization callback URL 填 `https://你的后台域名/api/auth/callback`；创建后在应用页面复制 Client ID。两个平台用同一个 OAuth App 即可，回调 URL 可加多条（上限 10 条），把两个平台的域名各加一条 |
| `GITHUB_CLIENT_SECRET` | 同一个 OAuth App 的 Client Secret（在应用页面点 Generate a new client secret 生成）；它同时用作后台登录会话的签名密钥，不要外泄 |
| `GITHUB_NAME` | 唯一允许登录本后台的 GitHub 用户名，填你自己的（即个人主页地址 `github.com/` 后面那串）；未设置时任何人无法登录 |
| `GITHUB_REPO` | 博客内容仓库，格式为「用户名/仓库名」；文章、随记、页面、站点设置都读写这个仓库，登录账号需要对它有写权限 |

### 云端可选

| 名称 | 填什么 |
|---|---|
| `GITHUB_BRANCH` | 内容仓库的分支，默认 `main`；只有仓库默认分支不是 `main` 时才需要填 |

### 账号密码登录（可选）

除 GitHub OAuth 外，后台还支持账号密码登录：登录页同时摆出密码表单和 GitHub 按钮，任选其一，登录后的会话与权限完全相同。启用条件是下面三个变量**同时**设置（缺任何一个，登录页就不显示密码表单、密码登录接口也直接拒绝）；两个平台各配一份，改动后重新部署一次才生效。

| 名称 | 填什么 |
|---|---|
| `ADMIN_USER` | 登录账号名，自己定 |
| `ADMIN_PASSWORD` | 登录密码，自己定；按密钥对待（与 `GITHUB_CLIENT_SECRET` 同级），不要外泄 |
| `GITHUB_PAT` | 仓库主人的 GitHub 个人令牌，建议用 Fine-grained 令牌：只授权 `GITHUB_REPO` 这一个仓库、Permissions 里 Contents 给读写即可，有效期按需选 |

密码本身只证明身份，读写仓库靠 `GITHUB_PAT`：每次密码登录时，服务器都会拿令牌实测一次 GitHub——令牌主人必须是 `GITHUB_NAME`、且对 `GITHUB_REPO` 有写权限，任一不过都不予登录。密码连续输错 8 次会锁定 15 分钟（计数存平台的配置存储；存储不可用时跳过锁定，不影响正常登录）。密码登录签发的会话没有刷新令牌，由登录中间件定期向 GitHub 验活。

### 绑定（仅 Cloudflare，在 Pages「设置 → 函数」里添加，不是环境变量）

| 绑定名 | 填什么 |
|---|---|
| `ADMIN_KV` | **Cloudflare 必需**。先在 Cloudflare 创建一个 KV 命名空间，再绑定到本项目，变量名必须正好是 `ADMIN_KV`；图床的设置（存储方式、WebDAV 配置等）保存在这个 KV 里 |
| `IMGS_R2` | 可选，图床用 Cloudflare R2 时才需要。在 Pages 里把 R2 存储桶绑定到本项目、变量名填 `IMGS_R2` 即可（推荐，图床设置里不用再填任何密钥）；也可以不绑定，改在图床「设置」页填写 R2 的 S3 端点与密钥，二选一。绑定增删后同样需要重新部署一次 |
| `ADMIN_D1` | 可选，图床账本（渠道配置、图片登记等）改存 D1 时才需要。先在 Cloudflare 创建一个 D1 数据库，再绑定到本项目、变量名填 `ADMIN_D1`，重新部署一次；之后在图床「设置」里把「数据存储」切到 D1（KV 与 D1 两个绑定都检测到时设置里才显示这个选项，缺任何一个都不显示；只绑 D1、不绑 KV 也完全可以，此时账本固定走 D1）。切换是整体搬家：数据搬到目标端并校验条数后会清空原位置，只保留一份；默认使用 KV，不切不动 |

EdgeOne 侧**不需要任何绑定**：图床设置与图片文件都存 EdgeOne Blob（`@edgeone/pages-blob`），命名空间在首次调用时自动创建，部署凭证由 EdgeOne 部署流水线在打包时自动注入；官方 KV 在 EdgeOne 仅支持 Edge Functions 且需控制台开通绑定，本项目不依赖它（代码保留了「全局绑定变量 `ADMIN_KV`」作最后兜底，可不配）。

### 仅本地开发

| 名称 | 填什么 |
|---|---|
| `ADMIN_LOCAL_PREVIEW` | 本地免登录及本地文件模式开关，只写在 `.dev.vars` 里并设为 `true`；**云端不要设置** |

图床的 WebDAV 地址、账号、密码不走环境变量：登录后台后在图床「设置」中填写，保存到平台的配置存储（Cloudflare 是 `ADMIN_KV`，EdgeOne 是 Blob）。**各环境的配置相互独立**（本地 KV、Cloudflare KV、EdgeOne Blob 互不相通），需要在每个环境分别配置；同一份代码部署到两个平台时，两边的图床设置也要各配一遍。

## 部署到 Cloudflare Pages

1. 在 Cloudflare Pages 创建项目并连接仓库。若后台位于 `astro-blog-admin` 子目录，设置项目 Root directory 为 `astro-blog-admin`。
2. Build command 使用 `npm run build`，Build output directory 使用 `dist`。
3. 确认已绑定 KV 命名空间，绑定名为 `ADMIN_KV`；图床想用 R2 时再把 R2 存储桶以 `IMGS_R2` 绑定（可选，见上文绑定表）。
4. 在 Pages 的 Production 和 Preview 环境变量中分别填好四个必填变量（`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_NAME`、`GITHUB_REPO`）。不要设置 `ADMIN_LOCAL_PREVIEW=true`，也不需要设置 `PLATFORM`（构建时自动识别）。
5. 在 GitHub OAuth App 中将授权回调 URL 配置为 `https://你的后台域名/api/auth/callback`。登录账号需与 `GITHUB_NAME` 一致，并对 `GITHUB_REPO` 有写权限。
6. 部署完成后，登录云端后台，在图床“设置”中选择存储方式并测试连接。云端图床配置保存在云端 KV，不会从本地复制过去。

## 部署到 EdgeOne Pages

同一个仓库可以再部署一份到 EdgeOne Pages，两边互不影响，推送到 `main` 会各自触发部署。

1. 在 EdgeOne Pages 创建项目并连接同一个仓库。
2. Build command 使用 `npm run build`（与 Cloudflare 完全相同，不需要改任何构建配置，也不需要设置 `PLATFORM`——构建环境自带 EdgeOne 标记，自动识别）。
3. 在项目控制台的环境变量中填好四个必填变量（`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_NAME`、`GITHUB_REPO`）。不要设置 `ADMIN_LOCAL_PREVIEW=true`。
4. 不需要申请或绑定 KV、R2 等任何存储：图床设置与图片都走 EdgeOne Blob，首次使用时自动创建，部署流水线会自动注入 Blob 凭证（因此 Blob 只能在经 EdgeOne 部署后生效，本地运行不可用）。
5. 在同一个 GitHub OAuth App 中再加一条授权回调 URL：`https://你的 EdgeOne 后台域名/api/auth/callback`（回调可加多条，Cloudflare 那条保留不动；Homepage URL 只能填一个，保持原样即可）。
6. 部署完成后，登录 EdgeOne 后台，在图床“设置”中把存储方式选为 EdgeOne Blob 并测试连接。EdgeOne 侧的图床配置独立保存在 Blob 中，不会从 Cloudflare 或本地同步过来，需要重新配一遍（WebDAV 参数等）。

云端内容编辑通过 GitHub API 修改 `GITHUB_REPO` 指定的仓库；图床图片按设置保存到 WebDAV 或所在平台的对象存储（Cloudflare R2 / EdgeOne Blob）。

## API 约定

成功响应：`{ "ok": true, "data": ... }`；失败响应：`{ "ok": false, "error": "错误信息" }`。
