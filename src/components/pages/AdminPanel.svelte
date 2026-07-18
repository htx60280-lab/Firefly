<script lang="ts">
import { onMount } from "svelte";

// ===================== 类型 =====================
interface PostListItem {
	name: string;
	path: string;
	size?: number;
	sha: string;
	title: string;
	published: string;
	category: string;
	tags: string[];
	draft: boolean;
	pinned: boolean;
	description: string;
}
interface Frontmatter {
	title: string;
	published: string;
	updated: string;
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
type BatchAction =
	| "delete"
	| "setDraft"
	| "setPinned"
	| "setCategory"
	| "addTag"
	| "removeTag";

// ===================== 状态 =====================
let loggedIn = false;
let authChecking = true;
let password = "";
let loginError = "";
let loginLoading = false;

let view: "list" | "edit" = "list";
let posts: PostListItem[] = [];
let knownCategories: string[] = [];
let knownTags: string[] = [];
let listLoading = false;
let listError = "";
let listFilter = "";
let selected = new Set<string>();
let batchBusy = false;
let batchMsg = "";
let batchCategoryInput = "";
let batchTagInput = "";

let fm: Frontmatter = emptyFrontmatter();
let body = "";
let mode: Mode = "auto";
let editingName = "";
let editingSha = "";
let slugInput = ""; // 新建时可编辑；编辑时锁定显示

let saving = false;
let saveMsg = "";
let saveOk = false;
let deployStatus = "";

let imgUploading = false;
let imgMsg = "";

let tagsInput = "";
let newTagDraft = "";
let bodyEl: HTMLTextAreaElement | null = null;

let markedFn: ((src: string) => string) | null = null;
let previewHtml = "";
let showPreview = true;

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
/** 标题 → slug 候选（纯中文会空，后端会用 post-时间戳兜底） */
function slugify(s: string): string {
	return s
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/[^a-z0-9-]/g, "")
		.slice(0, 60);
}
function withTrailingSlash(path: string): string {
	if (!path.startsWith("/api/")) return path;
	const q = path.indexOf("?");
	if (q < 0) return path.endsWith("/") ? path : `${path}/`;
	const base = path.slice(0, q);
	return `${base.endsWith("/") ? base : `${base}/`}${path.slice(q)}`;
}
async function api(path: string, init?: RequestInit) {
	return fetch(withTrailingSlash(path), {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
		credentials: "same-origin",
	});
}

$: if (markedFn) {
	try {
		previewHtml = markedFn(body);
	} catch {
		previewHtml = "<p style='color:#c00'>预览渲染出错</p>";
	}
}

// 列表过滤
$: filteredPosts = posts.filter((p) => {
	if (!listFilter.trim()) return true;
	const q = listFilter.trim().toLowerCase();
	return (
		p.name.toLowerCase().includes(q) ||
		p.title.toLowerCase().includes(q) ||
		p.category.toLowerCase().includes(q) ||
		p.tags.some((t) => t.toLowerCase().includes(q))
	);
});

$: allSelected =
	filteredPosts.length > 0 && filteredPosts.every((p) => selected.has(p.name));

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
		/* ignore */
	}
	loggedIn = false;
	view = "list";
	posts = [];
	selected = new Set();
}

// ===================== 列表 =====================
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
		knownCategories = data.categories || [];
		knownTags = data.tags || [];
		// 清理已不存在的选中
		const names = new Set(posts.map((p) => p.name));
		selected = new Set([...selected].filter((n) => names.has(n)));
	} catch (e) {
		listError = (e as Error).message;
	} finally {
		listLoading = false;
	}
}

function toggleSelect(name: string) {
	const next = new Set(selected);
	if (next.has(name)) next.delete(name);
	else next.add(name);
	selected = next;
}
function toggleSelectAll() {
	if (allSelected) {
		const next = new Set(selected);
		for (const p of filteredPosts) next.delete(p.name);
		selected = next;
	} else {
		const next = new Set(selected);
		for (const p of filteredPosts) next.add(p.name);
		selected = next;
	}
}

async function runBatch(
	action: BatchAction,
	extra: { value?: boolean; text?: string } = {},
) {
	const names = [...selected];
	if (names.length === 0) {
		batchMsg = "请先勾选文章";
		return;
	}
	const label: Record<BatchAction, string> = {
		delete: "删除",
		setDraft: extra.value ? "设为草稿" : "取消草稿",
		setPinned: extra.value ? "置顶" : "取消置顶",
		setCategory: "改分类",
		addTag: "加标签",
		removeTag: "删标签",
	};
	if (
		!confirm(
			`确定对 ${names.length} 篇文章执行「${label[action]}」？\n${names.join("\n")}`,
		)
	)
		return;

	batchBusy = true;
	batchMsg = "处理中...";
	try {
		const r = await api("/api/admin/batch", {
			method: "POST",
			body: JSON.stringify({ action, names, ...extra }),
		});
		const data = await r.json().catch(() => ({}));
		if (r.status === 401) {
			loggedIn = false;
			batchMsg = "会话过期，请重新登录";
			return;
		}
		if (!r.ok) {
			batchMsg = data.error || `失败 ${r.status}`;
			return;
		}
		const fail = (data.results || []).filter((x: { ok: boolean }) => !x.ok);
		batchMsg =
			fail.length === 0
				? `✅ 成功 ${data.okCount}/${data.total}；${data.redeploy?.detail || ""}`
				: `完成 ${data.okCount}/${data.total}，失败 ${fail.length}：${fail.map((f: { name: string; error?: string }) => f.name + (f.error ? `(${f.error})` : "")).join("、")}`;
		selected = new Set();
		await listPosts();
	} catch (e) {
		batchMsg = `网络错误: ${(e as Error).message}`;
	} finally {
		batchBusy = false;
	}
}

async function deleteOne(p: PostListItem) {
	if (!confirm(`确定删除《${p.title || p.name}》？不可恢复。`)) return;
	listLoading = true;
	try {
		const r = await api(
			`/api/admin/post?name=${encodeURIComponent(p.name)}&sha=${encodeURIComponent(p.sha)}`,
			{ method: "DELETE" },
		);
		const data = await r.json().catch(() => ({}));
		if (r.status === 401) {
			loggedIn = false;
			return;
		}
		if (!r.ok) throw new Error(data.error || `删除失败 ${r.status}`);
		await listPosts();
	} catch (e) {
		listError = (e as Error).message;
	} finally {
		listLoading = false;
	}
}

// ===================== 编辑 =====================
function newPost() {
	editingName = "";
	editingSha = "";
	fm = emptyFrontmatter();
	body = "";
	mode = "auto";
	slugInput = "";
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
		slugInput = name.replace(/\.md$/i, "");
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

function backToList() {
	view = "list";
	saveMsg = "";
	deployStatus = "";
}

// 标题变化时，新建态自动同步 slug 候选
function onTitleInput() {
	if (mode !== "update") {
		const s = slugify(fm.title);
		// 用户没手改过 slug 时同步
		if (!slugInput || slugInput === slugify(slugInput)) {
			slugInput = s;
		}
	}
}

function pickCategory(c: string) {
	fm.category = c;
}
function pickTag(t: string) {
	const set = new Set(
		tagsInput
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	if (set.has(t)) set.delete(t);
	else set.add(t);
	tagsInput = [...set].join(", ");
	fm.tags = [...set];
}
function addNewTag() {
	const t = newTagDraft.trim();
	if (!t) return;
	pickTag(t);
	newTagDraft = "";
	if (!knownTags.includes(t))
		knownTags = [...knownTags, t].sort((a, b) => a.localeCompare(b, "zh"));
}

$: tagsFromInput = tagsInput
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

function buildPayload() {
	const slug =
		mode === "update" && editingName
			? editingName.replace(/\.md$/i, "")
			: (slugInput || slugify(fm.title) || `post-${Date.now().toString(36)}`)
					.toLowerCase()
					.replace(/[^a-z0-9-]/g, "-")
					.replace(/-+/g, "-")
					.replace(/^-|-$/g, "");
	return {
		slug,
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
			slugInput = editingName.replace(/\.md$/i, "");
			mode = "update";
			deployStatus = data.redeploy?.ok
				? `✅ ${data.redeploy.detail}`
				: `⚠️ ${data.redeploy?.detail || "未触发重建"}`;
			// 把当前分类/标签并入已知列表
			if (fm.category && !knownCategories.includes(fm.category)) {
				knownCategories = [...knownCategories, fm.category].sort((a, b) =>
					a.localeCompare(b, "zh"),
				);
			}
			for (const t of tagsFromInput) {
				if (!knownTags.includes(t))
					knownTags = [...knownTags, t].sort((a, b) =>
						a.localeCompare(b, "zh"),
					);
			}
			await listPosts();
		} else if (r.status === 401) {
			loggedIn = false;
			saveMsg = "会话过期，请重新登录";
			saveOk = false;
		} else {
			saveOk = false;
			saveMsg = `保存失败：${data.error || r.status}${data.detail ? `（${data.detail}）` : ""}`;
		}
	} catch (e) {
		saveOk = false;
		saveMsg = `网络错误: ${(e as Error).message}`;
	} finally {
		saving = false;
	}
}

// ===================== 图片 / Markdown 工具栏 =====================
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
			insertAtCursor(`![图片描述](${data.ref})\n\n`);
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
function insertAtCursor(text: string) {
	const el = bodyEl;
	if (!el) {
		body = body + (body.endsWith("\n") ? "" : "\n") + text;
		return;
	}
	const start = el.selectionStart ?? body.length;
	const end = el.selectionEnd ?? body.length;
	body = body.slice(0, start) + text + body.slice(end);
	// 恢复光标
	requestAnimationFrame(() => {
		el.focus();
		const pos = start + text.length;
		el.setSelectionRange(pos, pos);
	});
}
function wrapSelection(before: string, after: string, placeholder = "文本") {
	const el = bodyEl;
	if (!el) {
		insertAtCursor(before + placeholder + after);
		return;
	}
	const start = el.selectionStart ?? 0;
	const end = el.selectionEnd ?? 0;
	const selected = body.slice(start, end) || placeholder;
	const text = before + selected + after;
	body = body.slice(0, start) + text + body.slice(end);
	requestAnimationFrame(() => {
		el.focus();
		el.setSelectionRange(
			start + before.length,
			start + before.length + selected.length,
		);
	});
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

async function loadMarked() {
	if (markedFn) return;
	try {
		// @ts-expect-error CDN
		const mod = await import("https://esm.sh/marked@12");
		markedFn = (mod.marked || mod.default).parse.bind(
			mod.marked || mod.default,
		);
	} catch {
		markedFn = (s: string) => `<pre>${escapeHtml(s)}</pre>`;
	}
}
function escapeHtml(s: string): string {
	return s.replace(
		/[&<>]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] || c,
	);
}
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

onMount(async () => {
	await checkAuth();
	if (loggedIn) {
		await listPosts();
		loadMarked();
	}
});
$: if (view === "edit") loadMarked();
</script>

<div class="admin-panel max-w-6xl mx-auto pb-16">
	{#if authChecking}
		<div class="card-base p-8 text-center text-(--content-meta)">检查登录状态...</div>
	{:else if !loggedIn}
		<div class="card-base p-6 max-w-md mx-auto mt-12">
			<h2 class="text-xl font-bold mb-4 text-(--btn-content)">管理后台登录</h2>
			<form on:submit|preventDefault={doLogin} class="flex flex-col gap-3">
				<input
					type="password"
					bind:value={password}
					placeholder="密码"
					class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
				/>
				{#if loginError}<div class="text-sm text-red-500">{loginError}</div>{/if}
				<button
					type="submit"
					disabled={loginLoading}
					class="px-4 py-2 rounded-lg bg-(--primary) text-white font-semibold disabled:opacity-60"
				>
					{loginLoading ? "登录中..." : "登录"}
				</button>
			</form>
		</div>
	{:else if view === "list"}
		<!-- ============ 列表 ============ -->
		<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
			<h2 class="text-2xl font-bold text-(--btn-content)">文章管理</h2>
			<div class="flex flex-wrap gap-2">
				<button
					on:click={listPosts}
					disabled={listLoading}
					class="px-3 py-1.5 rounded-lg bg-(--btn-regular-bg) text-(--btn-content) text-sm disabled:opacity-60"
					>刷新</button
				>
				<button
					on:click={newPost}
					class="px-3 py-1.5 rounded-lg bg-(--primary) text-white text-sm font-semibold"
					>写文章</button
				>
				<button
					on:click={logout}
					class="px-3 py-1.5 rounded-lg bg-(--btn-regular-bg) text-(--btn-content) text-sm"
					>退出</button
				>
			</div>
		</div>

		<!-- 搜索 + 批量操作 -->
		<div class="card-base p-3 mb-3 flex flex-col gap-3">
			<input
				bind:value={listFilter}
				placeholder="搜索标题 / 文件名 / 分类 / 标签..."
				class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content) text-sm"
			/>
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<label class="flex items-center gap-1.5 text-(--btn-content) cursor-pointer">
					<input type="checkbox" checked={allSelected} on:change={toggleSelectAll} />
					全选当前
				</label>
				<span class="text-(--content-meta)">已选 {selected.size}</span>
				<button
					disabled={batchBusy || selected.size === 0}
					on:click={() => runBatch("setDraft", { value: true })}
					class="px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) disabled:opacity-50"
					>设草稿</button
				>
				<button
					disabled={batchBusy || selected.size === 0}
					on:click={() => runBatch("setDraft", { value: false })}
					class="px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) disabled:opacity-50"
					>取消草稿</button
				>
				<button
					disabled={batchBusy || selected.size === 0}
					on:click={() => runBatch("setPinned", { value: true })}
					class="px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) disabled:opacity-50"
					>置顶</button
				>
				<button
					disabled={batchBusy || selected.size === 0}
					on:click={() => runBatch("setPinned", { value: false })}
					class="px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) disabled:opacity-50"
					>取消置顶</button
				>
				<button
					disabled={batchBusy || selected.size === 0}
					on:click={() => runBatch("delete")}
					class="px-2 py-1 rounded bg-red-500/15 text-red-600 disabled:opacity-50"
					>批量删除</button
				>
			</div>
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<input
					bind:value={batchCategoryInput}
					list="cat-list"
					placeholder="批量改分类…"
					class="px-2 py-1 rounded border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content) min-w-[8rem]"
				/>
				<button
					disabled={batchBusy || selected.size === 0 || !batchCategoryInput.trim()}
					on:click={() =>
						runBatch("setCategory", { text: batchCategoryInput.trim() })}
					class="px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) disabled:opacity-50"
					>应用到选中</button
				>
				<input
					bind:value={batchTagInput}
					list="tag-list"
					placeholder="批量加标签…"
					class="px-2 py-1 rounded border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content) min-w-[8rem]"
				/>
				<button
					disabled={batchBusy || selected.size === 0 || !batchTagInput.trim()}
					on:click={() => runBatch("addTag", { text: batchTagInput.trim() })}
					class="px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) disabled:opacity-50"
					>加标签</button
				>
				<button
					disabled={batchBusy || selected.size === 0 || !batchTagInput.trim()}
					on:click={() => runBatch("removeTag", { text: batchTagInput.trim() })}
					class="px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) disabled:opacity-50"
					>删标签</button
				>
			</div>
			{#if batchMsg}
				<div class="text-sm text-(--content-meta)">{batchMsg}</div>
			{/if}
		</div>

		{#if listLoading && posts.length === 0}
			<div class="card-base p-6 text-center text-(--content-meta)">加载中...</div>
		{:else if listError}
			<div class="card-base p-6 text-red-500">{listError}</div>
		{:else if filteredPosts.length === 0}
			<div class="card-base p-6 text-center text-(--content-meta)">
				{posts.length === 0 ? "还没有文章，点「写文章」开始第一篇。" : "没有匹配的文章。"}
			</div>
		{:else}
			<div class="flex flex-col gap-2">
				{#each filteredPosts as p (p.name)}
					<div class="card-base p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3">
						<label class="flex items-start gap-3 flex-1 min-w-0 cursor-pointer">
							<input
								type="checkbox"
								checked={selected.has(p.name)}
								on:change={() => toggleSelect(p.name)}
								class="mt-1"
							/>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<span class="font-medium text-(--btn-content) truncate"
										>{p.title || p.name}</span
									>
									{#if p.draft}
										<span class="text-xs px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400"
											>草稿</span
										>
									{/if}
									{#if p.pinned}
										<span class="text-xs px-1.5 py-0.5 rounded bg-(--primary)/15 text-(--primary)"
											>置顶</span
										>
									{/if}
								</div>
								<div class="text-xs text-(--content-meta) mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
									<span>{p.name}</span>
									{#if p.published}<span>· {p.published}</span>{/if}
									{#if p.category}<span>· {p.category}</span>{/if}
									{#if p.tags?.length}
										<span>· {p.tags.join(", ")}</span>
									{/if}
									{#if p.size}<span>· {(p.size / 1024).toFixed(1)}KB</span>{/if}
								</div>
							</div>
						</label>
						<div class="flex gap-2 shrink-0 sm:ml-2">
							<button
								on:click={() => editPost(p.name)}
								class="text-sm px-3 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
								>编辑</button
							>
							<button
								on:click={() => deleteOne(p)}
								class="text-sm px-3 py-1 rounded bg-red-500/15 text-red-600"
								>删除</button
							>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	{:else}
		<!-- ============ 编辑器 ============ -->
		<div class="flex flex-wrap items-center justify-between gap-2 mb-4">
			<button
				on:click={backToList}
				class="text-sm text-(--content-meta) hover:text-(--primary)">← 返回列表</button
			>
			<div class="flex gap-2">
				<button
					on:click={() => (showPreview = !showPreview)}
					class="px-3 py-1.5 rounded-lg bg-(--btn-regular-bg) text-(--btn-content) text-sm"
					>{showPreview ? "隐藏预览" : "显示预览"}</button
				>
				<button
					on:click={save}
					disabled={saving}
					class="px-4 py-1.5 rounded-lg bg-(--primary) text-white text-sm font-semibold disabled:opacity-60"
				>
					{saving ? "保存中..." : "保存并触发构建"}
				</button>
			</div>
		</div>

		{#if saveMsg}
			<div class="card-base p-3 mb-3 text-sm {saveOk ? 'text-green-600' : 'text-red-500'}">
				{saveMsg}
			</div>
		{/if}
		{#if deployStatus}
			<div class="card-base p-3 mb-3 text-sm text-(--content-meta)">{deployStatus}</div>
		{/if}

		<div class="grid grid-cols-1 {showPreview ? 'lg:grid-cols-2' : ''} gap-4">
			<div class="flex flex-col gap-3">
				<div class="card-base p-4 flex flex-col gap-3">
					<div>
						<label class="block text-sm text-(--content-meta) mb-1">标题 *</label>
						<input
							bind:value={fm.title}
							on:input={onTitleInput}
							class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
						/>
					</div>
					<div>
						<label class="block text-sm text-(--content-meta) mb-1">
							文件名 slug {mode === "update" ? "（编辑时锁定）" : "（可改，仅 a-z0-9-）"}
						</label>
						<input
							bind:value={slugInput}
							disabled={mode === "update"}
							placeholder="留空则从标题生成；纯中文标题会用 post-时间戳"
							class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content) disabled:opacity-60 font-mono text-sm"
						/>
					</div>
					<div class="grid grid-cols-2 gap-3">
						<div>
							<label class="block text-sm text-(--content-meta) mb-1">发布日期</label>
							<input
								type="date"
								bind:value={fm.published}
								class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
							/>
						</div>
						<div>
							<label class="block text-sm text-(--content-meta) mb-1">更新日期</label>
							<input
								type="date"
								bind:value={fm.updated}
								class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
							/>
						</div>
					</div>

					<!-- 分类：输入 + 已有快捷选 -->
					<div>
						<label class="block text-sm text-(--content-meta) mb-1">分类</label>
						<input
							bind:value={fm.category}
							list="cat-list"
							placeholder="输入或从下方选择"
							class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
						/>
						{#if knownCategories.length}
							<div class="flex flex-wrap gap-1.5 mt-2">
								{#each knownCategories as c}
									<button
										type="button"
										on:click={() => pickCategory(c)}
										class="text-xs px-2 py-0.5 rounded-full border transition-colors
											{fm.category === c
											? 'bg-(--primary) text-white border-(--primary)'
											: 'border-(--btn-regular-bg) text-(--btn-content) hover:border-(--primary)'}"
										>{c}</button
									>
								{/each}
							</div>
						{/if}
					</div>

					<!-- 标签：逗号输入 + 已有多选芯片 -->
					<div>
						<label class="block text-sm text-(--content-meta) mb-1">标签</label>
						<input
							bind:value={tagsInput}
							placeholder="逗号分隔，或点选下方标签"
							class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
						/>
						{#if knownTags.length}
							<div class="flex flex-wrap gap-1.5 mt-2">
								{#each knownTags as t}
									<button
										type="button"
										on:click={() => pickTag(t)}
										class="text-xs px-2 py-0.5 rounded-full border transition-colors
											{tagsFromInput.includes(t)
											? 'bg-(--primary) text-white border-(--primary)'
											: 'border-(--btn-regular-bg) text-(--btn-content) hover:border-(--primary)'}"
										>{t}</button
									>
								{/each}
							</div>
						{/if}
						<div class="flex gap-2 mt-2">
							<input
								bind:value={newTagDraft}
								on:keydown={(e) => e.key === "Enter" && (e.preventDefault(), addNewTag())}
								placeholder="新标签"
								class="flex-1 px-2 py-1 rounded border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content) text-sm"
							/>
							<button
								type="button"
								on:click={addNewTag}
								class="px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) text-sm"
								>添加</button
							>
						</div>
					</div>

					<div>
						<label class="block text-sm text-(--content-meta) mb-1">摘要</label>
						<textarea
							bind:value={fm.description}
							rows="2"
							class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
						></textarea>
					</div>
					<div>
						<label class="block text-sm text-(--content-meta) mb-1">封面 image</label>
						<input
							bind:value={fm.image}
							placeholder="assets/images/xxx.avif 或 /assets/..."
							class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
						/>
					</div>
					<div class="flex flex-wrap gap-4 text-sm text-(--btn-content)">
						<label class="flex items-center gap-2"
							><input type="checkbox" bind:checked={fm.draft} /> 草稿</label
						>
						<label class="flex items-center gap-2"
							><input type="checkbox" bind:checked={fm.pinned} /> 置顶</label
						>
						<label class="flex items-center gap-2"
							><input type="checkbox" bind:checked={fm.comment} /> 允许评论</label
						>
					</div>
					<details class="text-sm">
						<summary class="cursor-pointer text-(--content-meta)"
							>高级（作者 / 外链 / 许可 / 加密）</summary
						>
						<div class="flex flex-col gap-3 mt-2">
							<input
								bind:value={fm.author}
								placeholder="作者"
								class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
							/>
							<input
								bind:value={fm.sourceLink}
								placeholder="原文链接"
								class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
							/>
							<div class="grid grid-cols-2 gap-2">
								<input
									bind:value={fm.licenseName}
									placeholder="许可证名"
									class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
								/>
								<input
									bind:value={fm.licenseUrl}
									placeholder="许可证 URL"
									class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
								/>
							</div>
							<input
								type="password"
								bind:value={fm.password}
								placeholder="加密密码（留空则公开）"
								class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
							/>
							<input
								bind:value={fm.passwordHint}
								placeholder="密码提示"
								class="px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
							/>
						</div>
					</details>
				</div>

				<!-- 正文 + 工具栏 -->
				<div class="card-base p-4 flex flex-col gap-2">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<label class="text-sm text-(--content-meta)">正文 Markdown</label>
						<div class="flex flex-wrap gap-1">
							<button
								type="button"
								class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
								on:click={() => wrapSelection("**", "**", "粗体")}
								>B</button
							>
							<button
								type="button"
								class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) italic"
								on:click={() => wrapSelection("*", "*", "斜体")}
								>I</button
							>
							<button
								type="button"
								class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
								on:click={() => wrapSelection("`", "`", "code")}
								>`</button
							>
							<button
								type="button"
								class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
								on:click={() => insertAtCursor("\n## 标题\n\n")}
								>H2</button
							>
							<button
								type="button"
								class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
								on:click={() => insertAtCursor("\n- 列表项\n")}
								>列表</button
							>
							<button
								type="button"
								class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
								on:click={() => wrapSelection("[", "](https://)", "链接文字")}
								>链接</button
							>
							<button
								type="button"
								class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
								on:click={() => insertAtCursor("\n> 引用\n\n")}
								>引用</button
							>
							<button
								type="button"
								class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
								on:click={() => insertAtCursor("\n```\n代码\n```\n\n")}
								>代码块</button
							>
							<label
								class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) cursor-pointer"
							>
								图片
								<input
									type="file"
									accept="image/*"
									multiple
									class="hidden"
									on:change={onFilePick}
								/>
							</label>
						</div>
					</div>
					<textarea
						bind:this={bodyEl}
						bind:value={body}
						on:paste={onPaste}
						on:drop={onDrop}
						on:dragover|preventDefault
						rows="22"
						class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content) font-mono text-sm"
						placeholder="在此输入 Markdown 正文…支持粘贴/拖拽图片"
					></textarea>
					{#if imgMsg}
						<div class="text-xs text-(--content-meta)">
							{imgUploading ? "上传中… " : ""}{imgMsg}
						</div>
					{/if}
				</div>
			</div>

			{#if showPreview}
				<div
					class="card-base p-4 min-h-[400px] lg:max-h-[calc(100vh-160px)] overflow-auto sticky top-4"
				>
					<div class="text-sm text-(--content-meta) mb-2">实时预览</div>
					<div class="prose max-w-none text-(--btn-content)">
						{@html previewHtml}
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- datalist 全局一份 -->
<datalist id="cat-list">
	{#each knownCategories as c}
		<option value={c}></option>
	{/each}
</datalist>
<datalist id="tag-list">
	{#each knownTags as t}
		<option value={t}></option>
	{/each}
</datalist>
