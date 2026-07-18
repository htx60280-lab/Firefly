<script lang="ts">
/**
 * 后台正文 Tiptap 所见即所得
 * - Markdown 存储（marked gfm 入 / turndown-gfm 出）
 * - 表格增删行列、吸顶工具栏、悬浮目录（仿前端 TOC）
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
let tocPanelOpen = false;

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
	editor?.destroy();
	editor = null;
	ready = false;
	toc = [];
	inTable = false;
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

function scrollToHeading(item: (typeof toc)[0]) {
	if (mode === "source") return;
	if (!editor) return;
	const pos = Math.min(item.pos + 1, editor.state.doc.content.size);
	editor.chain().focus().setTextSelection(pos).run();
	try {
		const coords = editor.view.coordsAtPos(pos);
		const scroller = document.scrollingElement || document.documentElement;
		const targetY = coords.top + scroller.scrollTop - 120;
		scroller.scrollTo({ top: targetY, behavior: "smooth" });
	} catch {
		/* ignore */
	}
	// 移动端点目录后收起
	if (typeof window !== "undefined" && window.innerWidth < 768) {
		tocPanelOpen = false;
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
	destroyEditor();
});
</script>

<div class="admin-tiptap border border-(--btn-regular-bg) rounded-xl bg-(--card-bg)">
	<!-- 吸顶工具栏：相对视口 sticky，不随正文滚走 -->
	<div class="admin-tiptap-toolbar sticky top-0 z-20">
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
			<button type="button" class="tb font-mono text-xs" title="行内代码" on:click={toggleCode}
				>`</button
			>
			<span class="sep"></span>
			<button type="button" class="tb" title="标题 1" on:click={() => setH(1)}>H1</button>
			<button type="button" class="tb" title="标题 2" on:click={() => setH(2)}>H2</button>
			<button type="button" class="tb" title="标题 3" on:click={() => setH(3)}>H3</button>
			<span class="sep"></span>
			<button type="button" class="tb" title="无序列表" on:click={toggleBullet}>• 列表</button>
			<button type="button" class="tb" title="有序列表" on:click={toggleOrdered}>1.</button>
			<button type="button" class="tb" title="引用" on:click={toggleQuote}>引用</button>
			<button type="button" class="tb" title="代码块" on:click={toggleCodeBlock}>代码块</button>
			<button type="button" class="tb" title="链接" on:click={setLink}>链接</button>
			<button type="button" class="tb" title="分隔线" on:click={insertHr}>—</button>
			<span class="sep"></span>
			<button type="button" class="tb" title="插入表格" on:click={insertTable}>表格</button>
			{#if inTable}
				<button type="button" class="tb" title="左侧加列" on:click={addColBefore}>+列左</button>
				<button type="button" class="tb" title="右侧加列" on:click={addColAfter}>+列右</button>
				<button type="button" class="tb" title="删除列" on:click={delCol}>−列</button>
				<button type="button" class="tb" title="上方加行" on:click={addRowBefore}>+行上</button>
				<button type="button" class="tb" title="下方加行" on:click={addRowAfter}>+行下</button>
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
			title="目录"
			on:click={() => {
				showToc = !showToc;
				if (showToc) tocPanelOpen = true;
			}}>目录</button
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

	<!-- 正文区：仅内容滚动；目录为悬浮面板，不占横向挤编辑区 -->
	<div class="admin-tiptap-body relative" style="min-height: {minHeight}">
		{#if mode === "wysiwyg"}
			<div bind:this={hostEl} class="admin-tiptap-host" style="min-height: {minHeight}"></div>
		{:else}
			<textarea
				bind:value={sourceText}
				on:input={onSourceInput}
				class="admin-source-area"
				style="min-height: {minHeight}"
				spellcheck="false"
			></textarea>
		{/if}

		{#if showToc}
			<!-- 仿前端 FloatingTOC：右下角按钮 + 浮层面板 -->
			<div class="admin-toc-float">
				<button
					type="button"
					class="admin-toc-fab"
					aria-label="目录"
					title="目录"
					on:click={() => (tocPanelOpen = !tocPanelOpen)}
				>
					{tocPanelOpen ? "×" : "≡"}
				</button>
				{#if tocPanelOpen}
					<div class="admin-toc-panel">
						<div class="admin-toc-panel-title">目录</div>
						<div class="toc-scroll-container admin-toc-scroll">
							{#if toc.length === 0}
								<div class="text-xs text-(--content-meta) px-2 py-2">暂无标题</div>
							{:else}
								<div class="toc-content">
									{#each toc as item, i (item.id)}
										<button
											type="button"
											class="toc-item toc-level-{Math.min(item.level, 3)}"
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
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>
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

	.admin-tiptap-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--btn-regular-bg);
		/* 半透明 + 模糊，滚动时仍可读 */
		background: color-mix(in srgb, var(--card-bg) 92%, transparent);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		/* 顶栏下方；列表页 sticky 发布条约 3rem，这里略高一点 */
		top: 0.25rem;
		box-shadow: 0 1px 0 color-mix(in srgb, var(--btn-regular-bg) 80%, transparent);
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
	}
	.admin-tiptap-host {
		/* 正文自然增高，页面滚动；工具栏 sticky 不跟着走 */
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

	/* 悬浮目录 */
	.admin-toc-float {
		position: sticky;
		bottom: 1.25rem;
		float: right;
		clear: both;
		z-index: 30;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.5rem;
		pointer-events: none;
		margin: -3.5rem 0.75rem 0.75rem 0;
		height: 0;
	}
	.admin-toc-fab,
	.admin-toc-panel {
		pointer-events: auto;
	}
	.admin-toc-fab {
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--btn-regular-bg) 80%, transparent);
		background: color-mix(in srgb, var(--card-bg) 90%, transparent);
		backdrop-filter: blur(10px);
		color: var(--btn-content);
		font-size: 1.15rem;
		line-height: 1;
		box-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.35);
		display: grid;
		place-items: center;
		margin-left: auto;
	}
	.admin-toc-panel {
		width: min(18rem, calc(100vw - 2rem));
		max-height: min(24rem, 50vh);
		overflow: hidden;
		border-radius: 1rem;
		border: 1px solid color-mix(in srgb, var(--btn-regular-bg) 90%, transparent);
		background: color-mix(in srgb, var(--card-bg) 94%, transparent);
		backdrop-filter: blur(14px);
		box-shadow: 0 16px 40px -20px rgba(0, 0, 0, 0.45);
		padding: 0.5rem 0 0.35rem;
	}
	.admin-toc-panel-title {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--content-meta);
		padding: 0 0.85rem 0.35rem;
	}
	.admin-toc-scroll {
		max-height: min(20rem, 42vh);
		padding: 0 0.45rem 0.45rem;
	}

	/* 复用前端 toc 视觉 token（无全局变量时兜底） */
	.admin-toc-panel {
		--toc-btn-hover: color-mix(in srgb, var(--btn-regular-bg) 70%, transparent);
		--toc-btn-active: color-mix(in srgb, var(--primary) 12%, transparent);
		--toc-badge-bg: color-mix(in srgb, var(--btn-regular-bg) 80%, var(--primary) 8%);
		--toc-indicator-bg: color-mix(in srgb, var(--primary) 10%, transparent);
		--line-color: var(--btn-regular-bg);
	}

	/* 目录条目（对齐 toc.css 语义） */
	:global(.admin-toc-panel .toc-scroll-container) {
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	:global(.admin-toc-panel .toc-content) {
		display: flex;
		flex-direction: column;
		gap: 0.28rem;
		position: relative;
	}
	:global(.admin-toc-panel .toc-item) {
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
	:global(.admin-toc-panel .toc-item:hover) {
		background: var(--toc-btn-hover);
	}
	:global(.admin-toc-panel .toc-item.toc-level-1) {
		padding-left: 0.62rem;
	}
	:global(.admin-toc-panel .toc-item.toc-level-2) {
		padding-left: 1.1rem;
	}
	:global(.admin-toc-panel .toc-item.toc-level-3) {
		padding-left: 1.5rem;
	}
	:global(.admin-toc-panel .toc-badge) {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.35rem;
		height: 1.35rem;
		border-radius: 0.5rem;
		font-size: 0.68rem;
		font-weight: 700;
	}
	:global(.admin-toc-panel .toc-badge-index) {
		background: var(--toc-badge-bg);
		color: var(--btn-content);
	}
	:global(.admin-toc-panel .toc-label) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		flex: 1;
		font-size: 0.86rem;
		line-height: 1.3;
	}
	:global(.admin-toc-panel .toc-label-primary) {
		color: color-mix(in srgb, var(--content-meta) 40%, var(--btn-content));
	}
	:global(.admin-toc-panel .toc-label-secondary) {
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
