import { bindings, defineConfig, triggers } from "cf/config";

/**
 * Secret-like files were detected but not read or migrated: .dev.vars, .dev.vars.example, dist/server/.dev.vars. Only `secrets.required` entries are migrated.
 * @see https://developers.cloudflare.com/workers/configuration/secrets/
 */

export default defineConfig({
	worker: {
		name: "x-article-hub",
		compatibilityDate: "2026-09-30",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "./src/worker.ts",
		workersDev: true,
		previewUrls: false,
		observability: {
			enabled: true,
			headSamplingRate: 1,
		},
		triggers: [
			triggers.scheduled({
				schedule: "*/30 * * * *",
			}),
			triggers.queue({
				deadLetterQueue: "article-ingest-dlq",
				maxBatchSize: 10,
				maxBatchTimeout: 30,
				maxRetries: 5,
				name: "article-ingest",
			}),
			triggers.queue({
				maxBatchSize: 5,
				maxBatchTimeout: 30,
				maxRetries: 5,
				name: "article-process",
			}),
		],
		env: {
			SITE_NAME: bindings.text("X Article Hub"),
			SITE_ORIGIN: bindings.text("https://x-article-hub.zachzhao.workers.dev"),
			RANKING_WEIGHTS_JSON: bindings.text("{\"popularity\":0.57,\"quality\":0.29,\"editor\":0.14}"),
			MAX_IMPORT_URLS: bindings.text("200"),
			CRAWL_SCREENSHOT: bindings.text("false"),
			DB: bindings.d1({
				name: "x-article-hub",
				id: "61f1e63b-4097-49fb-a99d-1f05dcb69ad9",
			}),
			ARCHIVE: bindings.r2({
				name: "x-article-archive",
			}),
			ARTICLE_INGEST_QUEUE: bindings.queue({
				name: "article-ingest",
			}),
			ARTICLE_PROCESS_QUEUE: bindings.queue({
				name: "article-process",
			}),
			ARTICLE_METRICS_QUEUE: bindings.queue({
				name: "article-metrics",
			}),
			AI: bindings.ai({}),
			BROWSER: bindings.browser({
				dev: {
					remote: true,
				},
			}),
			ASSETS: bindings.assets(),
		},
	},
});
