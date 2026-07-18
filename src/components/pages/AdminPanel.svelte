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

/** 本地暂存：多次修改合并，点「发布」才一次 commit */
type StagedUpsert = {
	op: "upsert";
	name: string;
	title: string;
	published?: string;
	updated?: string;
	draft?: boolean;
	description?: string;
	image?: string;
	tags?: string[];
	category?: string;
	lang?: string;
	pinned?: boolean;
	author?: string;
	sourceLink?: string;
	licenseName?: string;
	licenseUrl?: string;
	comment?: boolean;
	password?: string;
	passwordHint?: string;
	body: string;
	stagedAt: number;
};
type StagedDelete = { op: "delete"; name: string; stagedAt: number };
type StagedItem = StagedUpsert | StagedDelete;

const STAGE_KEY = "volant_admin_staging";

// ===================== 状态 =====================
let loggedIn = false;
let authChecking = true;
let password = "";
let loginError = "";
let loginLoading = false;

let view: "list" | "edit" | "staging" = "list";
let posts: PostListItem[] = [];
let knownCategories: string[] = [];
let knownTags: string[] = [];
let listLoading = false;
let listError = "";
let listFilter = "";
let selected = new Set<string>();

let staging: StagedItem[] = [];
let publishBusy = false;
let publishMsg = "";
let publishOk = false;

let fm: Frontmatter = emptyFrontmatter();
let body = "";
let mode: Mode = "auto";
let editingName = "";
let slugInput = "";

let saveMsg = "";
let saveOk = false;

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
function normalizeName(name: string): string {
	let n = name.trim().toLowerCase().replace(/\.md$/i, "");
	n = n
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return n ? `${n}.md` : "";
}

// ===================== 暂存 localStorage =====================
function loadStaging(): StagedItem[] {
	try {
		const raw = localStorage.getItem(STAGE_KEY);
		if (!raw) return [];
		const arr = JSON.parse(raw);
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}
function persistStaging(items: StagedItem[]) {
	staging = items;
	try {
		localStorage.setItem(STAGE_KEY, JSON.stringify(items));
	} catch {
		/* quota */
	}
}
/** 同名覆盖：最后一次操作为准 */
function upsertStage(item: StagedItem) {
	const name = normalizeName(item.name);
	if (!name) return;
	const next = staging.filter((x) => normalizeName(x.name) !== name);
	next.push({ ...item, name, stagedAt: Date.now() });
	persistStaging(next);
}
function removeStage(name: string) {
	const n = normalizeName(name);
	persistStaging(staging.filter((x) => normalizeName(x.name) !== n));
}
function clearStaging() {
	persistStaging([]);
}
function getStaged(name: string): StagedItem | undefined {
	const n = normalizeName(name);
	return staging.find((x) => normalizeName(x.name) === n);
}

$: if (markedFn) {
	try {
		previewHtml = markedFn(body);
	} catch {
		previewHtml = "<p style='color:#c00'>预览渲染出错</p>";
	}
}

/** 列表 = 远端 + 暂存合并视图 */
$: displayPosts = (() => {
	const map = new Map<string, PostListItem & { stage?: "upsert" | "delete" | "new" }>();
	for (const p of posts) {
		map.set(p.name, { ...p });
	}
	for (const s of staging) {
		const name = normalizeName(s.name);
		if (s.op === "delete") {
			const existing = map.get(name);
			if (existing) map.set(name, { ...existing, stage: "delete" });
			else
				map.set(name, {
					name,
					path: `src/content/posts/${name}`,
					sha: "",
					title: name.replace(/\.md$/i, ""),
					published: "",
					category: "",
					tags: [],
					draft: false,
					pinned: false,
					description: "",
					stage: "delete",
				});
		} else {
			const existing = map.get(name);
			map.set(name, {
				name,
				path: existing?.path || `src/content/posts/${name}`,
				size: existing?.size,
				sha: existing?.sha || "",
				title: s.title || existing?.title || name,
				published: s.published || existing?.published || "",
				category: s.category || "",
				tags: s.tags || [],
				draft: !!s.draft,
				pinned: !!s.pinned,
				description: s.description || "",
				stage: existing ? "upsert" : "new",
			});
		}
	}
	return Array.from(map.values()).sort((a, b) =>
		(b.published || "").localeCompare(a.published || ""),
	);
})();

$: filteredPosts = displayPosts.filter((p) => {
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
$: stagingCount = staging.length;

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
			staging = loadStaging();
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
		const names = new Set(displayPosts.map((p) => p.name));
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

/** 批量：只进暂存，不立刻 push */
function stageBatchDelete() {
	const names = [...selected];
	if (!names.length) {
		publishMsg = "请先勾选文章";
		publishOk = false;
		return;
	}
	if (!confirm(`将 ${names.length} 篇标记为「待删除」，发布时才真正删除。继续？`))
		return;
	for (const name of names) {
		upsertStage({ op: "delete", name, stagedAt: Date.now() });
	}
	selected = new Set();
	publishMsg = `已暂存删除 ${names.length} 篇，点「发布全部」才会推送到 GitHub`;
	publishOk = true;
}

function stageBatchDraft(value: boolean) {
	const names = [...selected];
	if (!names.length) return;
	for (const name of names) {
		const remote = posts.find((p) => p.name === name);
		const staged = getStaged(name);
		if (staged?.op === "delete") continue;
		if (staged?.op === "upsert") {
			upsertStage({ ...staged, draft: value });
			continue;
		}
		// 无正文时无法仅改 frontmatter 暂存完整文章——提示用户先编辑
		// 简化：从远端没有 body，批量草稿需要先拉取。改为 async。
	}
	// 异步拉取并暂存
	void (async () => {
		publishMsg = "正在读取并暂存…";
		let n = 0;
		for (const name of names) {
			const staged = getStaged(name);
			if (staged?.op === "delete") continue;
			if (staged?.op === "upsert") {
				upsertStage({ ...staged, draft: value });
				n++;
				continue;
			}
			const r = await api(`/api/admin/post?name=${encodeURIComponent(name)}`);
			if (!r.ok) continue;
			const data = await r.json();
			const f = data.frontmatter || {};
			upsertStage({
				op: "upsert",
				name,
				title: str(f.title, name),
				published: str(f.published, today()),
				updated: today(),
				draft: value,
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
				body: typeof data.body === "string" ? data.body : "",
				stagedAt: Date.now(),
			});
			n++;
		}
		selected = new Set();
		publishMsg = `已暂存 ${n} 篇「${value ? "设为草稿" : "取消草稿"}」，发布后生效`;
		publishOk = true;
	})();
}

function stageBatchPinned(value: boolean) {
	const names = [...selected];
	if (!names.length) return;
	void (async () => {
		publishMsg = "正在读取并暂存…";
		let n = 0;
		for (const name of names) {
			const staged = getStaged(name);
			if (staged?.op === "delete") continue;
			if (staged?.op === "upsert") {
				upsertStage({ ...staged, pinned: value });
				n++;
				continue;
			}
			const r = await api(`/api/admin/post?name=${encodeURIComponent(name)}`);
			if (!r.ok) continue;
			const data = await r.json();
			const f = data.frontmatter || {};
			upsertStage({
				op: "upsert",
				name,
				title: str(f.title, name),
				published: str(f.published, today()),
				updated: today(),
				draft: bool(f.draft, false),
				description: str(f.description, ""),
				image: str(f.image, ""),
				tags: arr(f.tags),
				category: str(f.category, ""),
				lang: str(f.lang, ""),
				pinned: value,
				author: str(f.author, ""),
				sourceLink: str(f.sourceLink, ""),
				licenseName: str(f.licenseName, ""),
				licenseUrl: str(f.licenseUrl, ""),
				comment: bool(f.comment, true),
				password: str(f.password, ""),
				passwordHint: str(f.passwordHint, ""),
				body: typeof data.body === "string" ? data.body : "",
				stagedAt: Date.now(),
			});
			n++;
		}
		selected = new Set();
		publishMsg = `已暂存 ${n} 篇「${value ? "置顶" : "取消置顶"}」，发布后生效`;
		publishOk = true;
	})();
}

function stageDeleteOne(p: PostListItem) {
	if (!confirm(`将《${p.title || p.name}》标记为待删除？发布时才真正删除。`))
		return;
	upsertStage({ op: "delete", name: p.name, stagedAt: Date.now() });
	publishMsg = `已暂存删除 ${p.name}`;
	publishOk = true;
}

// ===================== 发布（唯一 push 入口） =====================
async function publishAll() {
	if (staging.length === 0) {
		publishMsg = "暂存为空，无需发布";
		publishOk = false;
		return;
	}
	if (
		!confirm(
			`将把 ${staging.length} 条变更合并为 **1 次** Git 提交并触发 CF 构建。\n继续？`,
		)
	)
		return;
	publishBusy = true;
	publishMsg = "发布中…";
	publishOk = false;
	try {
		// 去掉 stagedAt 再提交
		const items = staging.map(({ stagedAt: _s, ...rest }) => rest);
		const r = await api("/api/admin/publish", {
			method: "POST",
			body: JSON.stringify({ items }),
		});
		const data = await r.json().catch(() => ({}));
		if (r.status === 401) {
			loggedIn = false;
			publishMsg = "会话过期，请重新登录";
			return;
		}
		if (!r.ok) {
			publishMsg = `发布失败：${data.error || r.status}${data.detail ? `（${data.detail}）` : ""}`;
			return;
		}
		publishOk = true;
		publishMsg = `✅ 已提交 1 次 commit（${data.changed} 个文件）${data.commit ? ` · ${String(data.commit).slice(0, 7)}` : ""}；${data.redeploy?.detail || ""}`;
		clearStaging();
		await listPosts();
		view = "list";
	} catch (e) {
		publishMsg = `网络错误: ${(e as Error).message}`;
	} finally {
		publishBusy = false;
	}
}

function discardAllStaging() {
	if (!staging.length) return;
	if (!confirm(`丢弃全部 ${staging.length} 条暂存？不可恢复。`)) return;
	clearStaging();
	publishMsg = "已清空暂存";
	publishOk = true;
}

// ===================== 编辑 =====================
function newPost() {
	editingName = "";
	fm = emptyFrontmatter();
	body = "";
	mode = "auto";
	slugInput = "";
	tagsInput = "";
	saveMsg = "";
	view = "edit";
}

async function editPost(name: string) {
	listLoading = true;
	try {
		// 优先用暂存内容
		const staged = getStaged(name);
		if (staged?.op === "upsert") {
			editingName = name;
			fm = {
				...emptyFrontmatter(),
				title: staged.title,
				published: staged.published || today(),
				updated: staged.updated || "",
				draft: !!staged.draft,
				description: staged.description || "",
				image: staged.image || "",
				tags: staged.tags || [],
				category: staged.category || "",
				lang: staged.lang || "",
				pinned: !!staged.pinned,
				author: staged.author || "",
				sourceLink: staged.sourceLink || "",
				licenseName: staged.licenseName || "",
				licenseUrl: staged.licenseUrl || "",
				comment: staged.comment !== false,
				password: staged.password || "",
				passwordHint: staged.passwordHint || "",
			};
			body = staged.body || "";
			tagsInput = fm.tags.join(", ");
			slugInput = name.replace(/\.md$/i, "");
			mode = "update";
			view = "edit";
			saveMsg = "正在编辑暂存版本（尚未发布到 GitHub）";
			saveOk = true;
			return;
		}
		if (staged?.op === "delete") {
			if (!confirm("该文已标记删除。要撤销删除并编辑吗？")) return;
			removeStage(name);
		}

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
	} catch (e) {
		listError = (e as Error).message;
	} finally {
		listLoading = false;
	}
}

function backToList() {
	view = "list";
	saveMsg = "";
}

function onTitleInput() {
	if (mode !== "update") {
		const s = slugify(fm.title);
		if (!slugInput || slugInput === slugify(slugInput)) slugInput = s;
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

/** 保存到本地暂存（不 push GitHub） */
function stageSave() {
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
	const slug =
		mode === "update" && editingName
			? editingName.replace(/\.md$/i, "")
			: (slugInput || slugify(fm.title) || `post-${Date.now().toString(36)}`)
					.toLowerCase()
					.replace(/[^a-z0-9-]/g, "-")
					.replace(/-+/g, "-")
					.replace(/^-|-$/g, "");
	if (!slug) {
		saveMsg = "slug 为空，请手动填写文件名";
		saveOk = false;
		return;
	}
	const name = `${slug}.md`;
	upsertStage({
		op: "upsert",
		name,
		title: fm.title.trim(),
		published: fm.published,
		updated: fm.updated || today(),
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
		body: body.trim(),
		stagedAt: Date.now(),
	});
	editingName = name;
	slugInput = slug;
	mode = "update";
	saveOk = true;
	saveMsg = `已暂存 ${name}（未推送）。可继续改其他文章，最后点「发布全部」。`;
	if (fm.category && !knownCategories.includes(fm.category)) {
		knownCategories = [...knownCategories, fm.category].sort((a, b) =>
			a.localeCompare(b, "zh"),
		);
	}
	for (const t of tagsFromInput) {
		if (!knownTags.includes(t))
			knownTags = [...knownTags, t].sort((a, b) => a.localeCompare(b, "zh"));
	}
}

// ===================== 图片（仍即时上传到仓库，否则预览无图） =====================
async function uploadImageFile(file: File) {
	if (!file.type.startsWith("image/")) return;
	imgUploading = true;
	imgMsg = "上传中…";
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
			imgMsg = `已上传：${data.ref}（图片会单独产生一次 commit）`;
			insertAtCursor(`![图片描述](${data.ref})\n\n`);
		} else if (r.status === 401) {
			loggedIn = false;
			imgMsg = "会话过期";
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
	const selectedText = body.slice(start, end) || placeholder;
	const text = before + selectedText + after;
	body = body.slice(0, start) + text + body.slice(end);
	requestAnimationFrame(() => {
		el.focus();
		el.setSelectionRange(
			start + before.length,
			start + before.length + selectedText.length,
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
	if (!files.length) return;
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
		markedFn = (mod.marked || mod.default).parse.bind(mod.marked || mod.default);
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
	staging = loadStaging();
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
	{:else}
		<!-- 顶栏：发布区（全局） -->
		<div
			class="card-base p-3 mb-4 flex flex-wrap items-center justify-between gap-2 sticky top-2 z-20 bg-(--card-bg)/95 backdrop-blur"
		>
			<div class="text-sm text-(--btn-content)">
				{#if stagingCount > 0}
					<span class="font-semibold text-(--primary)">待发布 {stagingCount} 条</span>
					<span class="text-(--content-meta)"> · 修改先存本地，点发布才 1 次 commit</span>
				{:else}
					<span class="text-(--content-meta)">暂存为空 · 编辑保存后会出现在这里</span>
				{/if}
			</div>
			<div class="flex flex-wrap gap-2">
				{#if stagingCount > 0}
					<button
						on:click={() => (view = "staging")}
						class="px-3 py-1.5 rounded-lg bg-(--btn-regular-bg) text-(--btn-content) text-sm"
						>查看暂存</button
					>
					<button
						on:click={discardAllStaging}
						class="px-3 py-1.5 rounded-lg bg-(--btn-regular-bg) text-(--btn-content) text-sm"
						>清空暂存</button
					>
				{/if}
				<button
					on:click={publishAll}
					disabled={publishBusy || stagingCount === 0}
					class="px-4 py-1.5 rounded-lg bg-(--primary) text-white text-sm font-semibold disabled:opacity-50"
				>
					{publishBusy ? "发布中…" : `发布全部（1 次提交）`}
				</button>
			</div>
		</div>
		{#if publishMsg}
			<div
				class="card-base p-3 mb-3 text-sm {publishOk ? 'text-green-600' : 'text-red-500'}"
			>
				{publishMsg}
			</div>
		{/if}

		{#if view === "staging"}
			<div class="flex items-center justify-between mb-4">
				<button
					on:click={() => (view = "list")}
					class="text-sm text-(--content-meta) hover:text-(--primary)">← 返回列表</button
				>
				<h2 class="text-xl font-bold text-(--btn-content)">暂存队列</h2>
				<span></span>
			</div>
			{#if staging.length === 0}
				<div class="card-base p-6 text-center text-(--content-meta)">暂存为空</div>
			{:else}
				<div class="flex flex-col gap-2">
					{#each staging as s (s.name + s.op + s.stagedAt)}
						<div class="card-base p-4 flex items-center justify-between gap-3">
							<div class="min-w-0">
								<div class="font-medium text-(--btn-content)">
									{#if s.op === "delete"}
										<span class="text-red-600">删除</span>
									{:else}
										<span class="text-(--primary)">写入</span>
										{s.title}
									{/if}
									· {s.name}
								</div>
								<div class="text-xs text-(--content-meta)">
									{new Date(s.stagedAt).toLocaleString()}
									{#if s.op === "upsert" && s.draft} · 草稿{/if}
								</div>
							</div>
							<button
								on:click={() => removeStage(s.name)}
								class="text-sm px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
								>移除</button
							>
						</div>
					{/each}
				</div>
			{/if}
		{:else if view === "list"}
			<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
				<h2 class="text-2xl font-bold text-(--btn-content)">文章管理</h2>
				<div class="flex flex-wrap gap-2">
					<button
						on:click={listPosts}
						disabled={listLoading}
						class="px-3 py-1.5 rounded-lg bg-(--btn-regular-bg) text-(--btn-content) text-sm disabled:opacity-60"
						>刷新远端</button
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

			<div class="card-base p-3 mb-3 flex flex-col gap-3">
				<input
					bind:value={listFilter}
					placeholder="搜索标题 / 文件名 / 分类 / 标签..."
					class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content) text-sm"
				/>
				<div class="flex flex-wrap items-center gap-2 text-sm">
					<label class="flex items-center gap-1.5 text-(--btn-content) cursor-pointer">
						<input type="checkbox" checked={allSelected} on:change={toggleSelectAll} />
						全选
					</label>
					<span class="text-(--content-meta)">已选 {selected.size}</span>
					<button
						disabled={selected.size === 0}
						on:click={() => stageBatchDraft(true)}
						class="px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) disabled:opacity-50"
						>暂存为草稿</button
					>
					<button
						disabled={selected.size === 0}
						on:click={() => stageBatchDraft(false)}
						class="px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) disabled:opacity-50"
						>暂存取消草稿</button
					>
					<button
						disabled={selected.size === 0}
						on:click={() => stageBatchPinned(true)}
						class="px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content) disabled:opacity-50"
						>暂存置顶</button
					>
					<button
						disabled={selected.size === 0}
						on:click={stageBatchDelete}
						class="px-2 py-1 rounded bg-red-500/15 text-red-600 disabled:opacity-50"
						>暂存删除</button
					>
				</div>
				<p class="text-xs text-(--content-meta)">
					以上批量操作只写入本地暂存，不会立即产生 GitHub commit。点顶部「发布全部」才一次推送。
				</p>
			</div>

			{#if listLoading && posts.length === 0}
				<div class="card-base p-6 text-center text-(--content-meta)">加载中...</div>
			{:else if listError}
				<div class="card-base p-6 text-red-500">{listError}</div>
			{:else if filteredPosts.length === 0}
				<div class="card-base p-6 text-center text-(--content-meta)">
					{posts.length === 0 && stagingCount === 0
						? "还没有文章，点「写文章」开始。"
						: "没有匹配的文章。"}
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
										{#if p.stage === "new"}
											<span class="text-xs px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-600"
												>待新增</span
											>
										{:else if p.stage === "upsert"}
											<span class="text-xs px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-600"
												>待更新</span
											>
										{:else if p.stage === "delete"}
											<span class="text-xs px-1.5 py-0.5 rounded bg-red-500/15 text-red-600"
												>待删除</span
											>
										{/if}
										{#if p.draft}
											<span
												class="text-xs px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400"
												>草稿</span
											>
										{/if}
										{#if p.pinned}
											<span
												class="text-xs px-1.5 py-0.5 rounded bg-(--primary)/15 text-(--primary)"
												>置顶</span
											>
										{/if}
									</div>
									<div
										class="text-xs text-(--content-meta) mt-0.5 flex flex-wrap gap-x-2"
									>
										<span>{p.name}</span>
										{#if p.published}<span>· {p.published}</span>{/if}
										{#if p.category}<span>· {p.category}</span>{/if}
										{#if p.tags?.length}<span>· {p.tags.join(", ")}</span>{/if}
									</div>
								</div>
							</label>
							<div class="flex gap-2 shrink-0">
								<button
									on:click={() => editPost(p.name)}
									class="text-sm px-3 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
									>编辑</button
								>
								<button
									on:click={() => stageDeleteOne(p)}
									class="text-sm px-3 py-1 rounded bg-red-500/15 text-red-600"
									>删除</button
								>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{:else}
			<!-- 编辑器 -->
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
						on:click={stageSave}
						class="px-4 py-1.5 rounded-lg bg-(--primary) text-white text-sm font-semibold"
					>
						暂存（不推送）
					</button>
				</div>
			</div>
			{#if saveMsg}
				<div class="card-base p-3 mb-3 text-sm {saveOk ? 'text-green-600' : 'text-red-500'}">
					{saveMsg}
				</div>
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
								文件名 slug {mode === "update" ? "（锁定）" : ""}
							</label>
							<input
								bind:value={slugInput}
								disabled={mode === "update"}
								placeholder="仅 a-z0-9-；纯中文会用 post-时间戳"
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
						<div>
							<label class="block text-sm text-(--content-meta) mb-1">分类</label>
							<input
								bind:value={fm.category}
								list="cat-list"
								class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
							/>
							{#if knownCategories.length}
								<div class="flex flex-wrap gap-1.5 mt-2">
									{#each knownCategories as c}
										<button
											type="button"
											on:click={() => pickCategory(c)}
											class="text-xs px-2 py-0.5 rounded-full border {fm.category === c
												? 'bg-(--primary) text-white border-(--primary)'
												: 'border-(--btn-regular-bg) text-(--btn-content)'}"
											>{c}</button
										>
									{/each}
								</div>
							{/if}
						</div>
						<div>
							<label class="block text-sm text-(--content-meta) mb-1">标签</label>
							<input
								bind:value={tagsInput}
								placeholder="逗号分隔，或点选"
								class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content)"
							/>
							{#if knownTags.length}
								<div class="flex flex-wrap gap-1.5 mt-2">
									{#each knownTags as t}
										<button
											type="button"
											on:click={() => pickTag(t)}
											class="text-xs px-2 py-0.5 rounded-full border {tagsFromInput.includes(t)
												? 'bg-(--primary) text-white border-(--primary)'
												: 'border-(--btn-regular-bg) text-(--btn-content)'}"
											>{t}</button
										>
									{/each}
								</div>
							{/if}
							<div class="flex gap-2 mt-2">
								<input
									bind:value={newTagDraft}
									on:keydown={(e) =>
										e.key === "Enter" && (e.preventDefault(), addNewTag())}
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
							<label class="block text-sm text-(--content-meta) mb-1">封面</label>
							<input
								bind:value={fm.image}
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
							<summary class="cursor-pointer text-(--content-meta)">高级</summary>
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
								<input
									type="password"
									bind:value={fm.password}
									placeholder="加密密码"
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

					<div class="card-base p-4 flex flex-col gap-2">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<label class="text-sm text-(--content-meta)">正文 Markdown</label>
							<div class="flex flex-wrap gap-1">
								<button
									type="button"
									class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
									on:click={() => wrapSelection("**", "**", "粗体")}>B</button
								>
								<button
									type="button"
									class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
									on:click={() => wrapSelection("*", "*", "斜体")}>I</button
								>
								<button
									type="button"
									class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
									on:click={() => wrapSelection("`", "`", "code")}>`</button
								>
								<button
									type="button"
									class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
									on:click={() => insertAtCursor("\n## 标题\n\n")}>H2</button
								>
								<button
									type="button"
									class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
									on:click={() => insertAtCursor("\n- 列表项\n")}>列表</button
								>
								<button
									type="button"
									class="text-xs px-2 py-1 rounded bg-(--btn-regular-bg) text-(--btn-content)"
									on:click={() => wrapSelection("[", "](https://)", "链接")}>链接</button
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
							rows="20"
							class="w-full px-3 py-2 rounded-lg border border-(--btn-regular-bg) bg-(--card-bg) text-(--btn-content) font-mono text-sm"
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
						class="card-base p-4 min-h-[400px] lg:max-h-[calc(100vh-160px)] overflow-auto sticky top-16"
					>
						<div class="text-sm text-(--content-meta) mb-2">实时预览</div>
						<div class="prose max-w-none text-(--btn-content)">{@html previewHtml}</div>
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<datalist id="cat-list">
	{#each knownCategories as c}<option value={c}></option>{/each}
</datalist>
<datalist id="tag-list">
	{#each knownTags as t}<option value={t}></option>{/each}
</datalist>
