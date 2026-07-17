import type { APIContext } from "astro";
import { type GhEnv, listPosts, readGhEnv } from "@/lib/server/github";
import { isAllowed, requireAuth } from "@/lib/server/guard";
import { json, jsonError } from "@/lib/server/web";

export const prerender = false;

/** GET：列出仓内现有文章（供后台列表与查重） */
export async function GET(context: APIContext) {
	const guard = await requireAuth(context);
	if (!isAllowed(guard)) return guard;

	let env: GhEnv;
	try {
		env = await readGhEnv();
	} catch {
		return jsonError(500, "未配置 GitHub 凭证");
	}

	try {
		const posts = await listPosts(env);
		return json({
			posts: posts.map((p) => ({ name: p.name, path: p.path, size: p.size })),
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return jsonError(502, "列出文章失败", msg);
	}
}
