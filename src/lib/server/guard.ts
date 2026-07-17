import type { APIContext } from "astro";
import {
	type AuthEnv,
	COOKIE_NAME,
	nowSeconds,
	readAuthEnv,
	verifyToken,
} from "@/lib/server/auth";
import { jsonError } from "@/lib/server/web";

/**
 * 端点级鉴权守卫：校验签名 cookie。
 * 失败返回 401 响应（可直接 return）；成功返回 null 并（可选）暴露 cfg。
 * 配置缺失返回 500，对前端统一不泄漏内部细节。
 */
export async function requireAuth(context: APIContext): Promise<Response> {
	const cookies = context.cookies;
	const request = context.request;
	let cfg: AuthEnv;
	try {
		cfg = await readAuthEnv();
	} catch {
		return jsonError(500, "服务未正确配置鉴权");
	}
	const token = cookies.get(COOKIE_NAME)?.value;
	const ok = await verifyToken(token, cfg, nowSeconds());
	if (!ok) {
		// 请求带 Accept: application/json 时给 JSON，便于 fetch 调用方
		const wantsJson = (request.headers.get("accept") || "").includes(
			"application/json",
		);
		if (wantsJson) return jsonError(401, "未登录或会话已过期");
		return new Response("Unauthorized", { status: 401 });
	}
	return new Response(null, { status: 200 }); // sentinel: 通过
}

/** 判断守卫是否放行：status === 200 视为通过 */
export function isAllowed(r: Response): boolean {
	return r.status === 200;
}
