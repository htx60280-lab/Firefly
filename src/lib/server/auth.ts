/**
 * 鉴权复用模块 —— 单用户、无服务端存储
 *
 * 策略：登录校验密码后，下发一个 HMAC-SHA256 自包含签名 token（payload = {exp}），
 * 存进 HttpOnly Secure SameSite=Strict cookie。后续请求由中间件校验签名 + 过期。
 * 无需 KV/D1，适配 Cloudflare Workers 无状态运行时。
 *
 * 密钥复用 ADMIN_PASSWORD（个人博客够用）；如要更强隔离可独立配 AUTH_SECRET。
 * 失败计数用模块级 Map（实例内存，单 Worker 实例内有效，重启即清——
 * 主要用于拖慢爆破，精确封禁不靠它）。
 */

// Cloudflare Workers 提供 Web Crypto，不依赖 Node crypto
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(input: ArrayBuffer | Uint8Array): string {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
	const s = str.replace(/-/g, "+").replace(/_/g, "/");
	const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
	const bin = atob(s + "===".slice(0, pad));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export interface AuthConfig {
	password: string;
	/** cookie 有效期，秒，默认 7 天 */
	ttlSeconds?: number;
	/** HMAC 密钥，默认复用 password */
	secret?: string;
}

export const COOKIE_NAME = "volant_admin";

/** readAuthEnv 的返回类型，供端点声明 let 变量时标注 */
export interface AuthEnv {
	password: string;
	secret: string;
	ttlSeconds: number;
}

/** 读取鉴权所需环境变量。异步以兼容 cloudflare:workers 与本地 process.env。 */
export async function readAuthEnv(): Promise<AuthEnv> {
	const { getRuntimeEnv } = await import("@/lib/server/env");
	const env = await getRuntimeEnv();
	const password = String(env.ADMIN_PASSWORD ?? "").trim();
	if (!password) {
		throw new AuthConfigError("ADMIN_PASSWORD 未配置");
	}
	// 可选：自定义会话有效期（秒），默认 7 天
	const ttlRaw = String(env.ADMIN_TTL_SECONDS ?? "").trim();
	const ttlSeconds =
		Number.isFinite(Number(ttlRaw)) && Number(ttlRaw) > 0
			? Number(ttlRaw)
			: 7 * 24 * 3600;
	return {
		password,
		secret: String(env.AUTH_SECRET ?? "").trim() || password,
		ttlSeconds,
	};
}

/** 鉴权未配置/配置错误的明确错误类型，便于端点统一返回 500 且不泄漏细节。 */
export class AuthConfigError extends Error {}

/**
 * 签发自包含 token：base64url(payload) + "." + base64url(hmac)
 * payload = { exp: 秒级时间戳 }
 */
export async function signToken(
	cfg: AuthConfig,
	nowSeconds: number,
): Promise<string> {
	const ttl = cfg.ttlSeconds ?? 7 * 24 * 3600;
	const secret = cfg.secret ?? cfg.password;
	const payload = b64url(enc.encode(JSON.stringify({ exp: nowSeconds + ttl })));
	const key = await hmacKey(secret);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
	return `${payload}.${b64url(sig)}`;
}

/** 校验 token：签名正确且未过期返回 true。任何异常一律视为失败 */
export async function verifyToken(
	token: string | undefined | null,
	cfg: AuthConfig,
	nowSeconds: number,
): Promise<boolean> {
	if (!token || typeof token !== "string") return false;
	const dot = token.lastIndexOf(".");
	if (dot <= 0 || dot === token.length - 1) return false;
	const payload = token.slice(0, dot);
	const sigPart = token.slice(dot + 1);
	const secret = cfg.secret ?? cfg.password;
	const key = await hmacKey(secret);
	let ok = false;
	try {
		const expected = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
		const got = b64urlDecode(sigPart);
		const exp = new Uint8Array(expected);
		if (exp.length !== got.length) return false;
		let diff = 0;
		for (let i = 0; i < exp.length; i++) diff |= exp[i] ^ got[i];
		if (diff !== 0) return false;
		ok = true;
	} catch {
		return false;
	}
	if (!ok) return false;
	try {
		const payloadObj = JSON.parse(dec.decode(b64urlDecode(payload))) as {
			exp?: number;
		};
		if (typeof payloadObj.exp !== "number") return false;
		return nowSeconds < payloadObj.exp;
	} catch {
		return false;
	}
}

/** 失败计数：按 IP，模块级 Map，重在拖慢爆破，不做精确封禁 */
const failMap = new Map<string, { count: number; firstAt: number }>();
const FAIL_WINDOW = 5 * 60; // 5 分钟窗口
const FAIL_THRESHOLD = 8; // 窗口内 8 次后限流

export function recordFail(ip: string): {
	blocked: boolean;
	retryAfter: number;
} {
	const now = Math.floor(Date.now() / 1000);
	const entry = failMap.get(ip);
	if (!entry || now - entry.firstAt > FAIL_WINDOW) {
		failMap.set(ip, { count: 1, firstAt: now });
		return { blocked: false, retryAfter: 0 };
	}
	entry.count += 1;
	if (entry.count >= FAIL_THRESHOLD) {
		const retryAfter = FAIL_WINDOW - (now - entry.firstAt);
		return { blocked: true, retryAfter: Math.max(1, retryAfter) };
	}
	return { blocked: false, retryAfter: 0 };
}

export function clearFail(ip: string): void {
	failMap.delete(ip);
}

/** 单次恒定时间比较，避免计时侧信道 */
export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** 当前秒级时间戳（单独函数便于测试 mock；运行时直接用 Date） */
export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** 解析请求 cookie 字符串取指定值 */
export function parseCookies(
	cookieHeader: string | null,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!cookieHeader) return out;
	for (const part of cookieHeader.split(";")) {
		const idx = part.indexOf("=");
		if (idx <= 0) continue;
		const k = part.slice(0, idx).trim();
		const v = part.slice(idx + 1).trim();
		if (k) out[k] = v;
	}
	return out;
}
