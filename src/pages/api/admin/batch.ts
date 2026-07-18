import type { APIContext } from "astro";
import {
	type ArticleFields,
	fmArr,
	fmBool,
	fmStr,
	serializeFrontmatter,
	splitArticle,
} from "@/lib/server/frontmatter";
import {
	deletePost,
	GhApiError,
	type GhEnv,
	readGhEnv,
	readPost,
	triggerRedeploy,
	writePost,
} from "@/lib/server/github";
import { isAllowed, requireAuth } from "@/lib/server/guard";
import { json, jsonError } from "@/lib/server/web";

export const prerender = false;

type BatchAction =
	| "delete"
	| "setDraft"
	| "setPinned"
	| "setCategory"
	| "addTag"
	| "removeTag";

interface BatchBody {
	action?: BatchAction;
	/** 文件名列表，如 ["hello.md"] */
	names?: string[];
	/** setDraft / setPinned 的布尔值 */
	value?: boolean;
	/** setCategory / addTag / removeTag 的字符串 */
	text?: string;
}

/**
 * POST：批量操作文章
 * - delete: 批量删除
 * - setDraft / setPinned: 批量改布尔字段
 * - setCategory: 批量改分类
 * - addTag / removeTag: 批量加/删标签
 * 全部完成后统一触发一次重建。
 */
export async function POST(context: APIContext) {
	const guard = await requireAuth(context);
	if (!isAllowed(guard)) return guard;

	let body: BatchBody;
	try {
		body = (await context.request.json()) as BatchBody;
	} catch {
		return jsonError(400, "请求体不是合法 JSON");
	}

	const action = body.action;
	const names = (body.names ?? [])
		.map((n) => String(n).trim())
		.filter((n) => /^[a-z0-9-]+\.md$/.test(n));
	if (!action) return jsonError(400, "缺少 action");
	if (names.length === 0) return jsonError(400, "未选择文章或文件名非法");
	if (names.length > 30) return jsonError(400, "单次最多 30 篇");

	let env: GhEnv;
	try {
		env = await readGhEnv();
	} catch {
		return jsonError(500, "未配置 GitHub 凭证");
	}

	const results: Array<{ name: string; ok: boolean; error?: string }> = [];

	for (const name of names) {
		try {
			if (action === "delete") {
				const file = await readPost(env, name);
				if (!file) {
					results.push({ name, ok: false, error: "不存在" });
					continue;
				}
				await deletePost(env, name, file.sha);
				results.push({ name, ok: true });
				continue;
			}

			// 其余动作：读 → 改 frontmatter → 写回
			const file = await readPost(env, name);
			if (!file) {
				results.push({ name, ok: false, error: "不存在" });
				continue;
			}
			const { fm, body: articleBody } = splitArticle(file.content);
			const fields: ArticleFields = {
				title: fmStr(fm, "title") || name.replace(/\.md$/i, ""),
				published:
					fmStr(fm, "published") || new Date().toISOString().slice(0, 10),
				updated: new Date().toISOString().slice(0, 10),
				draft: fmBool(fm, "draft", false),
				description: fmStr(fm, "description"),
				image: fmStr(fm, "image"),
				tags: fmArr(fm, "tags"),
				category: fmStr(fm, "category"),
				lang: fmStr(fm, "lang"),
				pinned: fmBool(fm, "pinned", false),
				author: fmStr(fm, "author"),
				sourceLink: fmStr(fm, "sourceLink"),
				licenseName: fmStr(fm, "licenseName"),
				licenseUrl: fmStr(fm, "licenseUrl"),
				comment: fmBool(fm, "comment", true),
				password: fmStr(fm, "password"),
				passwordHint: fmStr(fm, "passwordHint"),
			};

			if (action === "setDraft") {
				if (typeof body.value !== "boolean") {
					results.push({ name, ok: false, error: "value 需为 boolean" });
					continue;
				}
				fields.draft = body.value;
			} else if (action === "setPinned") {
				if (typeof body.value !== "boolean") {
					results.push({ name, ok: false, error: "value 需为 boolean" });
					continue;
				}
				fields.pinned = body.value;
			} else if (action === "setCategory") {
				fields.category = (body.text ?? "").trim();
			} else if (action === "addTag") {
				const t = (body.text ?? "").trim();
				if (!t) {
					results.push({ name, ok: false, error: "tag 为空" });
					continue;
				}
				if (!fields.tags?.includes(t))
					fields.tags = [...(fields.tags || []), t];
			} else if (action === "removeTag") {
				const t = (body.text ?? "").trim();
				fields.tags = (fields.tags || []).filter((x) => x !== t);
			} else {
				results.push({ name, ok: false, error: `未知 action: ${action}` });
				continue;
			}

			const content =
				serializeFrontmatter(fields) + articleBody.replace(/^\n/, "");
			await writePost(
				env,
				name,
				content,
				"update",
				file.sha,
				`docs: 批量${action}《${fields.title}》`,
			);
			results.push({ name, ok: true });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const detail = e instanceof GhApiError ? e.detail : undefined;
			results.push({
				name,
				ok: false,
				error: detail ? `${msg}: ${detail}` : msg,
			});
		}
	}

	const okCount = results.filter((r) => r.ok).length;
	// 有成功项才触发一次重建
	const hook =
		okCount > 0
			? await triggerRedeploy(env)
			: { ok: false, detail: "无成功项，跳过重建" };

	return json({
		ok: okCount === results.length,
		okCount,
		total: results.length,
		results,
		redeploy: hook,
	});
}
