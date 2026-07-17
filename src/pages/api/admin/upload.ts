import type { APIContext } from "astro";
import {
	GhApiError,
	type GhEnv,
	readGhEnv,
	readPost,
	triggerRedeploy,
	type WriteResult,
	writePost,
} from "@/lib/server/github";
import { isAllowed, requireAuth } from "@/lib/server/guard";
import { json, jsonError } from "@/lib/server/web";

export const prerender = false;

// 文章 frontmatter 校验 schema（与 content.config.ts 对齐，子集 + 校验规则）
interface ArticleInput {
	slug?: string;
	title?: string;
	published?: string; // YYYY-MM-DD
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
	body?: string; // 正文 Markdown（不含 frontmatter）
	mode?: "create" | "update" | "auto";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function serializeFrontmatter(input: ArticleInput): string {
	const today = new Date().toISOString().slice(0, 10);
	const fields: Array<[string, string]> = [];
	const push = (k: string, v: unknown) => {
		if (v === undefined || v === null) return;
		if (typeof v === "string")
			fields.push([k, v === "" ? '""' : yamlScalar(v)]);
		else if (typeof v === "boolean" || typeof v === "number")
			fields.push([k, String(v)]);
		else if (Array.isArray(v))
			fields.push([k, v.length ? `[${v.map(yamlScalar).join(", ")}]` : "[]"]);
	};
	push("title", (input.title ?? "").trim() || "Untitled");
	push(
		"published",
		DATE_RE.test(input.published ?? "") ? input.published : today,
	);
	push("updated", input.updated);
	push("draft", input.draft);
	push("description", input.description);
	push("image", input.image);
	push("tags", input.tags);
	push("category", input.category);
	push("lang", input.lang);
	push("pinned", input.pinned);
	push("author", input.author);
	push("sourceLink", input.sourceLink);
	push("licenseName", input.licenseName);
	push("licenseUrl", input.licenseUrl);
	push("comment", input.comment);
	push("password", input.password);
	push("passwordHint", input.passwordHint);
	return (
		"---\n" + fields.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n\n"
	);
}

/** YAML 标量序列化：含特殊字符的字符串加引号转义，防注入 */
function yamlScalar(s: string): string {
	if (/[:#&*!|>'"%@`{}[\],\n]/.test(s) || s.trim() !== s) {
		return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
	}
	return s;
}

export async function POST(context: APIContext) {
	// 鉴权
	const guard = await requireAuth(context);
	if (!isAllowed(guard)) return guard;

	let input: ArticleInput;
	try {
		input = (await context.request.json()) as ArticleInput;
	} catch {
		return jsonError(400, "请求体不是合法 JSON");
	}

	// 基本校验
	const title = (input.title ?? "").trim();
	if (!title) return jsonError(400, "缺少 title");
	const body = (input.body ?? "").trim();
	if (body.length < 1) return jsonError(400, "正文不能为空");
	if (body.length > 2_000_000) return jsonError(400, "正文过大（>2MB）");

	// slug 规范化
	const slugRaw = (input.slug ?? title).trim();
	if (slugRaw.length === 0) return jsonError(400, "缺少 slug");
	if (!/^[a-z0-9-]+$/.test(slugRaw)) {
		return jsonError(400, "slug 仅允许小写字母、数字、连字符");
	}
	const filename = slugRaw.replace(/\.md$/i, "") + ".md";

	// 模式判定
	let env: GhEnv;
	try {
		env = await readGhEnv();
	} catch {
		return jsonError(500, "未配置 GitHub 凭证");
	}

	let mode =
		input.mode === "update" || input.mode === "auto" ? input.mode : "create";
	let existingSha: string | undefined;

	try {
		const existing = await readPost(env, filename);
		if (existing) {
			existingSha = existing.sha;
			if (mode === "create") {
				return jsonError(
					409,
					`文章 ${filename} 已存在，请改用更新模式或换 slug`,
				);
			}
			mode = "update";
		} else {
			if (mode === "update") {
				return jsonError(404, `文章 ${filename} 不存在，无法更新`);
			}
			mode = "create";
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return jsonError(500, "查询文章失败", msg);
	}

	// 拼装最终内容：frontmatter + body
	const content = serializeFrontmatter(input) + body + "\n";

	let writeResult: WriteResult;
	try {
		writeResult = await writePost(
			env,
			filename,
			content,
			mode as "create" | "update",
			existingSha,
			`docs: ${mode === "create" ? "新增" : "更新"}文章《${title}》`,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const detail = e instanceof GhApiError ? e.detail : undefined;
		const status = e instanceof GhApiError && e.status ? e.status : 502;
		return jsonError(status, msg, detail);
	}

	// 触发重建（失败不阻断）
	const hook = await triggerRedeploy(env);

	return json(
		{
			ok: true,
			filename: writeResult.path,
			commit: writeResult.commitSha,
			mode: writeResult.created ? "create" : "update",
			redeploy: hook,
		},
		200,
	);
}
