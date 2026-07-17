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
| `src/pages/api/admin/login.ts` `logout.ts` `upload.ts` `posts.ts` `post.ts` `upload-image.ts` | 运行时端点(全 `prerender=false`) |
| `src/pages/admin.astro` + `src/components/pages/AdminPanel.svelte` | 后台页面 |

## ⚠️ 部署必备环境变量(Cloudflare 项目 Settings → 配置)

| 变量 | 必填 | 说明 |
|---|---|---|
| `CF_WORKERS` | **是** | 部署构建变量，设为 `1` 才启用 cloudflare adapter，否则线上 API 404 |
| `ADMIN_PASSWORD` | **是** | 后台登录密码，兼作 HMAC 签名密钥 |
| `GH_TOKEN` | **是** | GitHub Fine-grained PAT，授权 Firefly 仓库 Contents 读写 |
| `CF_DEPLOY_HOOK` | 推荐 | Cloudflare 项目 Settings → Deploy Hooks 创建(分支选 master)的 URL |
| `GH_REPO_OWNER` | 否 | 默认 `htx60280-lab` |
| `GH_REPO_NAME` | 否 | 默认 `Firefly` |
| `GH_BRANCH` | 否 | 默认 `main`(注意本仓实际默认分支是 `master`,本地/线上建议显式设 `GH_BRANCH=master`) |
| `AUTH_SECRET` | 否 | 独立 HMAC 密钥，默认复用 `ADMIN_PASSWORD` |
| `ADMIN_TTL_SECONDS` | 否 | 会话有效期秒，默认 7 天 |

> GH_TOKEN 获取：GitHub Settings → Developer settings → Fine-grained tokens → 勾选 Firefly 仓库 → Contents: Read & Write。
> CF_DEPLOY_HOOK 获取：Cloudflare 项目 → Settings → Builds & deployments → Deploy Hooks → 新建(分支选本仓默认分支)。

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
