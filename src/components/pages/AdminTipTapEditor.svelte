<script lang="ts">
/**
 * 后台正文 Tiptap 所见即所得编辑器
 * - Markdown 存储（marked 入 / turndown+gfm 出）
 * - 表格、标题侧栏目录、源码模式
 */
import { Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { marked } from "marked";
import { createEventDispatcher, onDestroy, onMount } from "svelte";
import TurndownService from "turndown";
// @ts-expect-error no types for plugin entry
import { gfm } from "turndown-plugin-gfm";

export let content = "";
/** 切换文章时递增，强制把外部 Markdown 灌入编辑器 */
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

function refreshToc() {
	if (!editor) {
		toc = [];
		return;
	}
	const items: typeof toc = [];
	const { doc } = editor.state;
	doc.descendants((node, pos) => {
		if (node.type.name === "heading") {
			const level = node.attrs.level as number;
			const text = node.textContent.trim() || `标题 ${level}`;
			const id = `h-${pos}`;
			items.push({ id, level, text, pos });
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
	refreshToc();
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
			Table.configure({
				resizable: true,
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
					"admin-tiptap-prose prose max-w-none focus:outline-none min-h-[360px] px-4 py-3 text-(--btn-content)",
			},
		},
		onUpdate: () => {
			emitMarkdown();
		},
		onSelectionUpdate: () => {
			if (editor) inTable = editor.isActive("table");
		},
	});
	ready = true;
	refreshToc();
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
	if (mode === "source") return;
	if (!editor) return;
	applyingExternal = true;
	editor.commands.setContent(mdToHtml(md || ""), { emitUpdate: false });
	applyingExternal = false;
	refreshToc();
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
		// 源码模式用 Markdown 标题生成简易目录
		toc = parseMdToc(sourceText);
	} else {
		content = sourceText;
		dispatch("change", sourceText);
		mode = "wysiwyg";
		requestAnimationFrame(() => {
			createEditor();
			applyExternalContent(sourceText);
		});
	}
}

function parseMdToc(md: string) {
	const items: typeof toc = [];
	const lines = (md || "").split("\n");
	lines.forEach((line, i) => {
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
	if (mode === "source") {
		// 源码：尽量滚到对应行（textarea 无精确 API，仅更新提示）
		return;
	}
	if (!editor) return;
	editor.chain().focus().setTextSelection(item.pos + 1).run();
	// 滚到视图
	try {
		const dom = editor.view.domAtPos(item.pos + 1);
		const el =
			dom.node instanceof HTMLElement
				? dom.node
				: (dom.node.parentElement as HTMLElement | null);
		el?.scrollIntoView({ behavior: "smooth", block: "center" });
	} catch {
		/* ignore */
	}
}

function cmd(fn: (e: Editor) => void) {
	if (!editor) return;
	fn(editor);
	editor.chain().focus().run();
	refreshToc();
}

function toggleBold() {
	cmd((e) => e.chain().focus().toggleBold().run());
}
function toggleItalic() {
	cmd((e) => e.chain().focus().toggleItalic().run());
}
function toggleStrike() {
	cmd((e) => e.chain().focus().toggleStrike().run());
}
function toggleUnderline() {
	cmd((e) => e.chain().focus().toggleUnderline().run());
}
function toggleCode() {
	cmd((e) => e.chain().focus().toggleCode().run());
}
function setH(level: 1 | 2 | 3) {
	cmd((e) => e.chain().focus().toggleHeading({ level }).run());
}
function toggleBullet() {
	cmd((e) => e.chain().focus().toggleBulletList().run());
}
function toggleOrdered() {
	cmd((e) => e.chain().focus().toggleOrderedList().run());
}
function toggleQuote() {
	cmd((e) => e.chain().focus().toggleBlockquote().run());
}
function toggleCodeBlock() {
	cmd((e) => e.chain().focus().toggleCodeBlock().run());
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
	cmd((e) => e.chain().focus().setHorizontalRule().run());
}
function insertTable() {
	cmd((e) =>
		e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
	);
}
function addColBefore() {
	cmd((e) => e.chain().focus().addColumnBefore().run());
}
function addColAfter() {
	cmd((e) => e.chain().focus().addColumnAfter().run());
}
function delCol() {
	cmd((e) => e.chain().focus().deleteColumn().run());
}
function addRowBefore() {
	cmd((e) => e.chain().focus().addRowBefore().run());
}
function addRowAfter() {
	cmd((e) => e.chain().focus().addRowAfter().run());
}
function delRow() {
	cmd((e) => e.chain().focus().deleteRow().run());
}
function delTable() {
	cmd((e) => e.chain().focus().deleteTable().run());
}
function toggleHeaderRow() {
	cmd((e) => e.chain().focus().toggleHeaderRow().run());
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

<div class="admin-tiptap border border-(--btn-regular-bg) rounded-lg overflow-hidden bg-(--card-bg)">
	<!-- 工具栏 -->
	<div
		class="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-(--btn-regular-bg) bg-(--btn-regular-bg)/30"
	>
		{#if mode === "wysiwyg"}
			<button type="button" class="tb" title="粗体" on:click={toggleBold}>B</button>
			<button type="button" class="tb italic" title="斜体" on:click={toggleItalic}>I</button>
			<button type="button" class="tb" title="下划线" on:click={toggleUnderline}>U</button>
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
			<button type="button" class="tb" title="有序列表" on:click={toggleOrdered}>1. 列表</button>
			<button type="button" class="tb" title="引用" on:click={toggleQuote}>引用</button>
			<button type="button" class="tb" title="代码块" on:click={toggleCodeBlock}>代码块</button>
			<button type="button" class="tb" title="链接" on:click={setLink}>链接</button>
			<button type="button" class="tb" title="分隔线" on:click={insertHr}>—</button>
			<span class="sep"></span>
			<button type="button" class="tb" title="插入 3×3 表格" on:click={insertTable}>表格</button>
			{#if inTable}
				<button type="button" class="tb" title="左侧加列" on:click={addColBefore}>←列</button>
				<button type="button" class="tb" title="右侧加列" on:click={addColAfter}>列→</button>
				<button type="button" class="tb" title="删除列" on:click={delCol}>删列</button>
				<button type="button" class="tb" title="上方加行" on:click={addRowBefore}>↑行</button>
				<button type="button" class="tb" title="下方加行" on:click={addRowAfter}>行↓</button>
				<button type="button" class="tb" title="删除行" on:click={delRow}>删行</button>
				<button type="button" class="tb" title="表头行" on:click={toggleHeaderRow}>表头</button>
				<button type="button" class="tb text-red-600" title="删除表格" on:click={delTable}
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

	<div class="flex min-h-0" style="min-height: {minHeight}">
		{#if showToc}
			<aside
				class="toc-aside w-44 shrink-0 border-r border-(--btn-regular-bg) overflow-y-auto py-2 px-2 hidden sm:block"
			>
				<div class="text-xs font-semibold text-(--content-meta) px-1 mb-2">目录</div>
				{#if toc.length === 0}
					<div class="text-xs text-(--content-meta) px-1">暂无标题</div>
				{:else}
					<nav class="flex flex-col gap-0.5">
						{#each toc as item (item.id)}
							<button
								type="button"
								class="toc-item text-left text-xs text-(--btn-content) hover:text-(--primary) truncate rounded px-1 py-0.5"
								style="padding-left: {(item.level - 1) * 0.55 + 0.25}rem"
								title={item.text}
								on:click={() => scrollToHeading(item)}
							>
								{item.text}
							</button>
						{/each}
					</nav>
				{/if}
			</aside>
		{/if}

		<div class="flex-1 min-w-0 flex flex-col">
			{#if mode === "wysiwyg"}
				<div
					bind:this={hostEl}
					class="admin-tiptap-host overflow-auto flex-1"
					style="min-height: {minHeight}"
				></div>
			{:else}
				<textarea
					bind:value={sourceText}
					on:input={onSourceInput}
					class="w-full flex-1 px-4 py-3 font-mono text-sm text-(--btn-content) bg-(--card-bg) border-0 focus:outline-none resize-y"
					style="min-height: {minHeight}"
					spellcheck="false"
				></textarea>
			{/if}
		</div>
	</div>
</div>

<style>
	.tb {
		font-size: 12px;
		padding: 4px 8px;
		border-radius: 6px;
		color: var(--btn-content);
		background: transparent;
		border: 1px solid transparent;
	}
	.tb:hover {
		background: var(--btn-regular-bg);
	}
	.tb.active {
		background: color-mix(in srgb, var(--primary) 18%, transparent);
		border-color: color-mix(in srgb, var(--primary) 40%, transparent);
		color: var(--primary);
	}
	.sep {
		width: 1px;
		height: 16px;
		background: var(--btn-regular-bg);
		margin: 0 4px;
	}
	.toc-item:hover {
		background: var(--btn-regular-bg);
	}
	:global(.admin-tiptap-host .tiptap) {
		min-height: 360px;
		outline: none;
	}
	:global(.admin-tiptap-host .tiptap p.is-editor-empty:first-child::before) {
		color: var(--content-meta);
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
	:global(.admin-tiptap-prose h1) {
		font-size: 1.75rem;
		font-weight: 700;
		margin: 0.8em 0 0.4em;
	}
	:global(.admin-tiptap-prose h2) {
		font-size: 1.4rem;
		font-weight: 700;
		margin: 0.8em 0 0.4em;
	}
	:global(.admin-tiptap-prose h3) {
		font-size: 1.15rem;
		font-weight: 600;
		margin: 0.7em 0 0.35em;
	}
	:global(.admin-tiptap-prose p) {
		margin: 0.5em 0;
		line-height: 1.7;
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
		color: var(--content-meta);
	}
	:global(.admin-tiptap-prose pre) {
		background: color-mix(in srgb, var(--btn-regular-bg) 80%, transparent);
		padding: 0.75em 1em;
		border-radius: 0.5rem;
		overflow-x: auto;
		font-size: 0.875rem;
	}
	:global(.admin-tiptap-prose code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.875em;
	}
	:global(.admin-tiptap-prose :not(pre) > code) {
		background: color-mix(in srgb, var(--btn-regular-bg) 80%, transparent);
		padding: 0.1em 0.35em;
		border-radius: 0.25rem;
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
	}
	:global(.admin-tiptap-prose th) {
		background: color-mix(in srgb, var(--btn-regular-bg) 70%, transparent);
		font-weight: 600;
	}
	:global(.admin-tiptap-prose .selectedCell::after) {
		content: "";
		position: absolute;
		inset: 0;
		background: color-mix(in srgb, var(--primary) 12%, transparent);
		pointer-events: none;
		z-index: 1;
	}
	:global(.admin-tiptap-prose .column-resize-handle) {
		position: absolute;
		right: -2px;
		top: 0;
		bottom: 0;
		width: 4px;
		background: var(--primary);
		pointer-events: none;
	}
</style>
