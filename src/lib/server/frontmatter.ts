/**
 * 文章 frontmatter 解析 / 序列化（后台 API 共用）
 * 与 content.config.ts schema 对齐；避免双重引号污染。
 */

export interface ArticleFields {
	slug?: string;
	title?: string;
	published?: string;
	updated?: string;
	draft?: boolean;
	description?: string;
	image?: string;
	tags?: string[];
	category?: string;
	lang?: string;
	pinned?: boolean;
	author?: string;
	sourceLink?: string;
	licenseName?: string;
	licenseUrl?: string;
	comment?: boolean;
	password?: string;
	passwordHint?: string;
	body?: string;
	mode?: "create" | "update" | "auto";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 去掉外层成对引号，并剥掉历史双重引号残留（如 "'公告'" → 公告） */
export function stripQuotes(s: string): string {
	let v = s.trim();
	// 循环剥离外层 "..." 或 '...'
	for (let i = 0; i < 3; i++) {
		if (
			(v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
			(v.startsWith("'") && v.endsWith("'") && v.length >= 2)
		) {
			v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").trim();
			continue;
		}
		break;
	}
	return v;
}

/** YAML 标量：仅在必要时加双引号（含特殊字符 / 空格首尾 / 布尔字面量） */
export function yamlScalar(s: string): string {
	const v = stripQuotes(s);
	if (v === "") return '""';
	// 避免把 true/false/null 等写成裸字面量导致解析成布尔
	if (/^(true|false|null|yes|no|on|off)$/i.test(v)) {
		return `"${v}"`;
	}
	if (/[:#&*!|>'"%@`{}[\],\n\\]/.test(v) || v.trim() !== v || /^\d/.test(v)) {
		return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return v;
}

export function serializeFrontmatter(input: ArticleFields): string {
	const today = new Date().toISOString().slice(0, 10);
	const fields: Array<[string, string]> = [];
	const push = (k: string, v: unknown) => {
		if (v === undefined || v === null) return;
		if (typeof v === "string") {
			const cleaned = stripQuotes(v);
			// 空字符串仍写出，保证 schema 默认字段稳定
			fields.push([k, cleaned === "" ? '""' : yamlScalar(cleaned)]);
		} else if (typeof v === "boolean" || typeof v === "number") {
			fields.push([k, String(v)]);
		} else if (Array.isArray(v)) {
			const items = v
				.map((x) => stripQuotes(String(x)))
				.filter((x) => x.length > 0);
			fields.push([
				k,
				items.length ? `[${items.map(yamlScalar).join(", ")}]` : "[]",
			]);
		}
	};

	push("title", (input.title ?? "").trim() || "Untitled");
	push(
		"published",
		DATE_RE.test(input.published ?? "") ? input.published : today,
	);
	if (input.updated && DATE_RE.test(input.updated))
		push("updated", input.updated);
	push("draft", input.draft ?? false);
	push("description", input.description ?? "");
	push("image", input.image ?? "");
	push("tags", input.tags ?? []);
	push("category", input.category ?? "");
	push("lang", input.lang ?? "");
	push("pinned", input.pinned ?? false);
	push("author", input.author ?? "");
	push("sourceLink", input.sourceLink ?? "");
	push("licenseName", input.licenseName ?? "");
	push("licenseUrl", input.licenseUrl ?? "");
	push("comment", input.comment ?? true);
	// 密码空则不写，避免无意义加密字段
	if (input.password && String(input.password).trim()) {
		push("password", input.password);
		push("passwordHint", input.passwordHint ?? "");
	}

	return `---\n${fields.map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n`;
}

/** 极简 frontmatter 解析 */
export function parseFrontmatter(fm: string): Record<string, unknown> {
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
		// 数组
		if (v.startsWith("[") && v.endsWith("]")) {
			const inner = v.slice(1, -1).trim();
			out[k] = inner
				? inner
						.split(",")
						.map((s) => stripQuotes(s.trim()))
						.filter(Boolean)
				: [];
			continue;
		}
		// 去引号
		v = stripQuotes(v);
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

export function splitArticle(raw: string): {
	fm: Record<string, unknown>;
	body: string;
} {
	const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!m) return { fm: {}, body: raw };
	return { fm: parseFrontmatter(m[1]), body: m[2] };
}

/** 从 frontmatter 对象安全取字符串 / 数组 */
export function fmStr(
	fm: Record<string, unknown>,
	key: string,
	d = "",
): string {
	const v = fm[key];
	if (typeof v === "string") return stripQuotes(v);
	if (v == null) return d;
	return stripQuotes(String(v));
}

export function fmBool(
	fm: Record<string, unknown>,
	key: string,
	d = false,
): boolean {
	const v = fm[key];
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v === "true";
	return d;
}

export function fmArr(fm: Record<string, unknown>, key: string): string[] {
	const v = fm[key];
	if (Array.isArray(v))
		return v.map((x) => stripQuotes(String(x))).filter(Boolean);
	if (typeof v === "string" && v.trim()) return [stripQuotes(v)];
	return [];
}
