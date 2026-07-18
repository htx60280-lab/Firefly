import type { APIContext } from "astro";
import { splitArticle } from "@/lib/server/frontmatter";
import {
	deletePost,
	GhApiError,
	type GhEnv,
	readGhEnv,
	readPost,
	triggerRedeploy,
} from "@/lib/server/github";
import { isAllowed, requireAuth } from "@/lib/server/guard";
import { json, jsonError } from "@/lib/server/web";

export const prerender = false;

/** GET：读单篇，回填编辑器 */
export async function GET(context: APIContext) {
	const guard = await requireAuth(context);
	if (!isAllowed(guard)) return guard;

	const url = new URL(context.request.url);
	const name = url.searchParams.get("name") || "";
	if (!name) return jsonError(400, "缺少 name 参数");
	if (!/^[a-z0-9-]+\.md$/.test(name)) return jsonError(400, "name 非法");

	let env: GhEnv;
	try {
		env = await readGhEnv();
	} catch {
		return jsonError(500, "未配置 GitHub 凭证");
	}

	let file: Awaited<ReturnType<typeof readPost>>;
	try {
		file = await readPost(env, name);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return jsonError(502, "读取文章失败", msg);
	}
	if (!file) return jsonError(404, "文章不存在");

	const { fm, body } = splitArticle(file.content);
	return json({
		name,
		sha: file.sha,
		raw: file.content,
		frontmatter: fm,
		body,
	});
}

/** DELETE：删除文章（需带 sha） */
export async function DELETE(context: APIContext) {
	const guard = await requireAuth(context);
	if (!isAllowed(guard)) return guard;

	let payload: { name?: string; sha?: string; redeploy?: boolean } = {};
	const m = context.url.searchParams;
	const name = m.get("name") || "";
	const sha = m.get("sha") || "";
	if (!name || !sha) {
		try {
			payload = await context.request.json();
		} catch {
			/* ignore */
		}
	}
	const fn = name || payload.name || "";
	const sh = sha || payload.sha || "";
	if (!fn || !/^[a-z0-9-]+\.md$/.test(fn)) return jsonError(400, "name 非法");
	if (!sh) return jsonError(400, "删除需提供 sha");

	let env: GhEnv;
	try {
		env = await readGhEnv();
	} catch {
		return jsonError(500, "未配置 GitHub 凭证");
	}

	try {
		await deletePost(env, fn, sh);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const detail = e instanceof GhApiError ? e.detail : undefined;
		const status = e instanceof GhApiError && e.status ? e.status : 502;
		return jsonError(status, msg, detail);
	}

	// 默认触发重建；客户端可传 redeploy=false 批量时只最后一次触发
	const doRedeploy = payload.redeploy !== false && m.get("redeploy") !== "0";
	const hook = doRedeploy
		? await triggerRedeploy(env)
		: { ok: true, detail: "跳过重建（批量）" };

	return json({ ok: true, redeploy: hook });
}
