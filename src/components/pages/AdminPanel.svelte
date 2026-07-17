<script lang="ts">
import { onMount } from "svelte";

// ===================== 类型 =====================
interface PostListItem {
	name: string;
	path: string;
	size?: number;
}
interface Frontmatter {
	title: string;
	published: string;
	updated?: string;
	draft: boolean;
	description: string;
	image: string;
	tags: string[];
	category: string;
	lang: string;
	pinned: boolean;
	author: string;
	sourceLink: string;
	licenseName: string;
	licenseUrl: string;
	comment: boolean;
	password: string;
	passwordHint: string;
}
type Mode = "auto" | "create" | "update";

// ===================== 状态 =====================
let loggedIn = false;
let authChecking = true;
let password = "";
let loginError = "";
let loginLoading = false;

let view: "list" | "edit" = "list";
let posts: PostListItem[] = [];
let listLoading = false;
let listError = "";

let fm: Frontmatter = emptyFrontmatter();
let body = "";
let mode: Mode = "auto";
let editingName = ""; // 当前编辑的文章文件名（更新时用）
let editingSha = "";

let saving = false;
let saveMsg = "";
let saveOk = false;
let deployStatus = "";

let imgUploading = false;
let imgMsg = "";

let tagsInput = ""; // tag 输入框临时绑定

// Markdown 实时预览：CDN 加载 marked，零依赖
let markedFn: ((src: string) => string) | null = null;
let previewHtml = "";

// ===================== 工具 =====================
function emptyFrontmatter(): Frontmatter {
	return {
		title: "",
		published: today(),
		updated: "",
		draft: false,
		description: "",
		image: "",
		tags: [],
		category: "",
		lang: "",
		pinned: false,
		author: "",
		sourceLink: "",
		licenseName: "",
		licenseUrl: "",
		comment: true,
		password: "",
		passwordHint: "",
	};
}
function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function slugify(s: string): string {
	return s
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// trailingSlash: "always" 下，API 路径必须带尾斜杠，否则线上 301 重定向会让 POST body 丢失。
// 把 query string 之前的 path 段补上尾斜杠。
function withTrailingSlash(path: string): string {
	if (!path.startsWith("/api/")) return path;
	const q = path.indexOf("?");
	if (q < 0) return path.endsWith("/") ? path : `${path}/`;
	const base = path.slice(0, q);
	return `${base.endsWith("/") ? base : `${base}/`}${path.slice(q)}`;
}

async function api(path: string, init?: RequestInit) {
	const res = await fetch(withTrailingSlash(path), {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
		credentials: "same-origin",
	});
	return res;
}

// 兼容 Svelte 5 与 Svelte 4：使用 $: 派生 previewHtml
$: if (markedFn) {
	try {
		previewHtml = markedFn(body);
	} catch {
		previewHtml = "<p style='color:#c00'>预览渲染出错</p>";
	}
}

// ===================== 登录 =====================
async function checkAuth() {
	authChecking = true;
	try {
		const r = await api("/api/admin/login");
		loggedIn = r.status === 200;
	} catch {
		loggedIn = false;
	} finally {
		authChecking = false;
	}
}

async function doLogin() {
	loginLoading = true;
	loginError = "";
	try {
		const r = await api("/api/admin/login", {
			method: "POST",
			body: JSON.stringify({ password }),
		});
		if (r.ok) {
			loggedIn = true;
			password = "";
			await listPosts();
		} else if (r.status === 429) {
			const data = await r.json().catch(() => ({}));
			loginError = data.error || "尝试过于频繁，请稍后再来";
		} else {
			const data = await r.json().catch(() => ({}));
			loginError = data.error || `登录失败 (${r.status})`;
		}
	} catch (e) {
		loginError = `网络错误: ${(e as Error).message}`;
	} finally {
		loginLoading = false;
	}
}

async function logout() {
	try {
		await api("/api/admin/logout", { method: "POST", body: "{}" });
	} catch {
		// 忽略：即便后端调用失败也前端置退出
	}
	loggedIn = false;
	view = "list";
	posts = [];
}

// ===================== 文章列表 =====================
async function listPosts() {
	listLoading = true;
	listError = "";
	try {
		const r = await api("/api/admin/posts");
		if (!r.ok)
			throw new Error(
				(await r.json().catch(() => ({}))).error || `列出失败 (${r.status})`,
			);
		const data = await r.json();
		posts = data.posts || [];
	} catch (e) {
		listError = (e as Error).message;
	} finally {
		listLoading = false;
	}
}

function newPost() {
	editingName = "";
	editingSha = "";
	fm = emptyFrontmatter();
	body = "";
	mode = "auto";
	tagsInput = "";
	saveMsg = "";
	deployStatus = "";
	view = "edit";
}

async function editPost(name: string) {
	listLoading = true;
	try {
		const r = await api(`/api/admin/post?name=${encodeURIComponent(name)}`);
		if (r.status === 404) {
			listError = `文章 ${name} 不存在`;
			return;
		}
		if (!r.ok)
			throw new Error(
				(await r.json().catch(() => ({}))).error || `读取失败 (${r.status})`,
			);
		const data = await r.json();
		editingName = name;
		editingSha = data.sha || "";
		// 用后端解析好的 frontmatter 回填，未提供的字段用默认
		const f = data.frontmatter || {};
		fm = {
			...emptyFrontmatter(),
			title: str(f.title, ""),
			published: str(f.published, today()),
			updated: str(f.updated, ""),
			draft: bool(f.draft, false),
			description: str(f.description, ""),
			image: str(f.image, ""),
			tags: arr(f.tags),
			category: str(f.category, ""),
			lang: str(f.lang, ""),
			pinned: bool(f.pinned, false),
			author: str(f.author, ""),
			sourceLink: str(f.sourceLink, ""),
			licenseName: str(f.licenseName, ""),
			licenseUrl: str(f.licenseUrl, ""),
			comment: bool(f.comment, true),
			password: str(f.password, ""),
			passwordHint: str(f.passwordHint, ""),
		};
		body = typeof data.body === "string" ? data.body : "";
		tagsInput = fm.tags.join(", ");
		mode = "update";
		view = "edit";
		saveMsg = "";
		deployStatus = "";
	} catch (e) {
		listError = (e as Error).message;
	} finally {
		listLoading = false;
	}
}

async function deletePost(name: string, sha: string) {
	if (!confirm(`确定删除《${name}》？删除后立即提交到仓库并触发重建。`)) return;
	listLoading = true;
	try {
		const r = await api(
			`/api/admin/post?name=${encodeURIComponent(name)}&sha=${encodeURIComponent(sha)}`,
			{ method: "DELETE" },
		);
		if (!r.ok)
			throw new Error(
				(await r.json().catch(() => ({}))).error || `删除失败 (${r.status})`,
			);
		await listPosts();
	} catch (e) {
		listError = (e as Error).message;
	} finally {
		listLoading = false;
	}
}

// ===================== 保存 =====================
$: tagsFromInput = tagsInput
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

function buildPayload() {
	return {
		slug: slugify(fm.title) || slugify(editingName),
		title: fm.title,
		published: fm.published,
		updated: fm.updated || undefined,
		draft: fm.draft,
		description: fm.description,
		image: fm.image,
		tags: tagsFromInput,
		category: fm.category,
		lang: fm.lang,
		pinned: fm.pinned,
		author: fm.author,
		sourceLink: fm.sourceLink,
		licenseName: fm.licenseName,
		licenseUrl: fm.licenseUrl,
		comment: fm.comment,
		password: fm.password,
		passwordHint: fm.passwordHint,
		body,
		mode,
	};
}

async function save() {
	if (!fm.title.trim()) {
		saveMsg = "请填写标题";
		saveOk = false;
		return;
	}
	if (!body.trim()) {
		saveMsg = "正文不能为空";
		saveOk = false;
		return;
	}
	saving = true;
	saveMsg = "保存中...";
	deployStatus = "";
	try {
		const r = await api("/api/admin/upload", {
			method: "POST",
			body: JSON.stringify(buildPayload()),
		});
		const data = await r.json().catch(() => ({}));
		if (r.ok) {
			saveOk = true;
			saveMsg = `已${data.mode === "create" ? "新增" : "更新"}：${data.filename}`;
			editingName = data.filename?.split("/").pop() || editingName;
			mode = "update";
			// 读取新 sha 以便再次保存
			deployStatus = data.redeploy?.ok
				? `✅ ${data.redeploy.detail}`
				: `⚠️ ${data.redeploy?.detail || "未触发重建"}`;
			await listPosts();
		} else if (r.status === 401) {
			loggedIn = false;
			saveMsg = "会话过期，请重新登录";
			saveOk = false;
		} else {
			saveOk = false;
			saveMsg = `保存失败：${data.error || r.status}${data.detail ? "（" + data.detail + "）" : ""}`;
		}
	} catch (e) {
		saveOk = false;
		saveMsg = `网络错误: ${(e as Error).message}`;
	} finally {
		saving = false;
	}
}

// ===================== 图片上传 =====================
async function uploadImageFile(file: File) {
	if (!file.type.startsWith("image/")) return;
	imgUploading = true;
	imgMsg = "上传中...";
	try {
		const fd = new FormData();
		fd.append("file", file);
		const r = await fetch(withTrailingSlash("/api/admin/upload-image"), {
			method: "POST",
			body: fd,
			credentials: "same-origin",
		});
		const data = await r.json().catch(() => ({}));
		if (r.ok) {
			imgMsg = `已上传：${data.ref}`;
			// 插入到正文光标处（简单追加）
			const insert = `![图片描述](${data.ref})\n\n`;
			body = body + (body.endsWith("\n") ? "" : "\n") + insert;
		} else if (r.status === 401) {
			loggedIn = false;
			imgMsg = "会话过期，请重新登录";
		} else {
			imgMsg = `上传失败：${data.error || r.status}`;
		}
	} catch (e) {
		imgMsg = `网络错误: ${(e as Error).message}`;
	} finally {
		imgUploading = false;
	}
}

function onPaste(e: ClipboardEvent) {
	const items = e.clipboardData?.items;
	if (!items) return;
	for (const it of items) {
		if (it.kind === "file" && it.type.startsWith("image/")) {
			const f = it.getAsFile();
			if (f) {
				e.preventDefault();
				uploadImageFile(f);
			}
		}
	}
}
function onDrop(e: DragEvent) {
	if (!e.dataTransfer) return;
	const files = Array.from(e.dataTransfer.files).filter((f) =>
		f.type.startsWith("image/"),
	);
	if (files.length === 0) return;
	e.preventDefault();
	for (const f of files) uploadImageFile(f);
}
function onFilePick(e: Event) {
	const input = e.target as HTMLInputElement;
	if (!input.files) return;
	for (const f of Array.from(input.files)) uploadImageFile(f);
	input.value = "";
}

// ===================== marked 加载 =====================
async function loadMarked() {
	if (markedFn) return;
	try {
		// @ts-expect-error CDN 动态导入
		const mod = await import("https://esm.sh/marked@12");
		markedFn = (mod.marked || mod.default).parse.bind(
			mod.marked || mod.default,
		);
	} catch {
		markedFn = (s: string) => `<pre>${escapeHtml(s)}</pre>`;
	}
}
function escapeHtml(s: string): string {
	return s.replace(/[&<>]/g, (c) => ({ "&": "&", "<": "<", ">": ">" })[c] || c);
}

// 类型转换辅助
function str(v: unknown, d: string): string {
	return typeof v === "string" ? v : v == null ? d : String(v);
}
function bool(v: unknown, d: boolean): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v === "true";
	return d;
}
function arr(v: unknown): string[] {
	return Array.isArray(v) ? v.map(String) : [];
}

// ===================== 初始化 =====================
onMount(async () => {
	await checkAuth();
	if (loggedIn) {
		await listPosts();
		loadMarked();
	}
});
$: if (view === "edit") loadMarked();

// 退出编辑回到列表
function backToList() {
	view = "list";
	saveMsg = "";
	deployStatus = "";
}
</script>

<div class="admin-panel max-w-6xl mx-auto">
    {#if authChecking}
        <div class="card-base p-8 text-center text-(--content-meta)">检查登录状态...</div>
    {:else if !loggedIn}
        <!-- ============ 登录 ============ -->
        <div class="card-base p-6 max-w-md mx-auto mt-12">
            <h2 class="text-xl font-bold mb-4 text-(--btn-content)">管理后台登录</h2>
            <form on:submit|preventDefault={doLogin} class="flex flex-col gap-3">
                <input type="password" bind:value={password} placeholder="密码" class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                {#if loginError}<div class="text-sm text-red-500">{loginError}</div>{/if}
                <button type="submit" disabled={loginLoading} class="px-4 py-2 rounded-lg bg-(--primary) text-white font-semibold disabled:opacity-60">
                    {loginLoading ? "登录中..." : "登录"}
                </button>
            </form>
        </div>
    {:else if view === "list"}
        <!-- ============ 文章列表 ============ -->
        <div class="flex items-center justify-between mb-4">
            <h2 class="text-2xl font-bold text-(--btn-content)">文章管理</h2>
            <div class="flex gap-2">
                <button on:click={listPosts} disabled={listLoading} class="px-3 py-1.5 rounded-lg bg-(--btn-regular-bg) text-(--btn-content) text-sm disabled:opacity-60">刷新</button>
                <button on:click={newPost} class="px-3 py-1.5 rounded-lg bg-(--primary) text-white text-sm font-semibold">写文章</button>
                <button on:click={logout} class="px-3 py-1.5 rounded-lg bg-(--btn-regular-bg) text-(--btn-content) text-sm">退出</button>
            </div>
        </div>
        {#if listLoading && posts.length === 0}
            <div class="card-base p-6 text-center text-(--content-meta)">加载中...</div>
        {:else if listError}
            <div class="card-base p-6 text-red-500">{listError}</div>
        {:else if posts.length === 0}
            <div class="card-base p-6 text-center text-(--content-meta)">还没有文章，点「写文章」开始第一篇。</div>
        {:else}
            <div class="flex flex-col gap-2">
                {#each posts as p}
                    <div class="card-base p-4 flex items-center justify-between gap-4">
                        <button on:click={() => editPost(p.name)} class="flex-1 text-left text-(--btn-content) font-medium hover:text-(--primary)">
                            {p.name}
                        </button>
                        <span class="text-xs text-(--content-meta)">{p.size ? `${(p.size/1024).toFixed(1)}KB` : ""}</span>
                        <button on:click={() => editPost(p.name)} class="text-sm px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)">编辑</button>
                    </div>
                {/each}
            </div>
        {/if}
    {:else}
        <!-- ============ 编辑器 ============ -->
        <div class="flex items-center justify-between mb-4">
            <button on:click={backToList} class="text-sm text-(--content-meta) hover:text-(--primary)">← 返回列表</button>
            <div class="flex gap-2">
                <button on:click={save} disabled={saving} class="px-4 py-1.5 rounded-lg bg-(--primary) text-white text-sm font-semibold disabled:opacity-60">
                    {saving ? "保存中..." : "保存并触发构建"}
                </button>
            </div>
        </div>

        {#if saveMsg}
            <div class="card-base p-3 mb-3 text-sm {saveOk ? 'text-green-600' : 'text-red-500'}">{saveMsg}</div>
        {/if}
        {#if deployStatus}
            <div class="card-base p-3 mb-3 text-sm text-(--content-meta)">{deployStatus}</div>
        {/if}

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <!-- 左：编辑 -->
            <div class="flex flex-col gap-3">
                <!-- frontmatter 表单 -->
                <div class="card-base p-4 flex flex-col gap-3">
                    <div>
                        <label class="block text-sm text-(--content-meta) mb-1">标题 *</label>
                        <input bind:value={fm.title} class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <div>
                            <label class="block text-sm text-(--content-meta) mb-1">发布日期</label>
                            <input type="date" bind:value={fm.published} class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                        </div>
                        <div>
                            <label class="block text-sm text-(--content-meta) mb-1">更新日期</label>
                            <input type="date" bind:value={fm.updated} class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                        </div>
                    </div>
                    <div>
                        <label class="block text-sm text-(--content-meta) mb-1">分类</label>
                        <input bind:value={fm.category} class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                    </div>
                    <div>
                        <label class="block text-sm text-(--content-meta) mb-1">标签（逗号分隔）</label>
                        <input bind:value={tagsInput} placeholder="技术, 笔记" class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                    </div>
                    <div>
                        <label class="block text-sm text-(--content-meta) mb-1">摘要 description</label>
                        <textarea bind:value={fm.description} rows="2" class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"></textarea>
                    </div>
                    <div>
                        <label class="block text-sm text-(--content-meta) mb-1">封面 image</label>
                        <input bind:value={fm.image} placeholder="assets/images/xxx.avif" class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                    </div>
                    <div class="flex flex-wrap gap-4 text-sm text-(--btn-content)">
                        <label class="flex items-center gap-2"><input type="checkbox" bind:checked={fm.draft} /> 草稿</label>
                        <label class="flex items-center gap-2"><input type="checkbox" bind:checked={fm.pinned} /> 置顶</label>
                        <label class="flex items-center gap-2"><input type="checkbox" bind:checked={fm.comment} /> 允许评论</label>
                    </div>
                    <details class="text-sm">
                        <summary class="cursor-pointer text-(--content-meta)">高级（作者 / 外链 / 许可 / 加密）</summary>
                        <div class="flex flex-col gap-3 mt-2">
                            <input bind:value={fm.author} placeholder="作者" class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                            <input bind:value={fm.sourceLink} placeholder="原文链接 sourceLink" class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                            <div class="grid grid-cols-2 gap-2">
                                <input bind:value={fm.licenseName} placeholder="许可证名" class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                                <input bind:value={fm.licenseUrl} placeholder="许可证 URL" class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                            </div>
                            <input type="password" bind:value={fm.password} placeholder="加密密码（留空则公开）" class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                            <input bind:value={fm.passwordHint} placeholder="密码提示" class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)" />
                        </div>
                    </details>
                </div>

                <!-- 正文编辑 -->
                <div class="card-base p-4 flex flex-col gap-2" role="region" aria-label="正文编辑器">
                    <div class="flex items-center justify-between">
                        <label class="text-sm text-(--content-meta)">正文（支持粘贴/拖拽图片自动上传）</label>
                        <div class="flex items-center gap-2">
                            <label class="text-sm px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) cursor-pointer">
                                选择图片
                                <input type="file" accept="image/*" multiple class="hidden" on:change={onFilePick} />
                            </label>
                            {#if imgUploading}<span class="text-xs text-(--content-meta)">{imgMsg}</span>{/if}
                        </div>
                    </div>
                    <textarea
                        bind:value={body}
                        on:paste={onPaste}
                        on:drop={onDrop}
                        on:dragover|preventDefault
                        rows="22"
                        class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content) font-mono text-sm"
                        placeholder="在此输入 Markdown 正文..."
                    ></textarea>
                    {#if imgMsg && !imgUploading}<div class="text-xs text-(--content-meta)">{imgMsg}</div>{/if}
                </div>
            </div>

            <!-- 右：实时预览 -->
            <div class="card-base p-4 min-h-[400px] lg:max-h-[calc(100vh-200px)] overflow-auto">
                <div class="text-sm text-(--content-meta) mb-2">实时预览</div>
                <div class="prose max-w-none text-(--btn-content)">
                    {@html previewHtml}
                </div>
            </div>
        </div>
    {/if}
</div>

<style>
.admin-panel { padding-bottom: 4rem; }
.hidden { display: none; }
</style>
