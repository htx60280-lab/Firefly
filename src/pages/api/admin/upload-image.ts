import type { APIContext } from "astro";
import {
	GhApiError,
	type GhEnv,
	readGhEnv,
	uploadImage,
} from "@/lib/server/github";
import { isAllowed, requireAuth } from "@/lib/server/guard";
import { json, jsonError } from "@/lib/server/web";

export const prerender = false;

/**
 * POST：上传图片到仓内 src/content/posts/images/
 * 入参：multipart/form-data，字段 file=<二进制>
 * 返回：仓库内相对路径，前端可拼成图片引用插入正文
 * 返回路径需在正文里用形如 `![](./images/xxx.avif)` 或绝对 `/...` 。
 */
export async function POST(context: APIContext) {
	const guard = await requireAuth(context);
	if (!isAllowed(guard)) return guard;

	let formData: FormData;
	try {
		formData = await context.request.formData();
	} catch {
		return jsonError(400, "需要 multipart/form-data");
	}
	const file = formData.get("file");
	if (!(file instanceof File)) return jsonError(400, "缺少 file 字段");
	if (file.size > 8 * 1024 * 1024) return jsonError(400, "图片大于 8MB");
	if (!file.type.startsWith("image/")) return jsonError(400, "仅允许图片");

	const buf = new Uint8Array(await file.arrayBuffer());
	let base64 = "";
	let bin = "";
	for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
	base64 = btoa(bin);

	let env: GhEnv;
	try {
		env = await readGhEnv();
	} catch {
		return jsonError(500, "未配置 GitHub 凭证");
	}

	try {
		const r = await uploadImage(env, file.name, base64);
		// 文章正文里引用相对仓库的路径：assets 路径以 src 为根时 Astro 解析
		// 这里返回可被 Astro 图片优化加载的 src 路径写法
		const ref = r.path.replace(/^src\//, ""); // "content/posts/images/x.avif"
		return json({ ok: true, ref: `assets/${ref}`, path: r.path });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const detail = e instanceof GhApiError ? e.detail : undefined;
		const status = e instanceof GhApiError && e.status ? e.status : 502;
		return jsonError(status, msg, detail);
	}
}
