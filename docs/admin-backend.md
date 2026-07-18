# 文章上传后台 (/admin) 说明

在网页上写文章、传图、自动发布，不再需要本地文件夹。
流程：浏览器 → `/api/admin/*`(鉴权)→ 写入 GitHub 仓库 `src/content/posts/xxx.md` → 触发 Cloudflare 重建。
文章仍是 Markdown 文件，不改 content collection、不改构建链。

## 前置：为什么用 GitHub + Deploy Hook

站点纯静态(构建期生成 HTML)，线上运行时没有文件系统、没有常驻进程。
所以"后端"不是往线上写文件，而是：后端把 .md 写进源码仓库 → 触发一次构建 → 新 HTML 上线。
真正发文章需 1-2 分钟构建延迟，这是架构特性，非缺陷。

## 文件清单

| 文件 | 作用 |
|---|---|
| `src/lib/server/auth.ts` | HMAC 签名 token 签发/校验、失败限流、cookie 名 `volant_admin` |
| `src/lib/server/github.ts` | GitHub Contents API 封装(写/列/读/删/传图)+ 触发 CF Deploy Hook |
| `src/lib/server/env.ts` | 运行时环境变量读取：`cloudflare:workers` → 本地回退 `process.env` |
| `src/lib/server/guard.ts` | 端点鉴权守卫，返回 status=200 sentinel 表示放行 |
| `src/lib/server/web.ts` | JSON 响应辅助 |
| `src/pages/api/admin/login.ts` `logout.ts` `upload.ts` `posts.ts` `post.ts` `upload-image.ts` `batch.ts` `publish.ts` | 运行时端点(全 `prerender=false`) |
| `src/pages/admin.astro` + `src/components/pages/AdminPanel.svelte` | 后台页面（本地暂存 + 统一发布） |

## 发布模型：先暂存，再一次 commit

**Deploy Hook 不会减少 Git 提交。** Hook 只触发 CF 重建；文章内容仍必须写入 Git 仓库，所以每次 Contents API 写入 = 1 次 commit。

正确做法是后台改用「本地暂存」：

1. 编辑 / 删除 / 批量改草稿 → 写入浏览器 `localStorage`（不碰 GitHub）
2. 点 **发布全部** → `POST /api/admin/publish` 用 Git Data API **一次 commit 多文件**
3. 仓库 push 触发 CF **一次**构建

图片上传仍即时写仓（单独 commit），否则预览无图。

## ⚠️ 部署必备环境变量(Cloudflare 项目 Settings → 配置)

| 变量 | 必填 | 说明 |
|---|---|---|
| `CF_WORKERS` | **是** | 部署构建变量，设为 `1` 才启用 cloudflare adapter，否则线上 API 404 |
| `ADMIN_PASSWORD` | **是** | 后台登录密码，兼作 HMAC 签名密钥 |
| `GH_TOKEN` | **是** | GitHub Fine-grained PAT，授权 Firefly 仓库 Contents 读写 |
| `CF_DEPLOY_HOOK` | 视情 | **已连 Git 自动部署时不需要(否则一次保存触发两次构建)**。仅当未连 Git 自动部署、或想强制立即重建时才配:Settings → Deploy Hooks 创建(分支选 master)的 URL |
| `GH_REPO_OWNER` | 否 | 默认 `htx60280-lab` |
| `GH_REPO_NAME` | 否 | 默认 `Firefly` |
| `GH_BRANCH` | 否 | 默认 `main`(注意本仓实际默认分支是 `master`,本地/线上建议显式设 `GH_BRANCH=master`) |
| `AUTH_SECRET` | 否 | 独立 HMAC 密钥，默认复用 `ADMIN_PASSWORD` |
| `ADMIN_TTL_SECONDS` | 否 | 会话有效期秒，默认 7 天 |

## Cloudflare Workers Builds 部署教程

本项目走 **Workers Builds**(Worker 部署)。`@astrojs/cloudflare@14` 已不再支持 Pages,必须用 Worker 形态。admin 端点是运行时渲染(`prerender=false`),需要 adapter,而 adapter 由构建环境变量 `CF_WORKERS=1` 开启。

### 一、修复首次构建报错(关键)

推送后 CF 自动构建报 `NoAdapterInstalled — Cannot use server-rendered pages without an adapter`。根因:CF 构建环境没设 `CF_WORKERS`,导致 `astro.config.mjs` 的 adapter 没启用,而项目里有运行时端点。修法是设这个构建环境变量(代码已就绪,`wrangler.jsonc` 也已配好 adapter 入口)。

### 二、在 CF 控制台设置(按顺序)

1. **设构建环境变量 `CF_WORKERS=1`**(修构建报错,本步必做)
   - CF Dashboard → Workers & Pages → 选 `firefly` 项目 → Settings
   - 找到 **Build**(或 Builds & deployments)→ **Environment variables**(构建变量,不是运行时 Variables and Secrets)
   - 添加变量:`CF_WORKERS` = `1`
   - 保存后触发一次 redeploy(Settings→Builds→Retry deployment,或直接 push 一个空 commit)

2. **设运行时 Secrets**(Worker 运行时读取,放进 `wrangler` 的 secrets)
   - 同项目 Settings → **Variables and Secrets**(运行时,与上一步构建变量区分开)
   - 添加(Encrypt 类型):
     - `ADMIN_PASSWORD` = 你的后台登录密码(自定义,**设强一点**)
     - `GH_TOKEN` = GitHub PAT(见下方获取方式)
     - `CF_DEPLOY_HOOK` = Deploy Hook URL。**已连 Git 自动部署时不要配**（会与 push 叠加触发两次构建）；仅未连 Git 自动部署时才需要。本仓默认已连 Git 自动部署，建议这项直接不设。
     - `GH_BRANCH` = `master`(本仓默认分支是 master,不设会回退到 main 导致查不到文章)
   - 保存。Secrets 改动会自动触发新构建部署。

3. **创建 Deploy Hook —— 多数情况可跳过本步**
   - 本仓默认已连 Git 自动部署（push 即自动构建），**不需要** Deploy Hook：写仓 push 本身就会触发 CF 构建。再配 hook 会与 push 叠加，导致一次保存触发两次构建。
   - 仅当你的项目**没连** Git 自动部署、或想保留一个"随时手动强制重建"的入口时，才配：
     同项目 Settings → **Builds & deployments** → **Deploy Hooks** → Add Deploy Hook → 名称随意、**Branch 选 `master`** → 复制 URL 填进上面的 `CF_DEPLOY_HOOK`。

### 三、环境变量获取方式

- **GH_TOKEN**(GitHub PAT)：
  - GitHub → 头像 → Settings → Developer settings → Fine-grained personal access tokens → Generate new token
  - Repository access 选 **Only select repositories** → 勾选 `htx60280-lab/Firefly`
  - Repository permissions → **Contents: Read and write**(其他保持默认即可)
  - 生成后复制(只显示一次),填进 CF Secret `GH_TOKEN`
- **CF_DEPLOY_HOOK**:见上面第 3 步（已连 Git 自动部署时直接不设）。

### 四、验证部署成功

1. 等 CF 构建完成(Deployments 列表看变绿)。
2. 浏览器打开 `https://你的域名/admin/`,应看到登录框。
3. 输入 `ADMIN_PASSWORD` 登录,进后台。
4. 点「写文章」,填标题/正文(先用假内容试一篇 draft),保存 → 看后端是否返回「已新增 + 已触发重建」。
5. 去 CF Deployments 看是否自动多了一次构建(由写仓的 git push 触发);构建成功后 1-2 分钟,文章页上线。若发现一次保存出现两次构建,说明同时配了 Git 自动部署和 `CF_DEPLOY_HOOK` —— 删掉后者即可。
6. 若「写文章」报 GitHub 401/403 → `GH_TOKEN` 权限或仓库选择不对;若提示「未配置 GitHub 凭证」→ `GH_TOKEN` 没设或拼错;若文章已入仓站点却不更新 → 未连 Git 自动部署且未配 `CF_DEPLOY_HOOK`,或分支名写错(`GH_BRANCH`/Hook Branch 都要 master)。

### 五、常见排错

| 现象 | 原因 | 解法 |
|---|---|---|
| 构建报 `NoAdapterInstalled` | 没设 `CF_WORKERS=1` | 在 Build 的构建环境变量里加,是 `1` 不是 `true` |
| 构建绿但 `/api/admin/*` 线上 404 | 构建变量与运行时 secret 混淆,或没设 `CF_WORKERS` | 确保 `CF_WORKERS` 在 **Build** 环境变量,不在 secret;Secrets 里别放它 |
| 部署后 `ADMIN_PASSWORD` 等变量丢失 | 它们当初设成 **Plaintext**,被 `wrangler.jsonc` 当应收口清理 | 重新设为 **Encrypt(Secret)** 类型,此后任何部署都不会再丢 |
| 一次保存触发两次 CF 构建 | 已连 Git 自动部署 + 又配了 `CF_DEPLOY_HOOK`,写仓 push 和 hook 各触发一次 | **删掉 `CF_DEPLOY_HOOK`** Secret(Git 自动部署已足够);保留则每次保存双构建 |
| 登录页 500「服务未正确配置鉴权」 | `ADMIN_PASSWORD` 没设或又被清理 | Secrets 用 Encrypt 类型加 `ADMIN_PASSWORD` 并重部署 |
| 列/写文章 502「fetch failed」或 401 | `GH_TOKEN` 权限/仓库错 | 确认 PAT 勾选 Firefly 仓库且 Contents 读写 |
| 文章写进仓库了但站点没更新 | 未连 Git 自动部署且 `CF_DEPLOY_HOOK` 没配/分支选错 | 已连 Git 自动部署则删 hook 即可;未连则配 hook(Branch 选 master) |
| 保存文章报「已存在」409 | slug 与现有文章重名 | 改标题或换 slug,或在编辑现有文章时用更新模式 |
| 编辑现有文章报「xxx.md 不存在,无法更新」 | 改标题后前端用新标题算 slug,后端按新名查旧文件 404 | 已修复:编辑态锁定原文件名,改标题不换文件 |
| 本地 dev 报同样 NoAdapterInstalled | dev 走 Vite 不读 CF_WORKERS | dev 不需要 adapter:本地端点在 Vite dev 下运行时渲染可工作,不报 NoAdapterInstalled(该报错只发生在 `astro build`);如需本地 `astro build`,临时 `CF_WORKERS=1 pnpm build` |

> 注:本仓默认分支是 `master`,`GH_BRANCH` 和 Deploy Hook 的 Branch 都必须选 `master`,否则后端把文章写到 master、却去 main 上列文章,会查不到。

## 本地测试

### 1. 配 `.env`(项目根，已被 .gitignore 忽略，安全)

```
ADMIN_PASSWORD=test1234
GH_TOKEN=ghp_你的真token      # 假 token 只能测鉴权/页面/校验，写仓会 401/403
GH_REPO_OWNER=htx60280-lab
GH_REPO_NAME=Firefly
GH_BRANCH=master
# CF_DEPLOY_HOOK=  本地通常不配，上传后提示"未触发构建"为正常
```

### 2. 三种启动方式

**A. 浏览器点测(推荐先这条)**
```bash
pnpm dev          # 起 http://localhost:4321
# 浏览器打开 http://localhost:4321/admin/ ，输 test1234 登录
```
注：Vite dev 里 `import('cloudflare:workers')` 会失败、回退读 `process.env`(即 `.env`)，行为与线上等价。

**B. curl 验端点**
```bash
# ⚠️ 本机有 Clash 代理，测 localhost 必须加 --noproxy '*'，否则 502/失败
J=/tmp/j.txt
# 未登录 GET login  → 期望 401
curl -s --noproxy '*' http://127.0.0.1:4321/api/admin/login -H "Accept: application/json" -w "\n%{http_code}\n"
# 错误密码 → 期望 401
curl -s --noproxy '*' -X POST http://127.0.0.1:4321/api/admin/login -H "Content-Type: application/json" -d '{"password":"wrong"}'
# 正确密码 → 期望 200，-c 存签名 cookie
curl -s --noproxy '*' -c "$J" -X POST http://127.0.0.1:4321/api/admin/login -H "Content-Type: application/json" -d '{"password":"test1234"}'
# 带cookie列文章 → 无真token时 500「未配置GitHub凭证」或 GitHub 401；有真token时返回列表
curl -s --noproxy '*' -b "$J" http://127.0.0.1:4321/api/admin/posts -H "Accept: application/json" -w "\n%{http_code}\n"
# 无效slug上传 → 期望 400
curl -s --noproxy '*' -b "$J" -X POST http://127.0.0.1:4321/api/admin/upload -H "Content-Type: application/json" -d '{"title":"T","body":"x","slug":"Bad Slug!"}' -w "\n%{http_code}\n"
```

**C. wrangler 本地(最贴近线上，能真测 cloudflare:workers env)**
```bash
pnpm build
npx wrangler dev            # 用本地 .dev.vars 读 secrets
# 打开 wrangler 提示的地址(通常 8785)/admin/
```
此模式 `cloudflare:workers` 可用，secrets 从 `.dev.vars` 读(不是 `.env`)，需另建：
```
# .dev.vars (也建议 gitignore)
ADMIN_PASSWORD=test1234
GH_TOKEN=ghp_你的真token
...
```

### 3. 本地实测要点(踩过的坑)

- **trailingSlash: "always"**：`astro.config` 设了尾斜杠强制，API fetch 必须带尾斜杠(`/api/admin/login/` 否则 301 重定向丢 POST body)。前端已用 `withTrailingSlash()` 统一处理；curl 测试加 `-L` 且 URL 带尾斜杠。
- **dev 下 .env 不自动进 process.env**：Vite 只把 `VITE_` 前缀变量塞进 `process.env`，非前缀的 `ADMIN_PASSWORD` 等读不到。`env.ts` 已用 `loadEnv(mode, cwd, "")` 兜底加载项目根 `.env`，故本地 dev 直接放 `.env` 即可。
- **测 localhost 的坑**：本机有 Clash 代理，curl 必须加 `--noproxy '*'`；dev server 监听在 IPv6 `[::1]:4321`(不是 `127.0.0.1`)，所以测试地址用 `http://[::1]:4321`。
- 假 `GH_TOKEN` 时调 GitHub 会 `502 fetch failed` 或 401，是正常(错误能正确透传)；要测真实列/写文章必须配真 token。

### 4. 本地能测到什么 / 测不到什么

| 能测 | 说明 |
|---|---|
| 登录鉴权链路 | 密码校验、签名 cookie、未登录拦截、限流 |
| 页面渲染 | /admin 登录框 → 后台 → 编辑器 → 实时预览 |
| 输入校验 | slug 合法性、title/body 必填、frontmatter 序列化 |
| 错误处理 | 500/401/400/409 各路径 |

| 需真 GH_TOKEN 才能测 | 说明 |
|---|---|
| 列/读/写文章 | 真调 GitHub Contents API |
| 传图 | 写入 src/content/posts/images/ |
| 触发重建 | 需真 CF_DEPLOY_HOOK |
| 整条端到端 | 登录→写仓→CF 重建→文章上线(约 1-2 分钟) |
