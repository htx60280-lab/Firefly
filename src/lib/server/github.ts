/**
 * GitHub Contents API 封装 + CF Deploy Hook 触发
 *
 * 用途：把文章 .md / 图片二进制 写进站点仓库，再触发 Cloudflare 重建。
 * 鉴权用 PAT，权限 repo:contents（私有仓需 repo）。
 *
 * 仓库 owner/repo 默认从环境变量读，回退到内置默认值（本仓）。
 * 所有调用均带明确错误处理与可观测返回，便于端点透传给前端。
 */

const GH_API = "https://api.github.com";

/** 内置本仓默认（git remote 探测得到），env 缺失时回退 */
const DEFAULT_OWNER = "htx60280-lab";
const DEFAULT_REPO = "Firefly";

const POSTS_DIR = "src/content/posts";
const IMAGES_DIR = "src/content/posts/images";

export interface GhEnv {
	token: string;
	owner: string;
	repo: string;
	branch: string;
	/** CF Pages Deploy Hook URL，可选；不配则上传后不自动触发 */
	deployHook?: string;
}

export class GithubConfigError extends Error {}

/** 读取 GitHub 相关环境变量。异步以兼容 cloudflare:workers 与本地 process.env。 */
export async function readGhEnv(): Promise<GhEnv> {
	const { getRuntimeEnv } = await import("@/lib/server/env");
	const env = await getRuntimeEnv();
	const token = String(env.GH_TOKEN ?? "").trim();
	if (!token) throw new GithubConfigError("GH_TOKEN 未配置");
	const owner = String(env.GH_REPO_OWNER ?? "").trim() || DEFAULT_OWNER;
	const repo = String(env.GH_REPO_NAME ?? "").trim() || DEFAULT_REPO;
	// 本仓默认分支是 master；线上不设 GH_BRANCH 时回退 master 而非 main，
	// 避免后端去查空 main 分支导致所有文章都报「不存在」。
	const branch = String(env.GH_BRANCH ?? "").trim() || "master";
	const deployHook = String(env.CF_DEPLOY_HOOK ?? "").trim() || undefined;
	return { token, owner, repo, branch, deployHook };
}

async function ghFetch(
	env: GhEnv,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const url = path.startsWith("http") ? path : `${GH_API}${path}`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${env.token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "volant-admin",
	};
	if (init.body && !init.headers) {
		headers["Content-Type"] = "application/json";
	}
	const res = await fetch(url, {
		...init,
		headers: {
			...headers,
			...((init.headers as Record<string, string>) || {}),
		},
	});
	return res;
}

export interface GhFileMeta {
	name: string; // 文件名，含扩展
	path: string; // 仓库相对路径
	type: string; // "file" | "dir"
	sha?: string;
	size?: number;
}

/** 列出 posts 目录的 .md 文件（仅顶层，递归目录暂不展开） */
export async function listPosts(env: GhEnv): Promise<GhFileMeta[]> {
	const res = await ghFetch(
		env,
		`/repos/${env.owner}/${env.repo}/contents/${POSTS_DIR}?ref=${env.branch}`,
	);
	if (res.status === 404) return [];
	if (!res.ok)
		throw new GhApiError(`列出文章失败: ${res.status}`, await safeText(res));
	const data = (await res.json()) as Array<
		GhFileMeta & { download_url?: string }
	>;
	return data.filter((f) => f.type === "file" && /\.(md|mdx)$/.test(f.name));
}

/** 读取单篇文章原文（含 frontmatter） */
export async function readPost(
	env: GhEnv,
	name: string,
): Promise<{ content: string; sha: string } | null> {
	const safe = sanitizeName(name);
	const res = await ghFetch(
		env,
		`/repos/${env.owner}/${env.repo}/contents/${POSTS_DIR}/${encodeURIComponent(safe)}?ref=${env.branch}`,
	);
	if (res.status === 404) return null;
	if (!res.ok)
		throw new GhApiError(`读取文章失败: ${res.status}`, await safeText(res));
	const data = (await res.json()) as {
		content?: string;
		sha?: string;
		encoding?: string;
	};
	if (data.encoding === "base64" && typeof data.content === "string") {
		const raw = data.content.replace(/\s/g, "");
		const bin = atob(raw);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return { content: new TextDecoder().decode(bytes), sha: data.sha ?? "" };
	}
	return { content: data.content ?? "", sha: data.sha ?? "" };
}

export interface WriteResult {
	path: string;
	sha: string;
	commitSha: string;
	created: boolean;
}

/** 写入文章 .md。若已存在相同内容直接返回；否则更新（需提供旧 sha）或创建 */
export async function writePost(
	env: GhEnv,
	name: string,
	content: string,
	mode: "create" | "update",
	knownSha?: string,
	commitMsg?: string,
): Promise<WriteResult> {
	const safe = sanitizeName(name);
	const path = `${POSTS_DIR}/${safe}`;

	// 若是更新且没给 sha，先查一次取 sha（保证可覆盖）
	let effectiveMode = mode;
	let sha = knownSha;
	if (!sha) {
		const existing = await readPost(env, safe);
		if (existing) {
			sha = existing.sha;
			effectiveMode = "update";
		}
	}

	const body = {
		message:
			commitMsg ??
			`docs: ${effectiveMode === "create" ? "新增" : "更新"}文章 ${safe}`,
		content: base64Utf8(content),
		branch: env.branch,
		...(sha ? { sha } : {}),
	};

	const res = await ghFetch(
		env,
		`/repos/${env.owner}/${env.repo}/contents/${encodeURIComponent(path)}`,
		{
			method: "PUT",
			body: JSON.stringify(body),
		},
	);
	if (res.status === 409)
		throw new GhApiError(
			"文章已被改动，存在版本冲突",
			await safeText(res),
			409,
		);
	if (!res.ok)
		throw new GhApiError(`写入文章失败: ${res.status}`, await safeText(res));
	const data = (await res.json()) as {
		content?: { sha?: string };
		commit?: { sha?: string };
	};
	return {
		path,
		sha: data.content?.sha ?? "",
		commitSha: data.commit?.sha ?? "",
		created: effectiveMode === "create",
	};
}

/** 删除文章（需 sha） */
export async function deletePost(
	env: GhEnv,
	name: string,
	sha: string,
): Promise<void> {
	const safe = sanitizeName(name);
	const path = `${POSTS_DIR}/${safe}`;
	const res = await ghFetch(
		env,
		`/repos/${env.owner}/${env.repo}/contents/${encodeURIComponent(path)}`,
		{
			method: "DELETE",
			body: JSON.stringify({
				message: `docs: 删除文章 ${safe}`,
				sha,
				branch: env.branch,
			}),
		},
	);
	if (!res.ok)
		throw new GhApiError(`删除文章失败: ${res.status}`, await safeText(res));
}

/** 上传图片到 posts/images。返回仓库内可被文章引用的相对路径 */
export async function uploadImage(
	env: GhEnv,
	filename: string,
	base64Bytes: string,
	commitMsg?: string,
): Promise<{ path: string; sha: string }> {
	const safe = sanitizeImageName(filename);
	const path = `${IMAGES_DIR}/${safe}`;
	const res = await ghFetch(
		env,
		`/repos/${env.owner}/${env.repo}/contents/${encodeURIComponent(path)}`,
		{
			method: "PUT",
			body: JSON.stringify({
				message: commitMsg ?? `chore: 上传图片 ${safe}`,
				content: base64Bytes, // 二进制图片直接传 base64，不做 UTF-8 解码
				branch: env.branch,
			}),
		},
	);
	if (res.status === 422)
		throw new GhApiError("图片已存在或路径冲突", await safeText(res), 422);
	if (!res.ok)
		throw new GhApiError(`上传图片失败: ${res.status}`, await safeText(res));
	const data = (await res.json()) as { content?: { sha?: string } };
	return { path, sha: data.content?.sha ?? "" };
}

/**
 * 触发 Cloudflare Deploy Hook。
 *
 * 说明：CF worker 项目若已连 Git 自动部署，写仓 push 本身就触发一次构建，
 * 此时 CF_DEPLOY_HOOK 冗余（会与 Git webhook 叠加触发两次构建）。
 * 建议在该前提下不配 CF_DEPLOY_HOOK：本函数返回"依赖 Git 自动构建"，
 * 文章照常上线。仅当未连 Git 自动部署、或想强制立即重建时才配置它。
 *
 * 失败不阻断上传结果（文章已入仓，Git push 会兜底触发构建）。
 */
export async function triggerRedeploy(
	env: GhEnv,
): Promise<{ ok: boolean; detail: string }> {
	if (!env.deployHook)
		return { ok: true, detail: "已写入仓库，Git 自动部署将触发构建（约1-2分钟生效）" };
	try {
		const res = await fetch(env.deployHook, { method: "POST" });
		if (!res.ok) return { ok: false, detail: `Deploy Hook 返回 ${res.status}` };
		return { ok: true, detail: "已触发重建，约 1-2 分钟生效" };
	} catch (e) {
		return { ok: false, detail: `触发构建异常: ${(e as Error).message}` };
	}
}

export class GhApiError extends Error {
	status?: number;
	detail?: string;
	constructor(message: string, detail?: string, status?: number) {
		super(message);
		this.detail = detail;
		this.status = status;
	}
}

async function safeText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "<读取响应失败>";
	}
}

/** 仅允许 a-z0-9- 的 slug，防路径穿越。扩展限定 md/mdx */
export function sanitizeName(name: string): string {
	let n = name.trim().toLowerCase();
	n = n.replace(/\.md$|\.mdx$/i, "");
	n = n
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (!n) throw new GhApiError("文章 slug 为空或非法");
	return n + ".md";
}

/** 图片文件名：保留字母数字点横杠下划线，防穿越；同名追加时间戳 */
export function sanitizeImageName(filename: string): string {
	const lower = filename.trim().toLowerCase();
	const m = lower.match(/^[a-z0-9._-]+\.(avif|webp|png|jpg|jpeg|gif|svg)$/i);
	if (!m) throw new GhApiError("图片格式不允许");
	const dot = lower.lastIndexOf(".");
	const stem = lower.slice(0, dot).replace(/[^a-z0-9._-]/g, "-");
	const ext = lower.slice(dot);
	const stamp = Date.now().toString(36);
	// 16 字符防碰撞
	return `${stem.slice(0, 24)}-${stamp}${ext}`;
}

/** 字符串 → UTF-8 → base64（用 TextEncoder 处理中文，避免 btoa 报错） */
function base64Utf8(str: string): string {
	const bytes = enc.encode(str);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}
const enc = new TextEncoder();
