/** API 端点共用：统一 JSON 响应 + 错误封装 + IP 提取 */

export function json(
	data: unknown,
	status = 200,
	headers?: Record<string, string>,
): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			...headers,
		},
	});
}

/** 统一错误返回，msg 对前端可见，detail 仅在明文可观测（敏感信息应由调用方包装） */
export function jsonError(
	status: number,
	msg: string,
	detail?: string,
): Response {
	return json({ error: msg, detail }, status);
}

/** 取请求 IP：优先 Cloudflare 提供的头 */
export function clientIP(request: Request): string {
	const h = request.headers;
	return (
		h.get("cf-connecting-ip") ||
		h.get("x-real-ip") ||
		(h.get("x-forwarded-for") || "").split(",")[0].trim() ||
		"unknown"
	);
}
