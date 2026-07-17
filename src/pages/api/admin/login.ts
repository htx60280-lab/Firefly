import type { APIContext } from "astro";
import {
	type AuthEnv,
	COOKIE_NAME,
	clearFail,
	nowSeconds,
	readAuthEnv,
	recordFail,
	safeEqual,
	signToken,
	verifyToken,
} from "@/lib/server/auth";
import { clientIP, json, jsonError } from "@/lib/server/web";

// 运行时端点：CF Workers adapter 下编译为 Worker fetch handler
export const prerender = false;

export async function POST({ request, cookies }: APIContext) {
	let payload: { password?: string } = {};
	try {
		const raw = await request.text();
		payload = raw ? JSON.parse(raw) : {};
	} catch {
		return jsonError(400, "请求体不是合法 JSON");
	}

	const supplied = String(payload.password ?? "").trim();
	const ip = clientIP(request);

	let cfg: AuthEnv;
	try {
		cfg = await readAuthEnv();
	} catch {
		// 不暴露密码是否配置，统一返回 500 对外口径
		return jsonError(500, "服务未正确配置鉴权");
	}

	if (!supplied) {
		return jsonError(400, "请输入密码");
	}

	// 失败计数（先检查是否已被限流）
	const fail = recordFail(ip);
	if (fail.blocked) {
		return new Response(
			JSON.stringify({
				error: "尝试过于频繁，请稍后再来",
				detail: `retry-after ${fail.retryAfter}s`,
			}),
			{
				status: 429,
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"Retry-After": String(fail.retryAfter),
				},
			},
		);
	}

	if (!safeEqual(supplied, cfg.password)) {
		recordFail(ip);
		return jsonError(401, "密码错误");
	}

	clearFail(ip);

	// 颁发签名 cookie
	const token = await signToken(cfg, nowSeconds());
	cookies.set(COOKIE_NAME, token, {
		httpOnly: true,
		secure: true,
		sameSite: "strict",
		path: "/",
		maxAge: cfg.ttlSeconds,
	});

	return json({ ok: true, message: "登录成功" }, 200);
}

export async function GET({ cookies }: APIContext) {
	// GET 用于快速校验当前是否已登录：让前端判断显示登录框还是后台
	let cfg: AuthEnv;
	try {
		cfg = await readAuthEnv();
	} catch {
		return jsonError(500, "服务未正确配置鉴权");
	}
	const token = cookies.get(COOKIE_NAME)?.value;
	const ok = await verifyToken(token, cfg, nowSeconds());
	return json({ ok }, ok ? 200 : 401);
}
