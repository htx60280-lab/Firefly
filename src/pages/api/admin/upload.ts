import type { APIContext } from "astro";
import {
	type ArticleFields,
	serializeFrontmatter,
} from "@/lib/server/frontmatter";
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

/** 中文/任意标题 → 可用 slug（优先拉丁，失败用时间戳） */
function slugify(raw: string): string {
	const s = raw
		.trim()
		.toLowerCase()
		// 保留中日韩、字母数字，其余转 -
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		// 文件名仅允许 a-z0-9-：把非 ascii 转成短 hash 后缀
		.replace(/[^a-z0-9-]/g, "");
	if (s && s.length >= 2) return s.slice(0, 60);
	// 纯中文标题：用 post-时间戳
	const stamp = Date.now().toString(36);
	return `post-${stamp}`;
}

export async function POST(context: APIContext) {
	const guard = await requireAuth(context);
	if (!isAllowed(guard)) return guard;

	let input: ArticleFields;
	try {
		input = (await context.request.json()) as ArticleFields;
	} catch {
		return jsonError(400, "请求体不是合法 JSON");
	}

	const title = (input.title ?? "").trim();
	if (!title) return jsonError(400, "缺少 title");
	const body = (input.body ?? "").trim();
	if (body.length < 1) return jsonError(400, "正文不能为空");
	if (body.length > 2_000_000) return jsonError(400, "正文过大（>2MB）");

	// slug：优先用客户端给的（编辑态锁定），否则从标题推
	let slugRaw = (input.slug ?? "").trim().toLowerCase().replace(/\.md$/i, "");
	if (!slugRaw) slugRaw = slugify(title);
	// 再规范化一次，只留 a-z0-9-
	slugRaw = slugRaw
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (!slugRaw) return jsonError(400, "slug 为空，请手动指定文件名");
	if (!/^[a-z0-9-]+$/.test(slugRaw)) {
		return jsonError(400, "slug 仅允许小写字母、数字、连字符");
	}
	const filename = `${slugRaw}.md`;

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

	// 保存时自动补 updated（编辑）
	const fields: ArticleFields = {
		...input,
		title,
		// tags/category 清理空白
		tags: (input.tags ?? []).map((t) => String(t).trim()).filter(Boolean),
		category: (input.category ?? "").trim(),
	};
	if (mode === "update" && !fields.updated) {
		fields.updated = new Date().toISOString().slice(0, 10);
	}

	const content = serializeFrontmatter(fields) + body + "\n";

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
