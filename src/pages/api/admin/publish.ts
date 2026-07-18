import type { APIContext } from "astro";
import {
	type ArticleFields,
	serializeFrontmatter,
} from "@/lib/server/frontmatter";
import {
	type BatchFileOp,
	commitMultiple,
	GhApiError,
	type GhEnv,
	postPath,
	readGhEnv,
	triggerRedeploy,
} from "@/lib/server/github";
import { isAllowed, requireAuth } from "@/lib/server/guard";
import { json, jsonError } from "@/lib/server/web";

export const prerender = false;

/**
 * 待发布条目（前端 localStorage 暂存后统一提交）
 * - upsert: 新增或覆盖一篇文章
 * - delete: 删除一篇文章
 */
type PublishItem =
	| {
			op: "upsert";
			/** 文件名 hello.md 或 slug hello */
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
	  }
	| {
			op: "delete";
			name: string;
	  };

interface PublishBody {
	items?: PublishItem[];
	/** 自定义 commit 信息 */
	message?: string;
}

function normalizeName(name: string): string {
	let n = name.trim().toLowerCase().replace(/\.md$/i, "");
	n = n
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (!n) throw new Error("文件名非法");
	return `${n}.md`;
}

/** POST：把多篇暂存变更合并为一次 Git commit 并触发构建 */
export async function POST(context: APIContext) {
	const guard = await requireAuth(context);
	if (!isAllowed(guard)) return guard;

	let body: PublishBody;
	try {
		body = (await context.request.json()) as PublishBody;
	} catch {
		return jsonError(400, "请求体不是合法 JSON");
	}

	const items = body.items ?? [];
	if (items.length === 0) return jsonError(400, "没有待发布的变更");
	if (items.length > 40) return jsonError(400, "单次最多 40 条变更");

	// 同名以最后一条为准
	const byName = new Map<string, PublishItem>();
	try {
		for (const it of items) {
			const name = normalizeName(it.name);
			byName.set(name, { ...it, name });
		}
	} catch (e) {
		return jsonError(400, e instanceof Error ? e.message : "文件名非法");
	}

	const ops: BatchFileOp[] = [];
	const summary: string[] = [];

	for (const [name, it] of byName) {
		const path = postPath(name);
		if (it.op === "delete") {
			ops.push({ path, op: "delete" });
			summary.push(`删 ${name}`);
			continue;
		}
		const title = (it.title ?? "").trim();
		if (!title) return jsonError(400, `${name}: 缺少 title`);
		const articleBody = (it.body ?? "").trim();
		if (!articleBody) return jsonError(400, `${name}: 正文不能为空`);
		if (articleBody.length > 2_000_000)
			return jsonError(400, `${name}: 正文过大`);

		const fields: ArticleFields = {
			title,
			published: it.published,
			updated: it.updated || new Date().toISOString().slice(0, 10),
			draft: it.draft,
			description: it.description,
			image: it.image,
			tags: (it.tags ?? []).map((t) => String(t).trim()).filter(Boolean),
			category: (it.category ?? "").trim(),
			lang: it.lang,
			pinned: it.pinned,
			author: it.author,
			sourceLink: it.sourceLink,
			licenseName: it.licenseName,
			licenseUrl: it.licenseUrl,
			comment: it.comment,
			password: it.password,
			passwordHint: it.passwordHint,
		};
		const content = serializeFrontmatter(fields) + articleBody + "\n";
		ops.push({ path, op: "upsert", content });
		summary.push(`${it.draft ? "草稿" : "发布"} ${name}`);
	}

	let env: GhEnv;
	try {
		env = await readGhEnv();
	} catch {
		return jsonError(500, "未配置 GitHub 凭证");
	}

	const msg =
		(body.message ?? "").trim() ||
		`docs: 后台发布 ${ops.length} 项（${summary.slice(0, 5).join("；")}${summary.length > 5 ? "…" : ""}）`;

	let result: Awaited<ReturnType<typeof commitMultiple>>;
	try {
		result = await commitMultiple(env, ops, msg);
	} catch (e) {
		const m = e instanceof Error ? e.message : String(e);
		const detail = e instanceof GhApiError ? e.detail : undefined;
		const status = e instanceof GhApiError && e.status ? e.status : 502;
		return jsonError(status, m, detail);
	}

	const hook = await triggerRedeploy(env);

	return json({
		ok: true,
		commit: result.commitSha,
		changed: result.changed,
		summary,
		redeploy: hook,
	});
}
