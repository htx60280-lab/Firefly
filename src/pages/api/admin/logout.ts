import type { APIContext } from "astro";
import { COOKIE_NAME } from "@/lib/server/auth";
import { json } from "@/lib/server/web";

export const prerender = false;

/** 退出登录：清空签名 cookie。无需鉴权——无论是否登录都直接清 */
export async function POST(context: APIContext) {
	context.cookies.delete(COOKIE_NAME, { path: "/" });
	return json({ ok: true });
}
