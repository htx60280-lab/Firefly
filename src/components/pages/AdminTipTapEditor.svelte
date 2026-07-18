<script lang="ts">
/**
 * 后台正文 Tiptap 所见即所得编辑器
 * - 存储仍为 Markdown（marked 入 / turndown 出）
 * - 支持源码模式切换
 */
import { Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { marked } from "marked";
import { createEventDispatcher, onDestroy, onMount } from "svelte";
import TurndownService from "turndown";

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
/** 避免 setContent 触发的 update 回写造成环 */
let applyingExternal = false;

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
	emDelimiter: "*",
});
turndown.addRule("strikethrough", {
	filter: ["del", "s", "strike"] as unknown as string[],
	replacement: (t: string) => `~~${t}~~`,
});
turndown.addRule("underline", {
	filter: ["u"] as unknown as string[],
	replacement: (t: string) => `<u>${t}</u>`,
});

function mdToHtml(md: string): string {
	try {
		const html = marked.parse(md || "", { async: false, breaks: true });
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

function emitMarkdown() {
	if (!editor || applyingExternal) return;
	const md = htmlToMd(editor.getHTML());
	content = md;
	dispatch("change", md);
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
			Placeholder.configure({
				placeholder: "开始写作…支持标题、列表、代码块、链接、图片",
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
	});
	ready = true;
}

function destroyEditor() {
	editor?.destroy();
	editor = null;
	ready = false;
}

function applyExternalContent(md: string) {
	sourceText = md || "";
	if (mode === "source") return;
	if (!editor) return;
	applyingExternal = true;
	editor.commands.setContent(mdToHtml(md || ""), { emitUpdate: false });
	applyingExternal = false;
}

// 仅在 contentKey 变化时灌入外部 Markdown，避免把用户输入回写成 setContent
let lastAppliedKey = "";
$: if (ready && contentKey !== lastAppliedKey) {
	lastAppliedKey = contentKey;
	applyExternalContent(content);
}

function setMode(next: "wysiwyg" | "source") {
	if (next === mode) return;
	if (next === "source") {
		// 从所见即所得取出最新 MD
		if (editor) sourceText = htmlToMd(editor.getHTML());
		else sourceText = content;
		mode = "source";
		destroyEditor();
	} else {
		// 源码 → 所见即所得
		content = sourceText;
		dispatch("change", sourceText);
		mode = "wysiwyg";
		// 等 DOM 挂载 host
		requestAnimationFrame(() => {
			createEditor();
			applyExternalContent(sourceText);
		});
	}
}

function onSourceInput() {
	content = sourceText;
	dispatch("change", sourceText);
}

function cmd(fn: (e: Editor) => void) {
	if (!editor) return;
	fn(editor);
	editor.chain().focus().run();
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

/** 供父组件插入图片 Markdown / URL */
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

/** 供父组件在暂存前强制同步最新 MD */
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
		{:else}
			<span class="text-xs text-(--content-meta) px-2">源码模式：直接编辑 Markdown</span>
		{/if}
		<div class="flex-1"></div>
		<button
			type="button"
			class="tb {!mode || mode === 'wysiwyg' ? 'active' : ''}"
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
			class="admin-tiptap-host overflow-auto"
			style="min-height: {minHeight}"
		></div>
	{:else}
		<textarea
			bind:value={sourceText}
			on:input={onSourceInput}
			class="w-full px-4 py-3 font-mono text-sm text-(--btn-content) bg-(--card-bg) border-0 focus:outline-none resize-y"
			style="min-height: {minHeight}"
			spellcheck="false"
		></textarea>
	{/if}
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
</style>
