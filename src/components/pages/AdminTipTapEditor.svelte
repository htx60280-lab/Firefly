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

/**
 * 普通命令：可 focus。
 * 表格命令：禁止先 focus()——会丢失单元格选区导致 addRow/addColumn 恒为 false。
 */
function run(cmd: () => boolean, opts?: { keepCellSelection?: boolean }) {
	if (!editor) return;
	const ok = cmd();
	if (!ok) {
		console.warn("[admin-tiptap] command failed");
	}
	if (!opts?.keepCellSelection) {
		try {
			editor.view.focus();
		} catch {
			/* ignore */
		}
	}
	refreshMeta();
	inTable = !!(editor?.isActive("table") || editor?.isActive("tableCell") || editor?.isActive("tableHeader"));
}

function toggleBold() {
	run(() => !!editor?.chain().focus().toggleBold().run());
}
function toggleItalic() {
	run(() => !!editor?.chain().focus().toggleItalic().run());
}
function toggleStrike() {
	run(() => !!editor?.chain().focus().toggleStrike().run());
}
function toggleUnderline() {
	run(() => !!editor?.chain().focus().toggleUnderline().run());
}
function toggleCode() {
	run(() => !!editor?.chain().focus().toggleCode().run());
}
function setH(level: 1 | 2 | 3) {
	run(() => !!editor?.chain().focus().toggleHeading({ level }).run());
}
function toggleBullet() {
	run(() => !!editor?.chain().focus().toggleBulletList().run());
}
function toggleOrdered() {
	run(() => !!editor?.chain().focus().toggleOrderedList().run());
}
function toggleQuote() {
	run(() => !!editor?.chain().focus().toggleBlockquote().run());
}
function toggleCodeBlock() {
	run(() => !!editor?.chain().focus().toggleCodeBlock().run());
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
	run(() => !!editor?.chain().focus().setHorizontalRule().run());
}
function insertTable() {
	run(() =>
		!!editor
			?.chain()
			.focus()
			.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
			.run(),
	);
}
/** 表格行列：用 commands 直接派发，避免 chain().focus() 冲掉选区 */
function addColBefore() {
	run(() => !!editor?.commands.addColumnBefore(), { keepCellSelection: true });
}
function addColAfter() {
	run(() => !!editor?.commands.addColumnAfter(), { keepCellSelection: true });
}
function delCol() {
	run(() => !!editor?.commands.deleteColumn(), { keepCellSelection: true });
}
function addRowBefore() {
	run(() => !!editor?.commands.addRowBefore(), { keepCellSelection: true });
}
function addRowAfter() {
	run(() => !!editor?.commands.addRowAfter(), { keepCellSelection: true });
}
function delRow() {
	run(() => !!editor?.commands.deleteRow(), { keepCellSelection: true });
}
function delTable() {
	run(() => !!editor?.commands.deleteTable(), { keepCellSelection: true });
}
function toggleHeaderRow() {
	run(() => !!editor?.commands.toggleHeaderRow(), { keepCellSelection: true });
}

function canTable(cmd: string): boolean {
	if (!editor) return false;
	try {
		const can = editor.can() as unknown as Record<string, () => boolean>;
		return typeof can[cmd] === "function" ? !!can[cmd]() : true;
	} catch {
		return false;
	}
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

function syncToolbarLayout() {
	// fixed 工具栏宽度/水平居中对齐编辑器卡片
	const root = document.querySelector(".admin-tiptap") as HTMLElement | null;
	const bar = document.getElementById("admin-tiptap-toolbar");
	if (!root || !bar) return;
	const rect = root.getBoundingClientRect();
	bar.style.width = `${Math.min(rect.width, window.innerWidth - 16)}px`;
	bar.style.left = `${rect.left + rect.width / 2}px`;
	// 顶栏发布条 + 站点 navbar 大致高度
	const navH = document.querySelector("#navbar-wrapper")?.getBoundingClientRect().height || 0;
	const publishH =
		document.querySelector(".admin-panel .sticky")?.getBoundingClientRect().height || 0;
	bar.style.top = `${Math.max(navH, 0) + Math.max(publishH, 0) + 8}px`;
}

onMount(() => {
	sourceText = content || "";
	if (mode === "wysiwyg") createEditor();
	syncToolbarLayout();
	window.addEventListener("resize", syncToolbarLayout);
	window.addEventListener("scroll", syncToolbarLayout, { passive: true });
});

onDestroy(() => {
	destroyEditor();
	if (typeof window !== "undefined") {
		window.removeEventListener("resize", syncToolbarLayout);
		window.removeEventListener("scroll", syncToolbarLayout);
	}
});
</script>

<div class="admin-tiptap border border-(--btn-regular-bg) rounded-xl bg-(--card-bg)">
	<!--
	  工具栏占位：高度固定，真正的条用 fixed 贴视口，避开父级 overflow:hidden 导致 sticky 失效
	-->
	<div class="admin-tiptap-toolbar-spacer" aria-hidden="true"></div>
	<div class="admin-tiptap-toolbar" id="admin-tiptap-toolbar">
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
			<!-- 表格操作始终显示；不可用时 disabled，避免 inTable 检测失败导致“没有增删” -->
			<button
				type="button"
				class="tb"
				title="左侧加列（光标先点进表格单元格）"
				disabled={mode === "wysiwyg" && !canTable("addColumnBefore")}
				on:click={addColBefore}>+列左</button
			>
			<button
				type="button"
				class="tb"
				title="右侧加列"
				disabled={mode === "wysiwyg" && !canTable("addColumnAfter")}
				on:click={addColAfter}>+列右</button
			>
			<button
				type="button"
				class="tb"
				title="删除列"
				disabled={mode === "wysiwyg" && !canTable("deleteColumn")}
				on:click={delCol}>−列</button
			>
			<button
				type="button"
				class="tb"
				title="上方加行"
				disabled={mode === "wysiwyg" && !canTable("addRowBefore")}
				on:click={addRowBefore}>+行上</button
			>
			<button
				type="button"
				class="tb"
				title="下方加行"
				disabled={mode === "wysiwyg" && !canTable("addRowAfter")}
				on:click={addRowAfter}>+行下</button
			>
			<button
				type="button"
				class="tb"
				title="删除行"
				disabled={mode === "wysiwyg" && !canTable("deleteRow")}
				on:click={delRow}>−行</button
			>
			<button
				type="button"
				class="tb"
				title="切换表头行"
				disabled={mode === "wysiwyg" && !canTable("toggleHeaderRow")}
				on:click={toggleHeaderRow}>表头</button
			>
			<button
				type="button"
				class="tb danger"
				title="删除整表"
				disabled={mode === "wysiwyg" && !canTable("deleteTable")}
				on:click={delTable}>删表</button
			>
		{:else}
			<span class="text-xs text-(--content-meta) px-2">源码模式：直接编辑 Markdown</span>
		{/if}
		<div class="flex-1"></div>
		<button
			type="button"
			class="tb {tocPanelOpen ? 'active' : ''}"
			title="目录"
			on:click={() => (tocPanelOpen = !tocPanelOpen)}>目录</button
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

	<div class="admin-tiptap-body" style="min-height: {minHeight}">
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
	</div>
</div>

<!-- 目录：fixed 视口右下，仿 FloatingTOC，不依赖父级 overflow -->
{#if tocPanelOpen}
	<div class="admin-toc-layer" role="dialog" aria-label="文章目录">
		<div class="admin-toc-panel">
			<div class="admin-toc-panel-head">
				<span>目录</span>
				<button type="button" class="tb" on:click={() => (tocPanelOpen = false)}>×</button>
			</div>
			<div class="admin-toc-scroll">
				{#if toc.length === 0}
					<div class="text-xs text-(--content-meta) px-3 py-3">
						暂无标题。用工具栏 H1/H2/H3 添加标题后会出现在这里。
					</div>
				{:else}
					<div class="admin-toc-list">
						{#each toc as item, i (item.id)}
							<button
								type="button"
								class="admin-toc-item level-{Math.min(item.level, 3)}"
								title={item.text}
								on:click={() => scrollToHeading(item)}
							>
								<span class="admin-toc-idx">{i + 1}</span>
								<span class="admin-toc-text">{item.text}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

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

	/* 站点 .card-base 有 overflow:hidden，sticky 会失效 → 工具栏改 fixed */
	.admin-tiptap-toolbar-spacer {
		height: 3.25rem; /* 与 fixed 工具栏大致等高，避免正文被挡住 */
	}
	.admin-tiptap-toolbar {
		position: fixed;
		/* 顶栏发布条下方；窄屏略低 */
		top: 4.5rem;
		left: 50%;
		transform: translateX(-50%);
		width: min(72rem, calc(100vw - 1.5rem));
		z-index: 60;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		padding: 0.45rem 0.6rem;
		border: 1px solid color-mix(in srgb, var(--btn-regular-bg) 90%, transparent);
		border-radius: 0.75rem;
		background: color-mix(in srgb, var(--card-bg) 94%, transparent);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		box-shadow: 0 10px 30px -18px rgba(0, 0, 0, 0.45);
		max-height: 40vh;
		overflow-y: auto;
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
	.tb:hover:not(:disabled) {
		background: var(--btn-regular-bg);
	}
	.tb:disabled {
		opacity: 0.35;
		cursor: not-allowed;
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
		/* 必须 visible：父级 card-base 已 overflow hidden，这里再 hidden 会雪上加霜 */
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

	/* 目录：fixed 视口，仿前端悬浮 TOC */
	.admin-toc-layer {
		position: fixed;
		right: 1rem;
		bottom: 1.25rem;
		z-index: 70;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.5rem;
		pointer-events: none;
	}
	.admin-toc-panel {
		pointer-events: auto;
		width: min(18rem, calc(100vw - 2rem));
		max-height: min(26rem, 55vh);
		display: flex;
		flex-direction: column;
		border-radius: 1rem;
		border: 1px solid color-mix(in srgb, var(--btn-regular-bg) 90%, transparent);
		background: color-mix(in srgb, var(--card-bg) 96%, transparent);
		backdrop-filter: blur(14px);
		box-shadow: 0 16px 40px -18px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}
	.admin-toc-panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.55rem 0.65rem 0.35rem 0.9rem;
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--content-meta);
		border-bottom: 1px solid color-mix(in srgb, var(--btn-regular-bg) 80%, transparent);
	}
	.admin-toc-scroll {
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0.4rem 0.45rem 0.55rem;
		max-height: min(22rem, 48vh);
	}
	.admin-toc-list {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.admin-toc-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		border: 0;
		background: transparent;
		border-radius: 0.75rem;
		padding: 0.42rem 0.55rem;
		cursor: pointer;
		text-align: left;
		color: var(--btn-content);
	}
	.admin-toc-item:hover {
		background: color-mix(in srgb, var(--btn-regular-bg) 75%, transparent);
	}
	.admin-toc-item.level-2 {
		padding-left: 1.1rem;
	}
	.admin-toc-item.level-3 {
		padding-left: 1.55rem;
	}
	.admin-toc-idx {
		flex-shrink: 0;
		width: 1.3rem;
		height: 1.3rem;
		border-radius: 0.45rem;
		display: grid;
		place-items: center;
		font-size: 0.68rem;
		font-weight: 700;
		background: color-mix(in srgb, var(--btn-regular-bg) 80%, var(--primary) 10%);
		color: var(--btn-content);
	}
	.admin-toc-text {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.86rem;
		line-height: 1.3;
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
