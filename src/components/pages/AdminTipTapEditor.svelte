<script lang="ts">
/**
 * 后台正文 Tiptap 所见即所得
 * - Markdown 存储（marked gfm 入 / turndown-gfm 出）
 * - 工具栏吸在「正文编辑区」顶部（非整页 fixed）
 * - 目录仿文章页 SidebarTOC：右侧 sticky + IntersectionObserver 高亮
 */
import { Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import {
	Table,
	TableCell,
	TableHeader,
	TableRow,
} from "@tiptap/extension-table";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { marked } from "marked";
import { createEventDispatcher, onDestroy, onMount, tick } from "svelte";
import TurndownService from "turndown";
// @ts-expect-error no types
import { gfm } from "turndown-plugin-gfm";

export let content = "";
export let contentKey = "";
export let editable = true;
export let minHeight = "420px";

const dispatch = createEventDispatcher<{ change: string }>();

let hostEl: HTMLDivElement | null = null;
let editor: Editor | null = null;
let mode: "wysiwyg" | "source" = "wysiwyg";
let sourceText = "";
let ready = false;
let applyingExternal = false;
let showToc = true;
let toc: Array<{ id: string; level: number; text: string; pos: number }> = [];
let inTable = false;
/** 当前视口内标题，用于目录高亮（对齐 TOCManager） */
let activeTocId = "";
let headingObserver: IntersectionObserver | null = null;
let scrollSpyRaf = 0;

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
	emDelimiter: "*",
});
turndown.use(gfm);
turndown.addRule("underline", {
	filter: ["u"] as unknown as string[],
	replacement: (t: string) => `<u>${t}</u>`,
});

function mdToHtml(md: string): string {
	try {
		const html = marked.parse(md || "", {
			async: false,
			breaks: true,
			gfm: true,
		});
		return typeof html === "string" ? html : "";
	} catch {
		return `<p>${escapeHtml(md || "")}</p>`;
	}
}

function htmlToMd(html: string): string {
	try {
		return turndown.turndown(html || "").trim();
	} catch {
		return content;
	}
}

function escapeHtml(s: string): string {
	return s.replace(
		/[&<>]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] || c,
	);
}

function refreshMeta() {
	if (!editor) {
		toc = [];
		inTable = false;
		return;
	}
	const items: typeof toc = [];
	editor.state.doc.descendants((node, pos) => {
		if (node.type.name === "heading") {
			const level = Number(node.attrs.level) || 1;
			const text = node.textContent.trim() || `标题 ${level}`;
			items.push({ id: `h-${pos}`, level, text, pos });
		}
	});
	toc = items;
	inTable = editor.isActive("table");
	// DOM 更新后挂载滚动监听
	queueMicrotask(() => bindHeadingScrollSpy());
}

function unbindHeadingScrollSpy() {
	headingObserver?.disconnect();
	headingObserver = null;
	if (scrollSpyRaf) {
		cancelAnimationFrame(scrollSpyRaf);
		scrollSpyRaf = 0;
	}
}

/**
 * 仿文章页 TOCManager：用 IntersectionObserver 跟踪正文标题，
 * 目录侧栏高亮当前段落（随页面滚动更新）。
 */
function bindHeadingScrollSpy() {
	unbindHeadingScrollSpy();
	if (!hostEl || mode !== "wysiwyg") return;
	const headings = Array.from(
		hostEl.querySelectorAll<HTMLElement>("h1, h2, h3, h4"),
	);
	if (!headings.length) {
		activeTocId = "";
		return;
	}
	// 给 DOM 标题打上 data-toc-id，与 toc 数组对齐
	const items = toc;
	headings.forEach((el, i) => {
		const item = items[i];
		if (item) el.setAttribute("data-toc-id", item.id);
	});

	const visible = new Map<string, number>();
	headingObserver = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				const id = (entry.target as HTMLElement).getAttribute("data-toc-id");
				if (!id) continue;
				if (entry.isIntersecting) {
					visible.set(id, entry.intersectionRatio);
				} else {
					visible.delete(id);
				}
			}
			if (scrollSpyRaf) cancelAnimationFrame(scrollSpyRaf);
			scrollSpyRaf = requestAnimationFrame(() => {
				// 取视口中靠上的可见标题
				let bestId = "";
				let bestTop = Number.POSITIVE_INFINITY;
				for (const el of headings) {
					const id = el.getAttribute("data-toc-id");
					if (!id || !visible.has(id)) continue;
					const top = el.getBoundingClientRect().top;
					// 工具栏约 3.5rem，优先选刚过顶栏的标题
					if (top >= 48 && top < bestTop) {
						bestTop = top;
						bestId = id;
					}
				}
				if (!bestId) {
					// 全部在顶栏上方时，取最后一个已滚过的
					for (let i = headings.length - 1; i >= 0; i--) {
						const el = headings[i];
						if (el.getBoundingClientRect().top < 96) {
							bestId = el.getAttribute("data-toc-id") || "";
							break;
						}
					}
				}
				if (bestId) activeTocId = bestId;
			});
		},
		{
			root: null,
			// 顶部为吸顶工具栏留白，底部放宽
			rootMargin: "-140px 0px -55% 0px",
			threshold: [0, 0.1, 0.5, 1],
		},
	);
	for (const el of headings) headingObserver.observe(el);
}

function emitMarkdown() {
	if (!editor || applyingExternal) return;
	const md = htmlToMd(editor.getHTML());
	content = md;
	dispatch("change", md);
	refreshMeta();
}

function createEditor() {
	if (!hostEl || editor) return;
	editor = new Editor({
		element: hostEl,
		editable,
		extensions: [
			StarterKit.configure({
				heading: { levels: [1, 2, 3, 4] },
			}),
			Underline,
			Link.configure({
				openOnClick: false,
				HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
			}),
			Image.configure({ inline: false, allowBase64: false }),
			// resizable 依赖额外 view，关掉以免命令异常；行列增删用 command
			Table.configure({
				resizable: false,
				allowTableNodeSelection: true,
				HTMLAttributes: { class: "admin-tiptap-table" },
			}),
			TableRow,
			TableHeader,
			TableCell,
			Placeholder.configure({
				placeholder: "开始写作…支持标题、列表、表格、代码块、链接、图片",
			}),
		],
		content: mdToHtml(content),
		editorProps: {
			attributes: {
				class:
					"admin-tiptap-prose prose max-w-none focus:outline-none min-h-[360px] px-4 py-3",
			},
		},
		onUpdate: () => emitMarkdown(),
		onSelectionUpdate: () => {
			if (editor) inTable = editor.isActive("table");
		},
		onTransaction: () => {
			if (editor) inTable = editor.isActive("table");
		},
	});
	ready = true;
	refreshMeta();
}

function destroyEditor() {
	unbindHeadingScrollSpy();
	editor?.destroy();
	editor = null;
	ready = false;
	toc = [];
	inTable = false;
	activeTocId = "";
}

function applyExternalContent(md: string) {
	sourceText = md || "";
	if (mode === "source") {
		toc = parseMdToc(sourceText);
		return;
	}
	if (!editor) return;
	applyingExternal = true;
	editor.commands.setContent(mdToHtml(md || ""), { emitUpdate: false });
	applyingExternal = false;
	refreshMeta();
}

let lastAppliedKey = "";
$: if (ready && contentKey !== lastAppliedKey) {
	lastAppliedKey = contentKey;
	applyExternalContent(content);
}

function setMode(next: "wysiwyg" | "source") {
	if (next === mode) return;
	if (next === "source") {
		if (editor) sourceText = htmlToMd(editor.getHTML());
		else sourceText = content;
		mode = "source";
		destroyEditor();
		toc = parseMdToc(sourceText);
	} else {
		content = sourceText;
		dispatch("change", sourceText);
		mode = "wysiwyg";
		void tick().then(() => {
			createEditor();
			applyExternalContent(sourceText);
		});
	}
}

function parseMdToc(md: string) {
	const items: typeof toc = [];
	(md || "").split("\n").forEach((line, i) => {
		const m = line.match(/^(#{1,4})\s+(.+)$/);
		if (!m) return;
		items.push({
			id: `md-h-${i}`,
			level: m[1].length,
			text: m[2].trim(),
			pos: i,
		});
	});
	return items;
}

function onSourceInput() {
	content = sourceText;
	dispatch("change", sourceText);
	toc = parseMdToc(sourceText);
}

function stickyOffsetPx(): number {
	// stickyNavbar + 发布顶栏 + 正文工具栏
	const stickyNav = typeof document !== "undefined" && document.body.classList.contains("sticky-navbar");
	const nav = stickyNav ? 76 : 8;
	const topbar = document.querySelector(".admin-topbar") as HTMLElement | null;
	const tb = topbar?.offsetHeight || 0;
	const toolbar = document.querySelector(".admin-tiptap-toolbar") as HTMLElement | null;
	const th = toolbar?.offsetHeight || 56;
	return nav + tb + th + 8;
}

function scrollToHeading(item: (typeof toc)[0]) {
	if (mode === "source") return;
	if (!editor || !hostEl) return;
	const pos = Math.min(item.pos + 1, editor.state.doc.content.size);
	editor.chain().focus().setTextSelection(pos).run();
	activeTocId = item.id;
	try {
		// 优先滚到 DOM 标题（对齐文章页 hash 跳转）
		const el = hostEl.querySelector<HTMLElement>(`[data-toc-id="${item.id}"]`);
		const offset = stickyOffsetPx();
		if (el) {
			const rect = el.getBoundingClientRect();
			const scroller = document.scrollingElement || document.documentElement;
			scroller.scrollTo({
				top: rect.top + scroller.scrollTop - offset,
				behavior: "smooth",
			});
			return;
		}
		const coords = editor.view.coordsAtPos(pos);
		const scroller = document.scrollingElement || document.documentElement;
		scroller.scrollTo({
			top: coords.top + scroller.scrollTop - offset,
			behavior: "smooth",
		});
	} catch {
		/* ignore */
	}
}

/** 安全执行表格等命令：不二次 focus.run，避免吞掉 command 返回值 */
function run(chainFn: (e: Editor) => boolean) {
	if (!editor) return;
	const ok = chainFn(editor);
	if (!ok) {
		// 部分表格命令需先选中单元格
		console.warn("[admin-tiptap] command failed");
	}
	refreshMeta();
	inTable = editor.isActive("table");
}

function toggleBold() {
	run((e) => e.chain().focus().toggleBold().run());
}
function toggleItalic() {
	run((e) => e.chain().focus().toggleItalic().run());
}
function toggleStrike() {
	run((e) => e.chain().focus().toggleStrike().run());
}
function toggleUnderline() {
	run((e) => e.chain().focus().toggleUnderline().run());
}
function toggleCode() {
	run((e) => e.chain().focus().toggleCode().run());
}
function setH(level: 1 | 2 | 3) {
	run((e) => e.chain().focus().toggleHeading({ level }).run());
}
function toggleBullet() {
	run((e) => e.chain().focus().toggleBulletList().run());
}
function toggleOrdered() {
	run((e) => e.chain().focus().toggleOrderedList().run());
}
function toggleQuote() {
	run((e) => e.chain().focus().toggleBlockquote().run());
}
function toggleCodeBlock() {
	run((e) => e.chain().focus().toggleCodeBlock().run());
}
function setLink() {
	if (!editor) return;
	const prev = editor.getAttributes("link").href as string | undefined;
	const url = window.prompt("链接 URL", prev || "https://");
	if (url === null) return;
	if (url === "") {
		editor.chain().focus().extendMarkRange("link").unsetLink().run();
		return;
	}
	editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
}
function insertHr() {
	run((e) => e.chain().focus().setHorizontalRule().run());
}
function insertTable() {
	run((e) =>
		e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
	);
}
function addColBefore() {
	run((e) => e.chain().focus().addColumnBefore().run());
}
function addColAfter() {
	run((e) => e.chain().focus().addColumnAfter().run());
}
function delCol() {
	run((e) => e.chain().focus().deleteColumn().run());
}
function addRowBefore() {
	run((e) => e.chain().focus().addRowBefore().run());
}
function addRowAfter() {
	run((e) => e.chain().focus().addRowAfter().run());
}
function delRow() {
	run((e) => e.chain().focus().deleteRow().run());
}
function delTable() {
	run((e) => e.chain().focus().deleteTable().run());
}
function toggleHeaderRow() {
	run((e) => e.chain().focus().toggleHeaderRow().run());
}

export function insertImage(src: string, alt = "图片") {
	if (mode === "source") {
		const snip = `\n![${alt}](${src})\n\n`;
		sourceText = `${sourceText}${sourceText.endsWith("\n") ? "" : "\n"}${snip}`;
		onSourceInput();
		return;
	}
	if (!editor) return;
	editor.chain().focus().setImage({ src, alt }).run();
	emitMarkdown();
}

export function getMarkdown(): string {
	if (mode === "source") return sourceText;
	if (editor) return htmlToMd(editor.getHTML());
	return content;
}

onMount(() => {
	sourceText = content || "";
	if (mode === "wysiwyg") createEditor();
});

onDestroy(() => {
	unbindHeadingScrollSpy();
	destroyEditor();
});
</script>

<div class="admin-tiptap" class:with-toc={showToc}>
	<!--
	  布局对齐文章页：左侧正文列（工具栏 sticky 在正文区顶）+ 右侧目录 sticky。
	  工具栏不 fixed 到整页，只在「正文编辑区」内吸顶，元数据表单滚过后才贴住。
	-->
	<div class="admin-tiptap-main" class:with-toc={showToc}>
		<div class="admin-tiptap-body">
			<div class="admin-tiptap-toolbar">
				{#if mode === "wysiwyg"}
					<button type="button" class="tb" title="粗体" on:click={toggleBold}
						><b>B</b></button
					>
					<button type="button" class="tb italic" title="斜体" on:click={toggleItalic}
						>I</button
					>
					<button type="button" class="tb" title="下划线" on:click={toggleUnderline}
						>U</button
					>
					<button type="button" class="tb line-through" title="删除线" on:click={toggleStrike}
						>S</button
					>
					<button
						type="button"
						class="tb font-mono text-xs"
						title="行内代码"
						on:click={toggleCode}>`</button
					>
					<span class="sep"></span>
					<button type="button" class="tb" title="标题 1" on:click={() => setH(1)}>H1</button>
					<button type="button" class="tb" title="标题 2" on:click={() => setH(2)}>H2</button>
					<button type="button" class="tb" title="标题 3" on:click={() => setH(3)}>H3</button>
					<span class="sep"></span>
					<button type="button" class="tb" title="无序列表" on:click={toggleBullet}
						>• 列表</button
					>
					<button type="button" class="tb" title="有序列表" on:click={toggleOrdered}
						>1.</button
					>
					<button type="button" class="tb" title="引用" on:click={toggleQuote}>引用</button>
					<button type="button" class="tb" title="代码块" on:click={toggleCodeBlock}
						>代码块</button
					>
					<button type="button" class="tb" title="链接" on:click={setLink}>链接</button>
					<button type="button" class="tb" title="分隔线" on:click={insertHr}>—</button>
					<span class="sep"></span>
					<button type="button" class="tb" title="插入表格" on:click={insertTable}
						>表格</button
					>
					{#if inTable}
						<button type="button" class="tb" title="左侧加列" on:click={addColBefore}
							>+列左</button
						>
						<button type="button" class="tb" title="右侧加列" on:click={addColAfter}
							>+列右</button
						>
						<button type="button" class="tb" title="删除列" on:click={delCol}>−列</button>
						<button type="button" class="tb" title="上方加行" on:click={addRowBefore}
							>+行上</button
						>
						<button type="button" class="tb" title="下方加行" on:click={addRowAfter}
							>+行下</button
						>
						<button type="button" class="tb" title="删除行" on:click={delRow}>−行</button>
						<button type="button" class="tb" title="切换表头行" on:click={toggleHeaderRow}
							>表头</button
						>
						<button type="button" class="tb danger" title="删除整表" on:click={delTable}
							>删表</button
						>
					{/if}
				{:else}
					<span class="text-xs text-(--content-meta) px-2">源码模式：直接编辑 Markdown</span>
				{/if}
				<div class="flex-1"></div>
				<button
					type="button"
					class="tb {showToc ? 'active' : ''}"
					title="显示/隐藏目录"
					on:click={() => (showToc = !showToc)}>目录</button
				>
				<button
					type="button"
					class="tb {mode === 'wysiwyg' ? 'active' : ''}"
					on:click={() => setMode("wysiwyg")}>所见即所得</button
				>
				<button
					type="button"
					class="tb {mode === 'source' ? 'active' : ''}"
					on:click={() => setMode("source")}>源码</button
				>
			</div>

			{#if mode === "wysiwyg"}
				<div
					bind:this={hostEl}
					class="admin-tiptap-host"
					style="min-height: {minHeight}"
				></div>
			{:else}
				<textarea
					bind:value={sourceText}
					on:input={onSourceInput}
					class="admin-source-area"
					style="min-height: {minHeight}"
					spellcheck="false"
				></textarea>
			{/if}
		</div>

		{#if showToc}
			<aside class="admin-toc-sidebar" aria-label="文章目录">
				<div class="admin-toc-sidebar-inner">
					<div class="admin-toc-panel-title">目录</div>
					<div class="toc-scroll-container admin-toc-scroll">
						{#if toc.length === 0}
							<div class="text-xs text-(--content-meta) px-2 py-2">暂无标题</div>
						{:else}
							<div class="toc-content">
								{#each toc as item, i (item.id)}
									<button
										type="button"
										class="toc-item toc-level-{Math.min(item.level, 3)} {activeTocId ===
										item.id
											? 'visible active'
											: ''}"
										title={item.text}
										on:click={() => scrollToHeading(item)}
									>
										<span class="toc-badge toc-badge-index">{i + 1}</span>
										<span
											class="toc-label {item.level <= 2
												? 'toc-label-primary'
												: 'toc-label-secondary'}">{item.text}</span
										>
									</button>
								{/each}
								<div
									class="toc-active-indicator"
									style="opacity: {activeTocId ? 1 : 0};"
								></div>
							</div>
						{/if}
					</div>
				</div>
			</aside>
		{/if}
	</div>
</div>

<style>
	.admin-tiptap {
		/* 亮/暗色统一用语义色，避免 prose 默认灰字在暗色不可读 */
		--admin-editor-fg: var(--btn-content);
		--admin-editor-muted: var(--content-meta);
		--admin-code-bg: color-mix(in srgb, var(--btn-regular-bg) 85%, var(--primary) 8%);
		--admin-code-fg: var(--btn-content);
		--admin-pre-bg: color-mix(in srgb, var(--btn-regular-bg) 92%, black 6%);
		--admin-pre-fg: var(--btn-content);
		--admin-strong-fg: var(--btn-content);
		--admin-heading-fg: var(--btn-content);
		color: var(--admin-editor-fg);
	}

	:global(html.dark) .admin-tiptap,
	:global(.dark) .admin-tiptap {
		--admin-code-bg: color-mix(in srgb, #1e293b 80%, var(--primary) 12%);
		--admin-code-fg: #e2e8f0;
		--admin-pre-bg: #0f172a;
		--admin-pre-fg: #e2e8f0;
		--admin-strong-fg: #f8fafc;
		--admin-heading-fg: #f1f5f9;
	}

	:global(html:not(.dark)) .admin-tiptap {
		--admin-code-bg: color-mix(in srgb, #f1f5f9 90%, var(--primary) 6%);
		--admin-code-fg: #0f172a;
		--admin-pre-bg: #f8fafc;
		--admin-pre-fg: #0f172a;
		--admin-strong-fg: #0f172a;
		--admin-heading-fg: #0f172a;
	}

	.admin-tiptap-main {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.85rem;
		align-items: start;
	}
	.admin-tiptap-main.with-toc {
		/* 正文 + 侧栏目录，对齐文章页主栏/侧栏关系 */
		grid-template-columns: minmax(0, 1fr) 15.5rem;
	}
	@media (max-width: 960px) {
		.admin-tiptap-main.with-toc {
			grid-template-columns: 1fr;
		}
	}

	/*
	 * 工具栏：sticky 在「正文编辑区」顶部，不是 fixed 到整页。
	 * 父级 admin-editor-shell / admin-tiptap-body 必须 overflow:visible。
	 */
	.admin-tiptap-toolbar {
		position: sticky;
		top: 8.5rem; /* stickyNavbar + 发布顶栏 */
		z-index: 25;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		padding: 0.45rem 0.65rem;
		border-bottom: 1px solid var(--btn-regular-bg);
		background: color-mix(in srgb, var(--card-bg) 94%, transparent);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		box-shadow: 0 4px 14px -12px rgba(0, 0, 0, 0.4);
	}

	:global(body:not(.sticky-navbar)) .admin-tiptap-toolbar {
		top: 4rem; /* 仅发布顶栏 */
	}

	.tb {
		font-size: 12px;
		padding: 4px 8px;
		border-radius: 6px;
		color: var(--btn-content);
		background: transparent;
		border: 1px solid transparent;
		line-height: 1.2;
	}
	.tb:hover {
		background: var(--btn-regular-bg);
	}
	.tb.active {
		background: color-mix(in srgb, var(--primary) 18%, transparent);
		border-color: color-mix(in srgb, var(--primary) 40%, transparent);
		color: var(--primary);
	}
	.tb.danger {
		color: #dc2626;
	}
	:global(.dark) .tb.danger {
		color: #f87171;
	}
	.sep {
		width: 1px;
		height: 16px;
		background: var(--btn-regular-bg);
		margin: 0 4px;
	}

	.admin-tiptap-body {
		position: relative;
		min-width: 0;
		border: 1px solid var(--btn-regular-bg);
		border-radius: 0.75rem;
		background: var(--card-bg);
		/* 关键：不能 hidden，否则内部 sticky 工具栏失效 */
		overflow: visible;
	}
	.admin-tiptap-host {
		overflow: visible;
	}
	.admin-source-area {
		width: 100%;
		padding: 0.75rem 1rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.875rem;
		line-height: 1.6;
		color: var(--admin-editor-fg);
		background: var(--card-bg);
		border: 0;
		outline: none;
		resize: vertical;
	}

	/* 右侧目录：对齐 SidebarTOC — sticky 随页面滚动，目录自身可滚 */
	.admin-toc-sidebar {
		position: sticky;
		/* stickyNavbar 时与侧栏目录一致，顶在导航下方 */
		top: 5.5rem;
		align-self: start;
		z-index: 10;
	}
	:global(body:not(.sticky-navbar)) .admin-toc-sidebar {
		top: 0.75rem;
	}
	.admin-toc-sidebar-inner {
		border: 1px solid color-mix(in srgb, var(--btn-regular-bg) 90%, transparent);
		border-radius: 1rem;
		background: color-mix(in srgb, var(--card-bg) 96%, transparent);
		backdrop-filter: blur(10px);
		padding: 0.55rem 0.35rem 0.45rem;
		box-shadow: 0 8px 28px -18px rgba(0, 0, 0, 0.35);
		--toc-btn-hover: color-mix(in srgb, var(--btn-regular-bg) 70%, transparent);
		--toc-badge-bg: color-mix(in srgb, var(--btn-regular-bg) 80%, var(--primary) 8%);
	}
	.admin-toc-panel-title {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--content-meta);
		padding: 0 0.65rem 0.4rem;
	}
	.admin-toc-scroll {
		/* 对齐 .toc-scroll-container max-height: calc(100vh - 25rem) 的思路 */
		max-height: min(70vh, calc(100vh - 8rem));
		padding: 0 0.25rem 0.25rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	@media (max-width: 960px) {
		.admin-toc-sidebar {
			position: relative;
			top: 0;
		}
		.admin-toc-scroll {
			max-height: 14rem;
		}
	}

	/* 当前标题高亮（对齐 .toc-item.visible） */
	:global(.admin-toc-sidebar .toc-item.active),
	:global(.admin-toc-sidebar .toc-item.visible) {
		background: color-mix(in srgb, var(--primary) 12%, transparent);
	}
	:global(.admin-toc-sidebar .toc-item.active .toc-label),
	:global(.admin-toc-sidebar .toc-item.visible .toc-label) {
		color: var(--primary);
		font-weight: 600;
	}
	:global(.admin-toc-sidebar .toc-item.active .toc-badge-index),
	:global(.admin-toc-sidebar .toc-item.visible .toc-badge-index) {
		background: color-mix(in srgb, var(--primary) 22%, var(--btn-regular-bg));
		color: var(--primary);
	}

	:global(.admin-toc-sidebar .toc-content) {
		display: flex;
		flex-direction: column;
		gap: 0.28rem;
		position: relative;
	}
	:global(.admin-toc-sidebar .toc-item) {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: 100%;
		border: 0;
		background: transparent;
		border-radius: 0.875rem;
		padding: 0.48rem 0.62rem;
		min-height: 2.2rem;
		cursor: pointer;
		color: inherit;
		text-align: left;
	}
	:global(.admin-toc-sidebar .toc-item:hover) {
		background: var(--toc-btn-hover);
	}
	:global(.admin-toc-sidebar .toc-item.toc-level-1) {
		padding-left: 0.62rem;
	}
	:global(.admin-toc-sidebar .toc-item.toc-level-2) {
		padding-left: 1.1rem;
	}
	:global(.admin-toc-sidebar .toc-item.toc-level-3) {
		padding-left: 1.5rem;
	}
	:global(.admin-toc-sidebar .toc-badge) {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.35rem;
		height: 1.35rem;
		border-radius: 0.5rem;
		font-size: 0.68rem;
		font-weight: 700;
	}
	:global(.admin-toc-sidebar .toc-badge-index) {
		background: var(--toc-badge-bg);
		color: var(--btn-content);
	}
	:global(.admin-toc-sidebar .toc-label) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		flex: 1;
		font-size: 0.86rem;
		line-height: 1.3;
	}
	:global(.admin-toc-sidebar .toc-label-primary) {
		color: color-mix(in srgb, var(--content-meta) 40%, var(--btn-content));
	}
	:global(.admin-toc-sidebar .toc-label-secondary) {
		color: var(--content-meta);
	}

	:global(.admin-tiptap-host .tiptap) {
		min-height: 360px;
		outline: none;
		color: var(--admin-editor-fg);
	}
	:global(.admin-tiptap-host .tiptap p.is-editor-empty:first-child::before) {
		color: var(--admin-editor-muted);
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}

	/* 标题 / 正文 / 粗体：强制语义前景色，压过 prose 灰阶 */
	:global(.admin-tiptap-prose),
	:global(.admin-tiptap-prose p),
	:global(.admin-tiptap-prose li) {
		color: var(--admin-editor-fg);
	}
	:global(.admin-tiptap-prose h1),
	:global(.admin-tiptap-prose h2),
	:global(.admin-tiptap-prose h3),
	:global(.admin-tiptap-prose h4) {
		color: var(--admin-heading-fg) !important;
		font-weight: 700;
	}
	:global(.admin-tiptap-prose h1) {
		font-size: 1.75rem;
		margin: 0.8em 0 0.4em;
	}
	:global(.admin-tiptap-prose h2) {
		font-size: 1.4rem;
		margin: 0.8em 0 0.4em;
	}
	:global(.admin-tiptap-prose h3) {
		font-size: 1.15rem;
		margin: 0.7em 0 0.35em;
	}
	:global(.admin-tiptap-prose p) {
		margin: 0.5em 0;
		line-height: 1.7;
	}
	:global(.admin-tiptap-prose strong),
	:global(.admin-tiptap-prose b) {
		color: var(--admin-strong-fg) !important;
		font-weight: 700;
	}
	:global(.admin-tiptap-prose ul) {
		list-style: disc;
		padding-left: 1.4em;
		margin: 0.5em 0;
	}
	:global(.admin-tiptap-prose ol) {
		list-style: decimal;
		padding-left: 1.4em;
		margin: 0.5em 0;
	}
	:global(.admin-tiptap-prose blockquote) {
		border-left: 3px solid var(--primary);
		padding-left: 0.9em;
		margin: 0.6em 0;
		color: var(--admin-editor-muted);
	}

	/* 代码：亮色深字+浅底，暗色浅字+深底 */
	:global(.admin-tiptap-prose pre) {
		background: var(--admin-pre-bg) !important;
		color: var(--admin-pre-fg) !important;
		padding: 0.75em 1em;
		border-radius: 0.5rem;
		overflow-x: auto;
		font-size: 0.875rem;
		border: 1px solid color-mix(in srgb, var(--btn-regular-bg) 90%, transparent);
	}
	:global(.admin-tiptap-prose pre code) {
		background: transparent !important;
		color: inherit !important;
		padding: 0;
		font-size: inherit;
	}
	:global(.admin-tiptap-prose code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.875em;
	}
	:global(.admin-tiptap-prose :not(pre) > code) {
		background: var(--admin-code-bg) !important;
		color: var(--admin-code-fg) !important;
		padding: 0.12em 0.4em;
		border-radius: 0.25rem;
		border: 1px solid color-mix(in srgb, var(--btn-regular-bg) 70%, transparent);
	}

	:global(.admin-tiptap-prose img) {
		max-width: 100%;
		height: auto;
		border-radius: 0.5rem;
		margin: 0.6em 0;
	}
	:global(.admin-tiptap-prose a) {
		color: var(--primary);
		text-decoration: underline;
	}
	:global(.admin-tiptap-prose hr) {
		border: none;
		border-top: 1px solid var(--btn-regular-bg);
		margin: 1em 0;
	}

	/* 表格 */
	:global(.admin-tiptap-prose table),
	:global(.admin-tiptap-prose .admin-tiptap-table) {
		border-collapse: collapse;
		width: 100%;
		margin: 0.75em 0;
		table-layout: fixed;
		overflow: hidden;
	}
	:global(.admin-tiptap-prose th),
	:global(.admin-tiptap-prose td) {
		border: 1px solid var(--btn-regular-bg);
		padding: 0.45em 0.65em;
		vertical-align: top;
		position: relative;
		min-width: 2.5em;
		color: var(--admin-editor-fg);
	}
	:global(.admin-tiptap-prose th) {
		background: color-mix(in srgb, var(--btn-regular-bg) 75%, transparent);
		font-weight: 600;
		color: var(--admin-heading-fg);
	}
	:global(.admin-tiptap-prose .selectedCell::after) {
		content: "";
		position: absolute;
		inset: 0;
		background: color-mix(in srgb, var(--primary) 14%, transparent);
		pointer-events: none;
		z-index: 1;
	}
</style>
