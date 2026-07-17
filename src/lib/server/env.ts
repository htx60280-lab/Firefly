/**
 * 运行时环境变量统一读取入口
 *
 * 背景：Astro 7 + @astrojs/cloudflare adapter 已移除 Astro.locals.runtime。
 * 访问 CF 绑定的 secrets/环境变量，官方推荐 `import { env } from 'cloudflare:workers'`。
 * 但该模块仅在 Workers 运行时存在，本地 `astro dev` 下不存在。
 *
 * 读取顺序（优先级从高到低）：
 * 1. cloudflare:workers 的 env（线上 Workers 运行时，绑定/secrets 都在这里）
 * 2. process.env（dev 下 Node 进程环境；CF Workers nodejs_compat 时也可用）
 * 3. 手动 loadEnv('.env')（dev 下补齐项目根 .env 文件，Astro/Vite 不自动注入 process.env）
 *
 * 本地 dev 场景：1 不存在 → 2 通常拿不到 .env（Vite 不把非 VITE_ 前缀变量塞进 process.env）→ 3 兜底加载 .env。
 */

let cachedEnv: Record<string, unknown> | null = null;
let probed = false;

export async function getRuntimeEnv(): Promise<Record<string, unknown>> {
	if (probed) return cachedEnv || (process.env as Record<string, unknown>);
	probed = true;
	try {
		// @ts-expect-error cloudflare:workers 仅在 Workers 运行时存在，dev 时不存在
		const mod = await import("cloudflare:workers");
		cachedEnv = (mod.env ?? {}) as Record<string, unknown>;
	} catch {
		cachedEnv = null;
	}
	// 回退：合并 process.env + 手动加载 .env（dev 下 .env 不会自动进 process.env）
	if (!cachedEnv) {
		const fromDotEnv = await loadDotEnv();
		cachedEnv = {
			...(fromDotEnv as Record<string, unknown>),
			...(process.env as Record<string, unknown>),
		};
	}
	return cachedEnv || (process.env as Record<string, unknown>);
}

/** 本地 dev 兜底：用 Vite loadEnv 读取项目根 .env（不覆盖已有 process.env） */
async function loadDotEnv(): Promise<Record<string, unknown>> {
	try {
		// vite 仅在构建/dev 工具链可用，Workers 运行时无此模块——动态 import 在线上会 reject 走 catch
		const { loadEnv } = await import("vite");
		// mode 用 NODE_ENV 或 dev；loadEnv 会读 .env / .env.[mode] / .env.local
		const mode = (process.env.NODE_ENV as string) || "development";
		// 第三个参数 '' 表示不过滤前缀（默认只取 VITE_ 前缀）
		const env = loadEnv(mode, process.cwd(), "");
		return env as Record<string, unknown>;
	} catch {
		return {};
	}
}
