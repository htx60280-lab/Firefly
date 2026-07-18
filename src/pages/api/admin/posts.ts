import type { APIContext } from "astro";
import { fmArr, fmBool, fmStr, splitArticle } from "@/lib/server/frontmatter";
import {
	type GhEnv,
	listPosts,
	readGhEnv,
	readPost,
} from "@/lib/server/github";
import { isAllowed, requireAuth } from "@/lib/server/guard";
import { json, jsonError } from "@/lib/server/web";

export const prerender = false;

/**
 * GET：列出仓内现有文章（含 frontmatter 摘要 + 聚合出的分类/标签列表）
 * 为避免 N 次串行过慢，并发读最多 8 篇一组。
 */
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
		const files = await listPosts(env);
		const posts: Array<{
			name: string;
			path: string;
			size?: number;
			sha: string;
			title: string;
			published: string;
			category: string;
			tags: string[];
			draft: boolean;
			pinned: boolean;
			description: string;
		}> = [];

		const categories = new Set<string>();
		const tags = new Set<string>();

		// 并发读取 frontmatter（限制并发）
		const CONCURRENCY = 8;
		for (let i = 0; i < files.length; i += CONCURRENCY) {
			const chunk = files.slice(i, i + CONCURRENCY);
			const results = await Promise.all(
				chunk.map(async (f) => {
					try {
						const file = await readPost(env, f.name);
						if (!file) {
							return {
								name: f.name,
								path: f.path,
								size: f.size,
								sha: f.sha || "",
								title: f.name.replace(/\.md$/i, ""),
								published: "",
								category: "",
								tags: [] as string[],
								draft: false,
								pinned: false,
								description: "",
							};
						}
						const { fm } = splitArticle(file.content);
						const cat = fmStr(fm, "category");
						const tgs = fmArr(fm, "tags");
						if (cat) categories.add(cat);
						for (const t of tgs) tags.add(t);
						return {
							name: f.name,
							path: f.path,
							size: f.size,
							sha: file.sha,
							title: fmStr(fm, "title") || f.name.replace(/\.md$/i, ""),
							published: fmStr(fm, "published"),
							category: cat,
							tags: tgs,
							draft: fmBool(fm, "draft", false),
							pinned: fmBool(fm, "pinned", false),
							description: fmStr(fm, "description"),
						};
					} catch {
						return {
							name: f.name,
							path: f.path,
							size: f.size,
							sha: f.sha || "",
							title: f.name.replace(/\.md$/i, ""),
							published: "",
							category: "",
							tags: [] as string[],
							draft: false,
							pinned: false,
							description: "",
						};
					}
				}),
			);
			posts.push(...results);
		}

		// 最新发布优先，无日期的排后
		posts.sort((a, b) => (b.published || "").localeCompare(a.published || ""));

		return json({
			posts,
			categories: Array.from(categories).sort((a, b) =>
				a.localeCompare(b, "zh"),
			),
			tags: Array.from(tags).sort((a, b) => a.localeCompare(b, "zh")),
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return jsonError(502, "列出文章失败", msg);
	}
}
