import type { APIContext } from "astro";
import {
	deletePost,
	GhApiError,
	type GhEnv,
	readGhEnv,
	readPost,
} from "@/lib/server/github";
import { isAllowed, requireAuth } from "@/lib/server/guard";
import { json, jsonError } from "@/lib/server/web";

export const prerender = false;

/** 极简 frontmatter 解析：仅识别 `key: value` 与 `key: [a, b]`，值含特殊字符时去引号 */
function parseFrontmatter(fm: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const line of fm.split("\n")) {
		const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
		if (!m) continue;
		const [, k, vRaw] = m;
		let v = vRaw.trim();
		if (v === "") {
			out[k] = "";
			continue;
		}
		// 去双引号
		if (v.startsWith('"') && v.endsWith('"'))
			v = v.slice(1, -1).replace(/\\"/g, '"');
		// 数组
		if (v.startsWith("[") && v.endsWith("]")) {
			const inner = v.slice(1, -1).trim();
			out[k] = inner
				? inner
						.split(",")
						.map((s) => s.trim().replace(/^"|"$/g, ""))
						.filter(Boolean)
				: [];
			continue;
		}
		if (v === "true") {
			out[k] = true;
			continue;
		}
		if (v === "false") {
			out[k] = false;
			continue;
		}
		out[k] = v;
	}
	return out;
}

/** 把整篇 .md 拆成 { frontmatter, body } */
function splitArticle(raw: string): {
	fm: Record<string, unknown>;
	body: string;
} {
	const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!m) return { fm: {}, body: raw };
	return { fm: parseFrontmatter(m[1]), body: m[2] };
}

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

	// 返回原文 + 解析后的 frontmatter + sha（更新时需要）
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

	let payload: { name?: string; sha?: string } = {};
	const m = context.url.searchParams;
	const name = m.get("name") || "";
	const sha = m.get("sha") || "";
	if (!name || !sha) {
		// 没有 query 就尝试读 body
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
	return json({ ok: true });
}
