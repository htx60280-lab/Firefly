---
title: Firefly 部署到 Cloudflare：从本地到上线
published: 2026-07-18
updated: 2026-07-18
draft: false
description: 按步骤把 Firefly 部署到 Cloudflare Workers，关联 GitHub 自动构建；并说明本站 /admin 后台写文章的用法与密钥配置。
image: ""
tags: [Cloudflare, Astro, Firefly, 部署]
category: 技术
lang: ""
pinned: true
author: ""
sourceLink: ""
licenseName: ""
licenseUrl: ""
comment: true
---

根据本站实际部署过程整理，步骤可直接跟着做。命令可复制。

说明：基于 Windows / 已会用终端；主题为 [Firefly](https://github.com/CuteLeaf/Firefly)（Astro 静态博客）。官方主题**没有**网页发文后台，写文章就是在本地改 Markdown，push 后自动上线。

本站仓库示例：

- GitHub：https://github.com/htx60280-lab/Firefly  
- 站点：https://volant.cc.cd  

你若是自己的仓库，把下文里的 `htx60280-lab` 换成你的用户名即可。默认分支以 **master** 为例（若是 `main`，全文替换）。

## 一、你要达成什么

- 代码放在 **GitHub**
- **Cloudflare** 自动：拉代码 → 安装依赖 → 构建 → 上线
- 以后改配置、写文章：本地改完 `git push`，网站自动更新
- 不用自己买服务器也能先用 `*.workers.dev` 访问

整体链路：

```text
本地改代码 → push 到 GitHub → Cloudflare 自动构建 → 域名可访问
```

## 二、前置准备

先确认这几样都有：

1. **Node.js ≥ 22**（终端执行 `node -v` 有版本号）
2. **pnpm**（`pnpm -v` 有版本号；没有就：`npm install -g pnpm`）
3. **Git**（`git -v` 正常）
4. **GitHub 账号**，并拥有一份 Firefly 代码：
   - Fork二改版 [Fork](https://github.com/htx60280-lab/Firefly)
5. **Cloudflare 账号**（[注册/登录](https://dash.cloudflare.com/)）

本地先跑通：

```bash
git git clone https://github.com/你的用户名/Firefly.git
cd Firefly
pnpm install
pnpm dev
```

浏览器打开 `http://localhost:4321`，首页正常即可。  

## 三、仓库里和部署相关的配置

### 1. 站点地址

改 `src/config/siteConfig.ts` 里的 `site_url`，例如本站：

```ts
site_url: "https://volant.cc.cd",
```

没有正式域名时，可先填 Cloudflare 给的 `*.workers.dev`，绑定域名后再改一次并 push。

### 2. Wrangler 配置

项目根目录需要有 `wrangler.jsonc`（名称可按项目改）。本站大致如下：

```jsonc
{
  "name": "firefly",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist"
  }
}
```

说明：

- `assets.directory`：构建产物目录，Firefly 默认是 `dist`
- 纯静态托管时，这样即可；若你后续加了运行时接口，再按官方文档补 `main`、`ASSETS` 绑定等

改完推到 GitHub：

```bash
git add .
git commit -m "chore: 准备 Cloudflare 部署"
git push
```

## 四、Cloudflare 关联 GitHub 并部署

### 1. 创建应用

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com/)
2. 左侧进入 **Workers 和 Pages**
3. **创建应用程序** → 连接到 **Git** / **GitHub**
4. 授权后选中仓库：**你自己的 Fork仓库**
5. 构建相关建议填：

| 项 | 建议值 |
|---|---|
| 构建命令 | `pnpm build` |
| 部署命令 | `npx wrangler deploy`（若控制台要求填写） |
| 分支 | `master`（或你的默认分支） |

6. 点部署，等第一次构建跑完

### 2. 验证是否成功

构建状态变绿后，打开项目提供的临时域名（形如 `xxx.workers.dev`）。  
能打开博客首页，且和本地预览大致一致，说明自动部署已通。

之后每次：

```bash
git add .
git commit -m "更新内容"
git push origin master
```

Cloudflare 会再自动构建上线，一般 1～3 分钟。

### 3. 若构建报 Adapter 相关错误

部分从官方模板魔改、或加过服务端能力的仓库，构建时需要启用 Cloudflare adapter。  
若日志出现类似：

```text
NoAdapterInstalled: Cannot use server-rendered pages without an adapter
```

到项目 **Settings → 构建 / Build → 环境变量** 增加：

| 变量名 | 值 |
|---|---|
| `CF_WORKERS` | `1` |

注意：这是**构建环境变量**，不是随便放在别处的密钥。设好后重试部署。  
官方原版 Firefly 若全程纯静态、无运行时路由，多数情况不需要这一步。

## 五、绑定自己的域名（可选）

临时域名能用就可以先写文章；有域名再绑。本站绑定后为：https://volant.cc.cd

1. 进入该 Worker 项目 → **设置 / 触发器** → **自定义域** → 添加你的域名  
2. 按提示在域名注册商处添加 **CNAME**（主机 `@` 或 `www`，目标按 CF 页面显示填写）  
3. 等待解析生效（几分钟到数小时）  
4. 浏览器访问你的域名，能打开且有 HTTPS 小锁即成功  

同时把 `siteConfig.ts` 里的 `site_url` 改成正式域名，再 push 一次。

## 六、日常怎么写文章

Firefly **没有**自带的网页后台。文章目录：

```text
src/content/posts/
```

新建 `xxx.md`，开头写 frontmatter，例如：

```yaml
---
title: 文章标题
published: 2026-07-18
description: 一句话简介
tags: [标签1, 标签2]
category: 技术
draft: false
---
```

注意：**日期不要加引号**，写成 `2026-07-18`，不要写成 `"2026-07-18"`，否则部分环境下构建可能报类型错误。

本地预览：

```bash
pnpm dev
```

满意后：

```bash
git add src/content/posts/
git commit -m "docs: 新增文章"
git push origin master
```

等 Cloudflare 构建完成，文章就上线了。

也可使用官方脚手架：

```bash
pnpm new-post 文章文件名
```

## 七、本站扩展：用 `/admin` 后台写文章（可选）

官方 Firefly **没有**网页后台。本站仓库（[htx60280-lab/Firefly](https://github.com/htx60280-lab/Firefly)）额外加了 **`/admin` 管理页**：在浏览器里写 Markdown，先暂存在本地，再一次性提交到 GitHub，由 Cloudflare 自动构建上线。

如果你用的是官方原版主题，可以跳过本章，继续用第六节的本地改文件方式。

### 1. 后台在做什么

```text
浏览器打开 /admin
  → 登录
  → 写/改/删文章（先「暂存」，不立刻 push）
  → 点「发布全部」→ 写入 GitHub 仓库 src/content/posts/
  → Cloudflare 检测到 push → 自动构建 → 约 1～3 分钟后网站更新
```

文章仍然是仓库里的 `.md` 文件，不是另存一套数据库。

### 2. 部署时多配的密钥（运行时 Secrets）

在 Cloudflare 项目 → **Settings → Variables and Secrets**（运行时，**Encrypt 加密类型**）添加：

| 名称 | 说明 |
|---|---|
| `ADMIN_PASSWORD` | 后台登录密码（自己设一个强一点的） |
| `GH_TOKEN` | GitHub 令牌，用于后台往仓库写文件 |
| `GH_BRANCH` | 分支名，本站填 `master` |

**构建环境变量**里还要有（见第四节）：

| 名称 | 值 |
|---|---|
| `CF_WORKERS` | `1` |

没有 `CF_WORKERS=1`，后台接口不会进 Worker，打开 `/admin` 登录/发布会失败。

#### 如何申请 `GH_TOKEN`

1. GitHub → 头像 → **Settings** → **Developer settings**  
2. **Fine-grained personal access tokens** → 生成新令牌  
3. 仓库只勾选 **htx60280-lab/Firefly**（或你自己的博客仓库）  
4. 权限里 **Contents** 选 **Read and write**  
5. 生成后复制（只显示一次），粘贴到 Cloudflare 的 `GH_TOKEN`

密钥务必用 **Encrypt**，不要用明文变量（明文有时会在重新部署后被清掉）。

### 3. 日常使用步骤

1. 浏览器打开：https://volant.cc.cd/admin/  
   （你自己的域名则是 `https://你的域名/admin/`）  
2. 输入 `ADMIN_PASSWORD` 登录。  
3. **写文章**：点「写文章」→ 填标题、分类、标签、正文 → 点 **「暂存（不推送）」**。  
4. 可继续改其他文章、删除、批量改草稿等，都会先进入「待发布」列表。  
5. 确认无误后，点顶部 **「发布全部」** → 才会往 GitHub 提交（通常合并成 **1 次** commit）。  
6. 到 Cloudflare **Deployments** 看是否出现新构建；变绿后过一两分钟刷新网站即可看到新文章。

列表里常见标记：

- **待新增 / 待更新 / 待删除**：还在暂存，未发布  
- **草稿 / 置顶**：文章元数据  

分类、标签可手输，也可点选已有文章里出现过的分类/标签。

### 4. 后台使用注意

| 点 | 说明 |
|---|---|
| 暂存 ≠ 上线 | 只点暂存，网站不会变；必须「发布全部」 |
| 暂存在本机浏览器 | 换电脑或清站点数据，未发布的暂存可能丢失 |
| 编辑时改标题 | 不会改文件名（避免旧链接失效） |
| 图片 | 编辑器里上传图片会单独写进仓库，可能多一次 commit |
| 不要叠 Deploy Hook | 已开 Git 自动部署时，不必再配 Deploy Hook，否则可能一次发布触发两次构建 |

### 5. 后台相关排错

| 现象 | 处理 |
|---|---|
| 打开 `/admin` 没有登录框 / 接口 404 | 构建变量是否设了 `CF_WORKERS=1` 并已重新部署 |
| 登录提示未配置鉴权 | 是否配置了运行时 Secret：`ADMIN_PASSWORD` |
| 发布失败、GitHub 401 | `GH_TOKEN` 是否有效、是否勾选了本仓库、Contents 是否可写 |
| 发布成功但列表里看不到 | `GH_BRANCH` 是否为 `master`（与仓库默认分支一致） |
| 构建报 `published` 类型错误 | 日期要写成 `2026-07-18`，不要加引号（后台已按此生成） |

更细的开发说明见仓库内：`docs/admin-backend.md`。

## 八、常见问题（避坑）

| 现象 | 处理 |
|---|---|
| 本地 `pnpm dev` 打不开 | 看终端是否在跑、端口是否为 4321；依赖是否 `pnpm install` 成功 |
| 构建失败 | 打开 Cloudflare Deployments 看日志；常见是 Node 版本、依赖、或 frontmatter 写错 |
| push 了但网站没变 | 确认推的是构建所用分支（如 master）；看部署是否失败 |
| 首页域名/链接不对 | 检查 `siteConfig.ts` 的 `site_url` 是否已改并已 push |
| `published` 类型错误 | frontmatter 日期裸写，不要加引号 |
| 构建报 `NoAdapterInstalled` | 见第四节，构建环境加 `CF_WORKERS=1` 后重试 |

## 写在最后

部署核心三步：

1. 有自己的 GitHub 仓库（本站：[htx60280-lab/Firefly](https://github.com/htx60280-lab/Firefly)）  
2. 本地 `pnpm install` + `pnpm dev` 能预览  
3. Cloudflare 连上该仓库，构建命令用 `pnpm build`，push 即自动上线  

**写文章有两种方式：**

- **官方通用**：改 `src/content/posts/` 下 Markdown，再 `git push`  
- **本站扩展**：打开 https://volant.cc.cd/admin/ ，暂存后「发布全部」

- 本站仓库：https://github.com/htx60280-lab/Firefly  
- 本站地址：https://volant.cc.cd  
- 本站后台：https://volant.cc.cd/admin/  
- Firefly 官方源码：https://github.com/CuteLeaf/Firefly  
- Cloudflare 控制台：https://dash.cloudflare.com/
