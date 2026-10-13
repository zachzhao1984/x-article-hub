# Current_Spec —— X Article Hub 现状规格

> 这份文档描述**代码里真实存在的东西**，不是它应该成为的样子。
>
> 原始的 `x-article-curated-site-development-spec.md` 是一份设计文档（53 个编号章节，v1.0），它描述了一个目标架构。本文档的作用是：当两者不一致时，**以本文档为准**，因为本文档的每一条都对着生产环境核对过。
>
> 每条"未接线""已知缺陷"都是实测结论，不是推测。核对时间：2026-10-08，`e1da21a`。
>
> **本文档不含任何凭据。** 生产环境有 4 个 secret，全部以 `wrangler secret put` 存放，不在仓库内。

---

## 目录

1. [一句话概括](#1-一句话概括)
2. [运行形态与绑定](#2-运行形态与绑定)
3. [请求路径](#3-请求路径)
4. [数据模型](#4-数据模型)
5. [导入流水线](#5-导入流水线)
6. [抓取](#6-抓取)
7. [解析](#7-解析)
8. [媒体管线](#8-媒体管线)
9. [视频：目前没有任何处理](#9-视频目前没有任何处理)
10. [公开站与缓存](#10-公开站与缓存)
11. [榜单：四个里有三个完全相同](#11-榜单四个里有三个完全相同)
12. [分类：固定五项，运行时不可写](#12-分类固定五项运行时不可写)
13. [账号与 admin 鉴权](#13-账号与-admin-鉴权)
14. [搜索](#14-搜索)
15. [测试与验收](#15-测试与验收)
16. [已知缺陷清单](#16-已知缺陷清单)
17. [未接线与死代码](#17-未接线与死代码)
18. [运维手册](#18-运维手册)

---

## 1. 一句话概括

一个 Cloudflare Worker 上的 Astro SSR 站点：**人工粘贴 X Article 链接 → 抓取归档到 R2 → 解析成结构化文档 → 人工审核发布 → 公开可搜索阅读**。

生产地址 `https://x-article-hub.zachzhao.workers.dev`，约 19,200 行代码，30 次提交。

**当前库存（实测）：** 16 篇文章 / 15 已发布 / 13 篇 featured、6 位作者、83 个媒体对象、41 个解析版本、82 条策展事件、**0 条 metrics**、23 个标签、**0 个用户表历史遗留**、1 个账号（站长的）。

其中 **9 篇有分类，全部由人工指定；6 篇没有分类**。`category_id` 列（设计上给 AI 用）**16 篇全为 NULL**。

---

## 2. 运行形态与绑定

### 2.1 绑定

```jsonc
// wrangler.jsonc
name: "x-article-hub"
compatibility_date: "2026-09-30"
compatibility_flags: ["nodejs_compat"]
main: "./src/worker.ts"
```

| 绑定 | 类型 | 状态 |
|---|---|---|
| `DB` | D1 | 已用。`x-article-hub`，id `61f1e63b-…` |
| `ARCHIVE` | R2 | 已用。`x-article-archive`，83 个媒体对象 + 原始抓取 |
| `BROWSER` | Browser Run | 已用，16 次成功抓取 |
| `AI` | Workers AI | **已绑定，从未调用**（见 §17） |
| `ASSETS` | 静态资源 | 已用 |

**没有的东西**（设计文档里有，这里没有）：

- ❌ **KV namespace** —— `astro.config.mjs` 里 `session: false`，注释明确写着"不该 provision Astro 的 KV session store"。会话因此走 D1。
- ❌ **Cron Triggers** —— `triggers` 为空。设计文档 §21 的排名刷新定时任务不存在。
- ❌ **Durable Objects**
- ❌ **Workflows**

### 2.2 队列

| 队列 | 生产者绑定 | 消费者 | max_batch | 超时 | 重试 | DLQ |
|---|---|---|---|---|---|---|
| `article-ingest` | `ARTICLE_INGEST_QUEUE` | ✅ | 10 | 30s | 5 | `article-ingest-dlq` |
| `article-process` | `ARTICLE_PROCESS_QUEUE` | ✅ | 5 | 30s | 5 | — |
| `article-metrics` | `ARTICLE_METRICS_QUEUE` | ❌ **无消费者** | — | — | — | — |

`article-metrics` 有生产者声明但没有 consumer。这是 §11（榜单不分化）的直接上游原因之一。

### 2.3 环境变量

`vars`（非敏感，`wrangler.jsonc` 内）：

```
SITE_NAME = "X Article Hub"
SITE_ORIGIN = "https://x-article-hub.zachzhao.workers.dev"
RANKING_WEIGHTS_JSON = {"popularity":0.4,"velocity":0.3,"quality":0.2,"editor":0.1}
MAX_IMPORT_URLS = "200"
CRAWL_SCREENSHOT = "false"
```

### 2.4 生产环境 secret（4 个，全部不在仓库）

| 名字 | 用途 |
|---|---|
| `ADMIN_TOKEN` | admin 后备通道（共享密钥） |
| `GOOGLE_CLIENT_ID` | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `USER_SESSION_SECRET` | 给 `user_sessions.ip_hash` 加 pepper |

> ⚠️ **`ADMIN_TOKEN` 是 8 位纯数字、可被穷举。** 这是已知弱项（README 里有同样标注），目前靠 Cloudflare Access 挡在前面兜底。

> ⚠️ **`X_COOKIES_JSON` 没有设置，但 16 次抓取全部成功。** 这说明 X 目前对未登录请求仍然返回文章正文。这个行为随时可能改变，`src/services/crawl.ts:183` 里有对应的 `LOGIN_REQUIRED` 提示文案。

---

## 3. 请求路径

### 3.1 Worker 顺序（`src/worker.ts`）

```
worker.use(cf())        ← 必须最先：注入 env + executionCtx，提供静态资源
worker.use(actions())   ← Astro Actions（当前未使用）
worker.use(middleware())← Astro 中间件（缓存策略 §10.3）
worker.route('/', apiApp) ← Hono 路由：/api、/api/admin、/admin、/auth、/healthz
worker.all('/api', apiNotFound)  ← 必须在 pages() 之前，否则 JSON 客户端会拿到 HTML 404
worker.use(pages())     ← 兜底：所有未匹配的路径交给 Astro
worker.use(i18n())
```

关键设计：**Hono 在前，Astro 在后**。`/api/*` 的 404 必须在 `pages()` 之前拦截，否则 JSON API 客户端会收到一个 HTML 404 页面。

### 3.2 全部路由

**公开 JSON API**（`/api`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | |
| GET | `/api/categories` | 5 个固定分类 |
| GET | `/api/articles` | 分页列表 |
| GET | `/api/articles/:slug` | 单篇详情 |

**Admin JSON API**（`/api/admin`，全部需要 admin）

```
POST   /articles/import              批量导入
GET    /articles                     列表
GET    /articles/:id                 详情
POST   /articles/:id/retry           重试失败任务
POST   /articles/:id/crawl           重新抓取
GET    /articles/:id/raw             原始归档
POST   /articles/:id/parse           重新解析
POST   /articles/:id/media           重跑媒体
GET    /articles/:id/media           媒体状态
POST   /articles/:id/publish
POST   /articles/:id/reject
POST   /articles/:id/archive
POST   /articles/:id/takedown
POST   /articles/:id/display-mode
POST   /articles/:id/featured
GET    /articles/:id/errors
GET    /jobs        /jobs/:id
GET    /categories
GET    /storage
POST   /maintenance/purge-prefix
POST   /demo/seed   /demo/clear
POST   /login       /logout
```

**Admin UI**（`/admin`，HTML）

```
GET  /  /login  /import  /articles  /articles/:id  /jobs
POST /import  /login  /logout
POST /articles/:id/{retry,crawl,parse,media,publish,reject,archive,
                   category,featured,takedown,restore}
```

**账号**（`/auth`，公开）

```
GET  /:provider/start
GET  /:provider/callback
POST /logout
GET  /me
```

**公开页面**（Astro `src/pages/`）

```
/  /featured  /latest  /trending  /rising  /about  /account  /search
/article/[slug]  /author/[username]  /category/[slug]  /tag/[slug]
/sitemap.xml  /feed.xml  /robots.txt  /site.webmanifest  /media/[imageId]
```

**导航只有 5 项**：`Home` `/featured` `/latest` `/trending` `/rising`。`Search` 和 `About` 已从导航移除（页面仍在，见 §10.2）。

---

## 4. 数据模型

### 4.1 表清单

`sqlite_master` 里有 21 张表，但其中：

- `_cf_KV` 是 Cloudflare 内部表
- `articles_fts` + `articles_fts_config/content/data/docsize/idx` 共 6 张是 FTS5 影子表

**真实业务表 14 张：**

```
article_metrics   article_tags     article_versions   articles
authors           categories       crawl_jobs         curation_events
media_objects     oauth_states     tags
user_identities   user_sessions    users
```

**索引 24 个，FTS 触发器 3 个**（`articles_fts_insert` / `_update` / `_delete`）。

### 4.2 articles（43 列）

最宽的一张表。列的分组：

**来源与身份**
```
id  source_url  canonical_url  x_article_id  x_post_id  slug
```
`canonical_url` 上有唯一约束，是去重键。`canonical_url` 全部规范化为 `/article/<id>` 形式。

**标题与摘要**
```
title  excerpt
```
`excerpt` 同时是 AI 摘要和 `display_mode = 'excerpt'` 时渲染的那段文字的来源。

**作者（冗余存一份，不只靠外键）**
```
author_id  author_name  author_username  author_avatar
```

**时间**
```
published_at  imported_at  created_at  updated_at
```

**状态**
```
status  display_mode  featured  takedown_requested_at  takedown_reason
```

**AI 产出（目前全空）**
```
ai_summary  ai_category  ai_confidence
```

**分类：两列，都读 `COALESCE(editor_category_id, category_id)`**
```
category_id  editor_category_id
```
`category_id` 是设计给 AI 的那半，**16 篇全为 NULL**（`ai` job 类型无消费者，见 §12）。实际生效的只有 `editor_category_id`（9 篇）。

**人工覆盖**
```
editor_summary
```

**评分（目前全 NULL）**
```
quality_score  popularity_score  velocity_score  editor_score  final_score
```

**归档指针**
```
parser_version  content_r2_key  raw_r2_key
```

**统计**
```
word_count  block_count
```

**FTS 双胞胎列（迁移 0007 引入）**
```
fts_content  fts_tags  fts_title  fts_excerpt  fts_author_name  fts_author_username
```

> **为什么要 `fts_*` 双胞胎列：** 见 §14。这是整个中文搜索修复的核心，也是最容易误解的部分。

### 4.3 关键状态机

**ArticleStatus（10 态）**
```
pending → fetching → fetched → parsing → review → published
                                                     ↓
                        rejected / archived / takedown / failed
```

**JobStatus（8 态）**
```
pending  queued  running  success  failure  retrying  failed  skipped
```

**DisplayMode（4 态，SPEC §37 版权）**
```
full  excerpt  link_only  takedown
```
`display_mode` 决定正文渲染多少：`full` 才渲染全文，`excerpt` 只给摘要，`link_only` 只给原文链接。

**CurationAction（11 种，审计用）**
```
import  publish  reject  archive  restore  takedown
category_override  summary_override  featured  unfeatured  retry
```

> ⚠️ 这 11 个值**没有联合类型的运行时校验**（`recordEvent` 的 `action` 参数是 TS 类型，运行时是 TEXT 列）。数据库实测出现过的：`restore 20` / `publish 16` / `import 16` / `featured 14` / `category_override 9` / `retry 4` / `takedown 3`。
>
> **`restore 20` 是错的**，见 §16 缺陷 D4。

---

## 5. 导入流水线

`POST /admin/import`（表单）或 `POST /api/admin/articles/import`（JSON）→ `src/services/import.ts`。

```
粘贴文本
  ↓ splitUrlInput()          按行/逗号/分号切分，忽略空行
  ↓ normalizeArticleUrl()    src/lib/url.ts
  ↓ 去重
  ↓ D1 建行 + 建 crawl_job
  ↓ queue.sendBatch()
  ↓ 立即返回（SPEC §34：绝不等待抓取）
```

### 5.1 URL 规范化（`src/lib/url.ts`）

接受的主机：`x.com` / `www.x.com` / `mobile.x.com` / `twitter.com` / `www.twitter.com` / `mobile.twitter.com` —— 六个别名全部归一到 `x.com`。

接受的路径形状：
```
/{username}/article/{numeric-id}    ← 正式形态
/{username}/status/{numeric-id}     ← 永久链接别名（§5.2 也接受）
```

规范化步骤：URL decode → 剥离 `utm_*` / `s` / `t` / `ref` 等跟踪参数 → 主机别名归一 → 转 https → **规范化到 `/article/<id>`**。

单次最多 `MAX_IMPORT_URLS = 200` 条。

### 5.1.1 上游发现：YouMind 的 viral-article 列表（`scripts/import-youmind.sh`）

导入是「给定 URL」的。发现 URL 是另一件事，目前有一个可用的上游：

`https://youmind.com/landing/x-viral-articles/explore` 是一个 **索引页，不是文章源**。
它聚合「今日病毒式 X 长文」，每条都链回原文 `https://x.com/<user>/status/<id>` ——
而这正是 §5.1 已接受的 `/status/` 永久链接形态，所以**导入端一行都不用改**。

实测要点（2026-10-11，生产验证）：

- 列表页是 Next.js，**链接直接渲染进 HTML**，一次 `curl` 拿 10 条，**不需要 Browser Rendering**。
- `?page=N` 是服务端分页，page 1 与 page 2 **零重合**。
- 默认排序**已经是 time（最新在前）**，`?sort=` 另接受 views/likes/reposts/comments/bookmarks。
- 页面是 `robots: noindex, follow` —— 不索引、允许跟随链接。

脚本只读前 `--pages` 页（默认 10 页 = 100 篇最新），去重后走现有导入端点。

### 5.1.2 大批量导入会撞浏览器配额（实测，2026-10-11）

**一次导入 100 条会超出 Browser Rendering 的账号级速率限制。** 实测结果：

```
一次 POST 100 条 → created 100, failed 0        ← 导入本身全部成功
但随后抓取：19 篇 archived，81 篇 PAGE_BLOCKED(429)
```

原因：队列消费者 `max_batch_size = 10`，10 个并发抓取 × 每篇一次 `/snapshot`
浏览器会话，超出了账号配额。81 个任务进入 `crawl.ts` 的 **1 小时冷却**
（`RATE_LIMIT_COOLDOWN_MS = 3_600_000`）。

**重新导入救不了它们**：SPEC §5.3 去重会返回 `duplicate`，并且（正确地）**不建新的
crawl_job**。要恢复必须走 **重抓路径** `POST /api/admin/articles/:id/crawl`
（同步执行、返回真实结果），由 `scripts/recrawl-stuck.py` **串行 + 退避**地逐个补抓。

结论：**批量导入要分波**（`--wave`，默认 15 条一波、波间暂停），而不是一次灌进去。
这是账号配额约束，不是代码缺陷 —— 并发 1 反而稳定。

### 5.2 导入结果的三种词汇（SPEC §22）

```
ImportOutcome.status ∈ { created, duplicate, failed }
ImportResult       = { created, duplicates, failed, outcomes[] }
```

**`duplicate` 是线上 API 值，不能改** —— `scripts/smoke.sh` 同时断言了 `.duplicates` 和 `o.status === "duplicate"`，且它是 SPEC §22 响应结构的一部分。

Admin 界面**显示**为 `already imported`，并在旁边加第二个 pill 显示那篇文章的工作流状态（`published` / `review` / …）。显示与 API 是两套词汇，故意不合并 —— 详见 `52df929` 的提交说明。

---

## 6. 抓取

`src/services/crawl.ts`（550 行，本项目最大的服务文件）+ `src/services/browser.ts`。

### 6.1 一次抓取做什么

```
setArticleStatus('fetching')
  ↓ readCookies(env)                  X_COOKIES_JSON，当前未设置
  ↓ runSnapshot({ url, cookies, formats: ['content','markdown'] })
  ↓                                  一次浏览器会话同时拿 HTML + Markdown
  ↓                                  （比分开调 /markdown + /content 便宜一半，
  ↓                                   且消除"第二次被限流导致 HTML 静默丢失"）
  ↓ 存 R2: articles/{id}/raw/{page.html, page.md, metadata.json}
  ↓ 写 article_versions (v{n})
  ↓ recordEvent(…, 'restore')          ← 缺陷 D4
  ↓ 入队 parse job
```

`CRAWL_SCREENSHOT = "false"`，所以 `screenshot.webp` 不抓（SPEC §39 说截图最贵）。

### 6.2 重试阶梯（`src/jobs/crawl.ts`）

```ts
RETRY_SCHEDULE_MS = [60_000, 300_000, 1_800_000, 7_200_000, 86_400_000]
//  attempt 2  +1min
//  attempt 3  +5min
//  attempt 4  +30min
//  attempt 5  +2h
//  attempt 6  +24h
MAX_ATTEMPTS = 6

RATE_LIMIT_COOLDOWN_MS = 3_600_000   // 账号级 429 → 冷却 1 小时
```

实现方式是**重新投递消息并 ack**，不依赖 `message.retry()`，因为 SPEC §25 要求自己的阶梯。

### 6.3 R2 布局（`src/types/article-document.ts`）

```
articles/{id}/raw/page.html                    只追加
articles/{id}/raw/page.md                      只追加
articles/{id}/raw/metadata.json                只追加
articles/{id}/raw/screenshot.webp              可选，当前不抓
articles/{id}/versions/v{n}/article.json       可重建
articles/{id}/versions/v{n}/article.md         可重建
articles/{id}/versions/v{n}/article.html       可重建
articles/{id}/media/{position}.{ext}           媒体，不可变
articles/{id}/avatar.{ext}                      头像
```

媒体扩展名是**参数**不是常量 —— 因为 X 不理 `Accept` 头时会返回 PNG/JPEG 字节，用魔数嗅探后写实际扩展名（见 §8）。

---

## 7. 解析

`src/parser/markdown.ts` + `src/services/parse.ts`。

**`PARSER_VERSION = 10`。** `parseArticle` 有幂等短路：文章已是当前版本且有 `content_r2_key` 就直接返回，所以重复触发解析不会重复消耗。版本 7 将正文字符串改为内联片段；版本 8 处理重复加粗分隔符和转义标点；版本 9 从原始 HTML 补回 Markdown 转换遗漏的视频源站链接。视频不下载，保留标题；通过前一段正文定位插入位置，匹配不到时附在正文末尾。版本 10 修复重新解析丢失已归档图片状态的问题：写回前按源 URL 匹配 `media_objects` 的 ready 正文图片，恢复媒体路由 ID、R2 key 和尺寸，不重新下载。

### 7.1 输出的 7 种 block

```ts
type ArticleBlock =
  | { type: 'paragraph'; spans: InlineSpan[] }
  | { type: 'heading'; level: 1|2|3; spans: InlineSpan[] }
  | { type: 'quote'; spans: InlineSpan[] }
  | { type: 'list'; ordered: boolean; items: InlineSpan[][] }
  | { type: 'image'; imageId: string }
  | { type: 'code'; language?: string; code: string }
  | { type: 'embed'; postId: string }
```

### 7.2 两条容易被忽略的行为

解析器版本现为 **16**：识别裸代码围栏前由 X 导出的独立语言标签，将其写入 code block 的 `language`，不再显示为正文段落。阅读页通过 Shiki core 和 JavaScript regex engine 服务端高亮，按 GitHub light/dark 双主题生成颜色。代码框有语言标签、横向滚动；未知语言回退 text，代码按转义文本输出。Worker 仅打包固定语法集合，不加载完整 Shiki 语言包或 WASM。

解析器版本现为 **15**。对原始 HTML 中 `data-href="/i/web/status/..."` 证实的嵌入帖文，恢复匹配的 Markdown 帖文片段为 `embed` block，保存作者、正文和原帖 URL，去除视频时长及互动数字。有媒体元数据时，卡片内显示原生视频播放器及预览图，直接请求 X 源站 MP4，不下载视频。媒体元数据缓存在 `embedded-posts/{postId}/media.json`；缓存未命中时尝试 X syndication 接口及 FxTwitter。实测此 OpenAI 帖文的接口在本地可读、Worker 内未取得视频信息，已从本地验证结果补入缓存。接口不可用且无缓存时保留文字及原帖链接，不加载 X 第三方组件。

**视频播放。** 阅读页使用带 `controls`、`playsinline` 和 `preload="metadata"` 的原生播放器，直接请求视频源站 URL；保留源站观看链接和标题，不将视频下载到 R2，不自动播放。

**头像不是图。** `LINKED_IMAGE_RE` 匹配到的行，如果 href 是 profile 或 src 命中头像 CDN 模式，就被提取成 `authorChip` 而不是一张图。SPEC §9.3 说"保留作者结构"，没说要把别人的脸作为插图发在文章中间。

**内联格式由片段渲染。** `InlineSpan` 支持 `text`、`strong`、`em`、`code` 和带 `href` 的 `link`，阅读页统一通过 `InlineText.astro` 渲染。Markdown 链接保持可点击；裸 URL 仍是纯文本，并被收集到 `document.links`。按用户选择，链接标签内的强调标记去除，标签不保留嵌套加粗。X 捕获中的 `****标题****` 按加粗处理；转义星号保留为作者的字面标点。`inlineToText` 为搜索、字数和摘要提取纯文本。

---

## 8. 媒体管线

媒体处理结束后，如果没有已归档正文图或生成封面，会调用 `ensureArticleCover` 生成兜底封面。现有每 30 分钟定时任务另补一篇缺图文章，供 AI 额度或临时失败后的重试。批量脚本直接查询 D1 的缺图条件，HTTP 文章列表不提供 `cover_image_id` 字段，不能据此筛选。

`src/services/media.ts`（729 行）。

```ts
MAX_IMAGE_BYTES   = 12 * 1024 * 1024   // 12MB
MAX_MEDIA_ATTEMPTS = 5
FETCH_TIMEOUT_MS  = 20_000
```

### 8.1 两道闸门，都在写字节之前

1. **声明类型**：`!contentType.startsWith('image/')` → `INVALID_CONTENT_TYPE`，永久失败
2. **魔数嗅探**：`sniffImageType` 只认 WebP / PNG / GIF / JPEG 的文件头

第 2 道是为了堵"X 忽略 `Accept: image/webp` 头"这个情况。

### 8.2 实测库存

83 个对象，**全部 `ready`**：

```
image/jpeg   64
image/webp   14
image/png     5
```

`content_type` 里**没有任何 `video/*`**。

---

## 9. 视频：目前没有任何处理

三层都没有视频概念，SPEC 里 `video`/`mp4`/`m3u8` **零命中**（从来不在范围内）。

实测：13 篇文章中 0 篇含视频引用，83 个媒体对象 0 个 `video/*`。**从来没发生过。**

但如果发生，落点取决于 X 导出成什么形态，其中**一种会说谎**：

| X 的形态 | 落到哪 | 结果 |
|---|---|---|
| 裸 URL 单独成行 | paragraph 分支 | URL 文本保留但**不可点**（见 §7.2） |
| `![](….mp4)` | `addImage` 不按扩展名过滤 → 建媒体行 → 两道闸门全拒 → 永久 `INVALID_CONTENT_TYPE` → `r2Key` 为 null | 页面渲染 **"Image not archived / this figure still loads from x.com"** ← **这句对视频是错的** |
| X 完全省略 | 无 block、无 warning | 静默缺失，无任何痕迹 |

那句提示对图片是诚实的（X 确实还在提供字节）。对视频是错的：视频从来就没被归档过、也从来不会作为图片显示。**而且它占的是给 `<img>` 预留的 `<figure class="fig">` 版位，带尺寸框。**

**唯一能存的"动"是 GIF** —— `sniffImageType` 接受 `GIF8`，动图作为 `image/gif` 正常归档。

---

## 10. 公开站与缓存

### 10.1 页面清单

| 路由 | 对应 |
|---|---|
| `/` | 首页，Editor's Pick 一行 + 四个板块摘要 |
| `/featured` | 精选，`featured = 1` |
| `/latest` `/trending` `/rising` | 四个榜单之一 |
| `/article/[slug]` | 阅读页，`display_mode` 决定渲染多少 |
| `/author/[username]` `/category/[slug]` `/tag/[slug]` | 归档页 |
| `/search` | 搜索 |
| `/about` | 说明 |
| `/account` | 账号 |
| `/sitemap.xml` `/feed.xml` `/robots.txt` `/site.webmanifest` | SEO |

### 10.2 导航只剩 5 项

`Search` 和 `About` 已从导航移除（提交 `afdd98a`），**页面仍在**：

- `/about` 在**页脚**
- `/search` 是**页头搜索框**的提交目标（`action="/search"`）

两者都有测试钉住（`tests/unit/glyphs.test.ts`），因为删导航项的失败模式不是坏链接而是**孤儿页面**。它们用的两个内联图标（`magnifying-glass`、`info`）也一并删了 —— `icons.test.ts` 会对"已内联但无去处"的图标报错。

> ⚠️ **副作用：`≤1200px` 时页头的搜索框和分类筛选一起隐藏（`.search-mini` 断点），所以窄屏上现在没有任何搜索入口。** 导航本身塞得下（见 §16 D6），有余量把搜索框往下放宽，但这是没做的改动。（这里原写 `≤1100px`，实际断点一直是 1200px。）

### 10.3 缓存策略（`src/middleware.ts`）

```ts
TTL_SECONDS = [
  [/^\/$/,                                  60],
  [/^\/(latest|trending|rising|about)$/,     60],
  [/^\/category\//,                        300],
  [/^\/tag\//,                             300],
  [/^\/author\//,                          300],
  [/^\/article\//,                        3600],
  [/^\/(sitemap\.xml|feed\.xml|robots\.txt)$/, 3600],
  [/^\/search/,                             30],
]
```

**永久 no-store：** `/admin/*`、`/account*`、`/auth/*`。

实测确认：

```
/            Cache-Control: public, max-age=60, s-maxage=60
/account     Cache-Control: no-store
/auth/me     Cache-Control: no-store
/feed.xml    Cache-Control: public, max-age=900, s-maxage=900
```

> ⚠️ **`/featured` 不在 TTL 表里** —— 所以它拿不到任何 `s-maxage`，是唯一没有 CDN 缓存的公开列表页。可能是遗漏。

---

## 11. 榜单：四个里有三个完全相同

`src/db/public.ts` 的 `SORT_SQL` 定义了 4 个排序：

```ts
latest   : COALESCE(a.published_at, a.imported_at) DESC, a.id DESC
trending : COALESCE(a.final_score, 0) DESC, COALESCE(a.published_at, a.imported_at) DESC
rising   : COALESCE(a.velocity_score, 0) DESC, COALESCE(a.published_at, a.imported_at) DESC
featured : COALESCE(a.published_at, a.imported_at) DESC, a.id DESC   // + WHERE featured = 1
```

`featured` 成为独立板块靠的是 WHERE 子句 `if (sort === 'featured') where.push('a.featured = 1')`，不是排序本身。

### ⚠️ 历史实测（已修复）：三个榜单曾返回完全相同的顺序

> **这一节记录的是 2026-10-08 的状态，现已不成立**，保留是因为它是"为什么重建排序"的证据：`/rising` 已被删除（`9aa186f`），`velocity` 从 `final_score` 里去掉，权重改为 popularity 0.57 / quality 0.29 / editor 0.14，`refreshRanking` 由 `*/30` cron 驱动。

```
/latest    dae9eb6410df4b73  (15 cards)
/trending  dae9eb6410df4b73  (15 cards)
/rising    dae9eb6410df4b73  (15 cards)
```

**md5 完全一致。** 原因链条：

1. `applyRankingScores` 定义在 `src/services/publish.ts:183`，**零调用者**（已被 `refreshRanking` 取代）
2. `wrangler.jsonc` 的 `triggers` 为空 —— SPEC §21 的排名刷新 cron 不存在
3. `article_metrics` 表 **0 行**
4. 全部 16 篇文章的 `final_score` / `velocity_score` / `popularity_score` / `quality_score` **全是 NULL**

所有分数都 NULL，于是 `COALESCE(…, 0)` 三个都退化成 0，ORDER BY 的第一键全部并列，落到了第二键 `published_at DESC`。

`article-metrics` 队列有生产者声明但**没有 consumer**（§2.2）。

> **这一段描述的问题已经不存在**（2026-10-12）。榜单已重建为三个信号（popularity/quality/editor），`refreshRanking` 由 `*/30` cron 驱动，`article_metrics` 也有数据了。现在的互动数据问题不是"全 NULL"，而是"85% 的文章 X 没返回互动栏"——见 §16 的 D1（已改写）。

---

## 12. 分类：固定五项，运行时不可写

`categories` 表 5 行，全部来自 `migrations/0002_seed_categories.sql` 的手写 INSERT：

| id | slug | name | sort | 文章数 |
|---|---|---|---|---|
| `cat_ai` | `ai` | AI | 10 | 5 |
| `cat_technology` | `technology` | Technology | 20 | 2 |
| `cat_business` | `business` | Business | 30 | 2 |
| `cat_science` | `science` | Science | 40 | **0** |
| `cat_ideas` | `ideas` | Ideas | 50 | **0** |

slug 是**字面量**，不是 id 生成器。

### ⚠️ 表在运行时不可写

```
grep "INSERT INTO categories|UPDATE categories|DELETE FROM categories" src/
→ 0 hits
```

**没有任何服务、管理界面或 API 能新建、改名或删除分类。** admin 文章页的下拉框是从 `listCategories` 渲染的，只能在这 5 个里选。加一个分类 = 写一条迁移 + 部署。

### ⚠️ AI 分类层从未接线

`src/jobs/dispatch.ts`：

```ts
ai:       notImplemented('ai'),
metrics:  notImplemented('metrics'),
reindex:  notImplemented('reindex'),
```

有类型声明、有队列、**没有消费者**。`ArticleStatus` 的 `AI` 阶段、`articles.category_id` 列、SPEC §13 的 prompt 形状都在。

**结果：16 篇的 `category_id` 全是 NULL，9 篇的分类全部来自你在 admin 里手选**（写进 `editor_category_id`）。

而 5 处查询都在读 `COALESCE(a.editor_category_id, a.category_id)` —— **右半永远为空**。

### 关于空分类

`Science` 和 `Ideas` 是 0 篇。**页头筛选器照常列出它们，但已不再显示计数** —— 分类行变成搜索框左侧的 `<select>` 后只剩 ~71px 的文字空间，`Technology (0)` 有 86px 会被截断，而 `Technology` 是 66px。何况计数全是 0（没有任何已发布文章带分类），本来也不是信息。计数回到分类页上；要么派文章，要么隐藏空分类 —— 后者会动页头和 `/api/categories`，是**产品决定不是 bug 修复**，所以一直没做。

---

## 13. 账号与 admin 鉴权

### 13.1 账号（SPEC §43）

**只有 Google 一家。** 不做密码，不做邮箱验证码。

完整闭环**已实测走通**（站长真实登录过一次）。

四张表：

| 表 | 生命周期 |
|---|---|
| `users` | 一个人 |
| `user_identities` | 一个凭证（`PRIMARY KEY (provider, provider_user_id)`） |
| `user_sessions` | 一次登录，30 天 |
| `oauth_states` | 一次跳转，10 分钟，**单次消费** |

**身份键是 `(provider, provider_user_id)`，绝不是 email。** 理由（换过一次，见 §13.5）：Google 允许账号持有人**修改**账号地址，`sub` 创建时分配不会变。

**会话存在 D1 而不是 KV** —— KV 最终一致（读滞后最多 60 秒），会让登录坏在一个没人注意的方向：callback 写入会话，下一个请求读到没追上的副本，于是**登录成功后一分钟内仍显示登出**；更糟的是登出后会短暂显示仍然登出。一个读不到自己写入的存储不能承载鉴权决策。

cookie 里是 256 位随机数，D1 只存 SHA-256。地址用 `USER_SESSION_SECRET` 加 pepper 后存储（裸 SHA-256 的 IPv4 可被 2^32 次枚举还原）。

`SameSite=Lax` 是**承重**的：登录最后一跳是来自 Google 的顶层 GET 跳转，只有 `Lax` 会带上 cookie。`Strict` 会让每次登录都落回 `/account` 且仍是登出状态，且**任何地方都没有报错**。

**页头不按人渲染** —— 全站唯一一处不同读者会看到不同 HTML 的地方，刻意不做按人渲染：`/` 是 `s-maxage=60`、`/article/*` 是 3600，按人渲染会把一个人的名字烤进缓存文档发给所有人。`Vary: Cookie` 能解决但会让缓存命中率几乎归零。所以 HTML 对所有人一致，一段 `is:inline` 脚本取 `/auth/me` 补上槽位。

显示名用 **`textContent`** 写入，绝不用 `innerHTML` —— 它是 Google 账号持有人自己选的字符串。

### 13.2 账号访问的 admin

共享 token **保留**，并且**先**检查；真实账号是附加的第二条路。

```ts
resolveIdentity(c)                     ← Cloudflare Access 头 / Bearer token
  ↓ 若无
verifySessionCookie(c, ADMIN_TOKEN)    ← admin cookie
  ↓ 若无
resolveAccountIdentity(c)              ← 用户会话 + role === 'admin'
```

顺序有意：token 是不会被 provider 侧任何状况夺走的路径 —— Google consent screen 被关、应用被删 —— 所以它在替代方案不工作时仍是入口，也在 §13 这段代码万一写错时仍是出口。

**角色从 `users` 行读，不从 cookie 读**，所以在 D1 改 `role` 下一个请求就生效。

`GRANT_ADMIN_SQL`（导出常量，有测试断言内容）：
```sql
UPDATE users SET role = 'admin', updated_at = ?1 WHERE email = ?2
```

### 13.3 为什么删掉了跨 provider 合并

迁移 0008 曾有 `oauth_states.link_to_user_id`（登录状态下连接第二个 provider）。两家时是受支持的账号合并；**只剩一家后它从"合并功能"变成事故**：已登录 A，然后用另一个未知 Google 账号登录，那个身份会被挂到 A 上 —— B 和 A 变成同一个人，B 既没同意也看不到。

所以登录**始终按身份本身的依据解析**。要加回第二个 provider 时，恢复这一列是**安全决策不是功能开关**。

---

## 14. 搜索

### ⚠️ `fts_*` 双胞胎列是核心设计

原始设计里 FTS 表直接用 `articles` 的列。迁移 0007 改成：

- `articles_fts` 重命名（`article_id` 作为键）
- `articles.content_text` → **`fts_content`**，`tags_text` → **`fts_tags`** 原地重命名
- 这些列**从不 SELECT**，纯粹给 FTS 触发器用
- 显示用的列另建 `fts_title` / `fts_excerpt` / `fts_author_name` / `fts_author_username`
- 查询侧用 `COALESCE(new.fts_title, new.title)` 读取

**为什么**：中文分词需要把正文和标签压平成单列，而原来那两列是分开的且被别的查询用到。改名而不是新建，避免了"两套列并存、哪天忘了同步"。

回填靠 `scripts/backfill-search-index.mjs`（直接 import `segmentCjk`，无拷贝，幂等，**不用 `BEGIN/COMMIT`** 因为 D1 拒绝 SQL 事务）。

### 中文分词：预分割，不是 trigram

`src/lib/cjk.ts` 的 `segmentCjk` 在**写入时**把 CJK 串按词典/二元切分写进 `fts_content`，查询时同样切分。搜索照常用 SQLite FTS5 的 `MATCH`。

效果：投资 0→2 结果，编程/AI编程 0→1 结果，Latin 查询不变。

### ⚠️ `snippet(articles_fts, 3, …)` 必须保持位置参数

在这个 SQLite 构建里，按**列名**寻址会静默退回第 0 列（`article_id`）。两半都在 `tests/unit/cjk-search.test.ts` 里钉住。

### 唯一的一处裸 URL 不可点

`buildFtsQuery` 会剥掉 `"*:^()[]{}~-` 并最多取 12 个 token。`你好世界` 被当成一个短语，所以只匹配完全一样的连续串。

---

## 15. 测试与验收

### 15.1 单元测试

20 个文件，**335 个测试**，全部通过。

```
cjk-search      config         crawl-recognition  curation-actions
document        glyphs         header-layout      homepage
icons           import-ui      media              nav-state
parser          png            ranking            sql-placeholders
state-machine   theme          typography         url
user-auth
```

几个值得知道的约定：

- **`code(source)` 注释剥离器**：负断言（`expect(file).not.toContain(...)`）在 `theme` / `nav-state` / `homepage` / `user-auth` / `typography` 里各有一个，因为这类断言反复匹配到**助手自己写的解释性注释**。
- **`grep -c` 数的是行数不是出现次数** —— 曾因此把 `/author/alchainhust` 上的 8 张卡报告成 1 张。要用 `str.count()`。
- **红绿验证**：每个新守卫都要破坏一次确认会失败。测试通过不等于测试会咬。

### 15.2 生产验收脚本

```
scripts/smoke.sh        58 项，Phase 1 API 验收
scripts/smoke-site.sh   公开站验收
scripts/cleanup-smoke.sh 清理由上面两个留下的 R2 前缀和 D1 行
```

两个脚本都直接打生产地址，跑完必须 cleanup。cleanup 的行是：

```sql
DELETE FROM articles WHERE slug LIKE 'karpathy-%' OR slug LIKE 'someone-%' OR slug LIKE 'demo_%'
```

> ⚠️ 清理脚本**故意只删这三个前缀**。`cleanup-smoke.sh` 会拒绝删除任何有活 D1 行认领的 R2 前缀 —— 所以即使 id 列表错了也碰不到真实文章。这个设计值得保留。

### 15.3 视觉验证

浏览器工具未连接，用：

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless
```

`file://` 本地副本要把绝对 `src="/…"` 改相对，否则图片全裂。Chrome 无头窗口最小宽度约 500px，**比这更窄的宽度无法测量**。

> ⚠️ **边缘缓存会咬人。** `admin.css` 以 `CF-Cache-Status: HIT` 提供，部署后紧接着取到的可能是上一版。页头测量曾因此对着部署前的缓存副本做，量出一个**不存在**的溢出（破绽是数字与改动前逐字节相同）。加缓存破坏参数、并**在测量前先断言抓到的副本是新的**。

> ⚠️ **量页头必须量最宽的那门语言，而且 `scrollWidth - clientWidth` 会骗人。** 分类筛选移进页头那一版连着两轮量出"还有余量"，因为量的是**中文**标签 —— 它们恰好是最短的：导航在 zh 需要 358px、ja 386px、**en 462px**。站点默认英文，所以中文量出来的余量不是余量，是最好的情况。
>
> 第二个坑更隐蔽：`.nav` 是 `flex: 1`，只要内容放得下，`scrollWidth` 就等于 `clientWidth` —— 所以 `scrollWidth - clientWidth` 在"刚好放下"和"还有富余"两种完全不同的状态下都读 0。正确做法是把 `flex` 临时设成 `0 0 auto` 量出内容的**固有宽度**，再和这一行实际给它的盒子比。这套数现在钉在 `tests/unit/header-fit.test.ts` 里，用的是近似字宽（CJK 全宽 13px、拉丁 7px），和实测值差 ~3% 但**排序正确** —— 破坏性验证时它报 -72px，浏览器实测 -84px，同一个 bug。
>
> 还有一条布局事实值得记住：`--wrap` 把这一列在**所有** ≥1301px 的视口下都钉在 1180px，所以宽屏救不了这一行 —— 没有任何断点能凭空给出宽度，只能真的减少内容。

---

## 16. 已知缺陷清单

按影响排序。每条都是实测结论。

### D1 🟡 85% 的文章没有互动数据，因为 X 对部分文章返回了不含互动栏的页面

**症状**：`article_metrics` 里每篇都有行，但 98 篇已发布文章中 **85 篇**的 `views`/`likes`/`reposts`/`replies`/`bookmarks` 全是 `NULL`。表面上像"很多文章没人互动"。

**实测（2026-10-12）**：不是没人互动，是**页面上根本没有互动栏**。

| 文章 | raw HTML 大小 | `data-engagement-action` 出现次数 |
|---|---|---|
| `rabi-guha-…`（有数据） | **151 KB** | 4 个（like/retweet/reply/generic） |
| `shiraishi-x-…`（无数据） | **67 KB** | **0** |

无数据那篇的 HTML 里连 `aria-label="Like"` 都是 0 —— **整个互动区（点赞/转发/回复/查看）不存在**，但文章正文正常渲染。

**已排除的原因**：
- ❌ **不是选择器坏了**。把 `extractEngagement` 喂给有数据那篇的 HTML，五个值全部正确解析（`23K`→23000、`5.8M`→5800000）。
- ❌ **不是抓取时机**。当天重新抓取 `shiraishi-x`，抓取成功，但新 HTML 仍是 66,693 字节、互动标记仍为 0、新 metrics 行仍全 NULL。
- ❌ **不是语言、导入时间、或抓取成功与否**。成功的抓取里也有大量 NULL（28 篇 success 但无数据）。

**目前判断**：X 在**未登录**状态下对部分文章返回精简页面。`wrangler secret list` 确认 **`X_COOKIES_JSON` 未配置**（只有 `ADMIN_TOKEN`/`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`USER_SESSION_SECRET`），而 `crawl.ts:183` 的注释正是为这种情况写的：*"X served its logged-out shell … set the X_COOKIES_JSON secret, then retry."*

**为什么现在不修**（2026-10-12 决定）：功能没有坏 —— `extractEngagement` 返回 `null` 而非 `0` 是刻意设计（写 0 会让"选择器坏了"和"文章很冷清"看起来一样），榜单的 `COALESCE(…, 0)` 把无数据的排在后面。覆盖率低，但行为正确。

**若要改善**，两条路：
1. **配 `X_COOKIES_JSON`**（从自己的 X 账号导出 `auth_token`/`ct0`）。登录态下 X 大概率渲染完整互动栏，**但未经验证**。
2. **定期重抓无互动的文章**。X 的行为可能变化，某次重抓可能就拿到了。

> 这份诊断是实测的：抓取样本、字节数、选择器输出都是跑出来的，不是推测。诊断脚本未保留（是一次性验证），但结论可以用同样的方法在半小时内复现。

### D2 🟡 `overrideSummary` 只有 API，没有界面

`src/routes/admin-api.ts:263` 接受 `summary` 参数写 `editor_summary`，但 admin 页面没有对应的表单。分类有表单（`views.ts:514`），摘要没有。

### D3 🟡 `restoreArticle` 是死导出

定义了，零调用者。

### D4 🟡 每次成功抓取都记一条 `restore` 事件

`src/services/crawl.ts:265` 每次抓取成功都写：

```ts
await recordEvent(env.DB, articleId, 'restore', input.actor,
  `crawled v${version} — ${bodyChars} chars, browser ${…}ms`);
```

`restore` 在 `CurationAction` 里的语义是"把文章恢复回展示状态"（`publish.ts:74`、`:106`）。抓取成功不是恢复。

**证据**（按 note 前缀拆开那 20 条 `restore`）：

```
note LIKE 'crawled v%'   17 条   ← 全部是误记的抓取事件
其他                     3 条   ← 真正的恢复操作
```

17 条对应 16 篇文章，其中 `art_7i7n5rx5sipnkver8m8g` 被抓了两次（一次重抓）。所以审计日志里现在混着两种完全不同的操作，看 `action` 列分不出来。

**修**：给 `CurationAction` 加一个新值，比如 `'crawled'`。

### D5 🟡 两个死导出：`deleteDisplayMode` / `deleteArticle`

声明了，**路由里不可达**（grep 无命中）。硬删除功能存在但没有任何入口。

`deleteArticle` **不可逆，且会留下孤儿 R2 对象** —— D1 行没了，R2 前缀还在，要靠 `cleanup-smoke.sh` 那种工具清理。

### D6 🟡 窄屏没有搜索入口

`Search` 从导航移除后，`≤1200px` 时页头的搜索框和分类筛选一起隐藏（`.search-mini` 断点）。断点从 1100px 提到 1200px 时量过一轮：1201px 时导航在中文标签下有 424px、需要 372px，结论是"有余量，只是没做"。**但那一轮同样只量了中文 —— 英文需要 462px，1201px 下实际是负的。** 所以这条缺陷比原记录更严重：不是"有余量没做"，而是窄屏搜索入口缺失的同时，1201–1300px 区间的英文导航也放不下。分类筛选移进页头时靠隐藏站名才补回来（见 §15.3 的测量陷阱）。

### D7 🟢 `/featured` 不在缓存 TTL 表里

`src/middleware.ts` 的 `TTL_SECONDS` 没有 `/^\/featured$/`，所以它是唯一拿不到 `s-maxage` 的公开列表页。大概率是遗漏。

### D8 🟢 `article-metrics` 队列有生产者无消费者

`wrangler.jsonc` 声明了 `ARTICLE_METRICS_QUEUE` 生产者，但 consumers 列表里没有 `article-metrics`。互动数据目前由**抓取时**直接写入 `article_metrics`（`crawl.ts:341`），不走这个队列，所以这不是当前的问题源。但队列绑定的存在暗示当初设想的是异步刷新路径 —— 要么接线，要么删掉这个声明。

### D9 🟢 账号表的三处维护功能全是死的

| 函数 | 位置 | 状态 |
|---|---|---|
| `deleteStaleAuthRows` | `db/users.ts:367` | 零调用 —— 没人清理过期的 `oauth_states` / `user_sessions` |
| `signOutEverywhere` | `lib/user-session.ts:166` | 零调用 |
| `deleteSessionsForUser` | `db/users.ts:309` | 只被上面那个死函数调用 |

账号表建起来还不到一天，所以**还没有任何过期行**，这不是正在发生的问题。但没有 cron（§2.1）也没有手动入口，它会一直是这样 —— 一个读者每天登录一次，一年后就有一堆永不失效的 `oauth_states` 行躺在表里。

### ~~D10~~ ✅ 已修（2026-10-12，`1261fe7`）：抓取失败会把已归档的文章永久卡在 `failed`

**症状**：13 篇文章在后台看不见、公开站也搜不到，但它们的**内容已经完整解析好了**。抽查 `beku-ai`：87 个 block、3,427 字完整日语正文，R2 里 `versions/v1/article.json` 就在那。

**根因链**：抓取**拥有**文章状态，解析**不拥有**（这个分工本身是对的 —— 机器步骤不该覆盖编辑决定）。但抓取可能**在写下 capture 之后才失败**：重试时 `PAGE_BLOCKED`、部分成功后补全。这时文章状态停在 `failed`，而一份完整的文档躺在 R2 里。**没有任何东西会把它挪出来**：编辑的后台列表按 `review` 过滤，公开站按 `published` 过滤，两边都看不到 —— 已经归档成功的内容，表现得像"导入从来没成功"。

**为什么第一次修错了**：先把提升逻辑放在 `handleParse`（队列 handler）里。结果用 admin 自己的 `/parse` 端点重跑那 13 篇**毫无变化** —— 那个端点直接调 `parseArticle`，根本不经过 queue handler。**修完去验证时才发现**，这正是"完成任务要线上验证"的价值。

**修**（`1261fe7`）：`promoteIfStranded` 移到 `services/parse.ts`，在**两条成功路径**上都调用 —— 完整解析，以及 `unchanged` 早返回。第二条同样重要：重跑一篇已解析的文章走的正是 `unchanged` 路径，而"重跑"就是修一篇卡住文章的方式。守卫只提升 `failed`（`pending`/`fetching` 表示抓取还在跑，竞争会出错；`published`/`takedown`/`archived`/`rejected` 是编辑决定，机器不能覆盖）。

**结果**：`review` 70 → 83，`failed` 22 → 9（那 9 篇是真的没抓到，无 raw）。7 个测试，其中一个专门断言提升逻辑在 service 而不是在调用方 —— 那正是犯过的错。

---

## 17. 未接线与死代码

### 完全未调用

| 导出 | 位置 | 说明 |
|---|---|---|
| `applyRankingScores` | `services/publish.ts:183` | 零调用；已被 `refreshRanking` 取代 |
| `restoreArticle` | — | D3 |
| `deleteDisplayMode` | — | D5 |
| `deleteArticle` | — | D5，**不可逆且留下孤儿 R2 对象** |
| `deleteStaleAuthRows` | `db/users.ts:367` | 零引用 —— 清理过期 `oauth_states` / `user_sessions` 的函数写好了但**没有任何调用点** |

> `services/seed-demo.ts`（480 行）**是接线的** —— 导出 `seedDemoArticles` / `removeDemoArticles`，被 `/api/admin/demo/seed` 和 `/demo/clear` 用着。
>
> `signOutEverywhere`（`lib/user-session.ts:166`）包了 `deleteSessionsForUser` 但自己也是零调用者 —— 全端登出的整条链都是死的。

### 类型存在但无实现

```ts
// src/jobs/dispatch.ts
ai:      notImplemented('ai'),
metrics: notImplemented('metrics'),
reindex: notImplemented('reindex'),
```

`AI` binding 已配置但从未调用。

### 未实现的 API 面

- **硬删除**（D5）：功能在代码里，入口不在
- **全端登出**：`signOutEverywhere` → `deleteSessionsForUser` 整条链写好了但零调用
- **过期行清理**：`deleteStaleAuthRows` 零调用（且没有 cron 可挂，见 §2.1）
- **`link_to_user_id` 恢复**：加第二个 provider 时的安全决策，见 §13.3

### 已知的功能缺口（有意为之）

- **用户功能**：账号体系存在但**不挂任何功能**（无收藏、无评论、无付费墙）。这是有意的 —— 见 SPEC §43.1
- **视频**：见 §9
- **Science / Ideas 空分类**：见 §12

---

## 18. 运维手册

### 18.1 常用命令

```bash
npx wrangler d1 migrations apply x-article-hub --remote
npx wrangler d1 execute x-article-hub --remote --command "SELECT …"

npm run build && npm run deploy
npm run deploy     # = build + wrangler deploy -c dist/server/wrangler.json

npx vitest run                                  # 335 个单元测试
./scripts/smoke.sh https://… 12345678            # 生产验收，跑完必须 cleanup
./scripts/smoke-site.sh https://… 12345678
./scripts/cleanup-smoke.sh https://… 12345678
```

### 18.2 Cloudflare 特有的坑

| 坑 | 说明 |
|---|---|
| **D1 拒绝 `BEGIN/COMMIT`** | 多语句必须 `db.batch()`，或写成单语句（`takeOAuthState` 用 `DELETE … RETURNING` 就是为了原子） |
| **`snippet()` 按列名寻址会退回第 0 列** | 必须用位置参数，见 §14 |
| **同一 `created_at` 的 JOIN 要起别名** | 不起别名时后者静默覆盖前者。`findSessionWithUser` 曾因此把会话创建时间记成账号创建时间 |
| **静态资源边缘缓存** | 验证前先加缓存破坏参数，并断言抓到的是新副本 |
| **POST 需要同源 `Origin` 头** | Cloudflare/Astro 都拒 |
| **`curl --http1.1`** | 偶尔 HTTP/2 framing error |

### 18.3 排查顺序

| 现象 | 先查 |
|---|---|
| 页面 500 | `wrangler tail` |
| 导入没反应 | 是否 `not-configured` / 是否超出 `MAX_IMPORT_URLS` |
| 抓取失败 | `crawl_jobs` 的 `error_code` + `error_message` |
| 搜索无结果 | `articles_fts` 是否有行；CJK 是否需要回填 |
| 榜单顺序相同 | 理论上不该再发生了（§11 已重建排序）；若再现，查 `final_score` 是否全 NULL |
| 登录失败 | 日志的 `oauth_state_rejected` / `oauth_token_exchange_failed` |
| 图片没归档 | `media_objects.status = 'failed'` + `error_code` |
| 进不了 admin | 日志的 `admin_denied_role`（会写明是哪个账号） |

### 18.4 数据完整性检查

```sql
-- 分数是否已计算（榜单排序的前提）
SELECT COUNT(*) FROM articles WHERE final_score IS NOT NULL;      -- 应等于已发布数

-- 互动数据覆盖率（§16 D1：X 对部分文章不返回互动栏，远小于已发布数属正常）
SELECT COUNT(DISTINCT article_id) FROM article_metrics WHERE views IS NOT NULL;

-- 分类全在 editor 侧（D 的确认）
SELECT COUNT(*) FROM articles WHERE category_id IS NOT NULL;      -- 0 = AI 层未接线

-- 媒体是否有非图片
SELECT content_type, COUNT(*) FROM media_objects GROUP BY content_type;
```

---

## 附：与设计文档的差异汇总

设计文档 `x-article-curated-site-development-spec.md` 有 53 个编号章节。以下是本文档与它的实质性差异：

| 设计文档说 | 实际 |
|---|---|
| §13 AI 分类建议 | `ai` job 类型 `notImplemented`，`category_id` 全 NULL |
| §14 Ranking | 已由 `refreshRanking` + `*/30` cron 接管 |
| §21 Cron Triggers | `triggers` 为空 |
| §10 媒体含视频 | 三层无视频概念 |
| §16 Admin 摘要编辑 | `overrideSummary` 无界面 |
| §30 Wrangler 绑定骨架 | 无 KV、无 cron、无 DO |
| §43 账号（曾 X + Google） | 只有 Google，且删掉了跨 provider 合并 |
| — | 设计文档里没有的：`/featured` 板块、`/account`、三态主题切换、CJK 预分词搜索 |

**以本文档为准。** 它是对着生产环境核对的。
