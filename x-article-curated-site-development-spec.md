# X Article 精选站开发文档

> 版本：v1.0
> 日期：2026-09-29
> 目标：构建一个完全基于 Cloudflare 的 X Article 精选、归档、分类、热度排序与阅读网站。

---

## 1. 项目概述

### 1.1 产品定位

本项目不是 X 全网内容爬虫，也不是 X 实时热榜。

核心工作流是：

**人工发现值得阅读的 X Article → 后台批量导入 URL → Cloudflare Browser Run 自动抓取 → 原文归档 → 内容标准化 → AI 辅助分类/摘要/Tag → 计算精选池内部热度 → 人工审核发布 → 前台按分类、热度、趋势和精选展示。**

产品可以理解为：

> 一个由人工策展、机器整理和 AI 辅助理解驱动的 X Article 内容档案馆。

### 1.2 第一阶段范围

必须支持：

- 后台粘贴一个或多个 X Article URL
- URL 标准化与去重
- 自动抓取渲染后的 Article 页面
- 原始 HTML / Markdown / 截图归档到 R2
- Article 正文解析为内部统一格式
- 作者、标题、发布时间、原始 URL 等元数据提取
- 图片下载并保存到 R2
- Workers AI 生成摘要、分类、Topic、Tag
- 管理员人工审核和修改分类
- 文章发布 / 下架 / 删除
- 分类筛选
- 热度排序
- 最新排序
- 趋势排序
- Article 阅读页
- 原文 X 链接
- 基础全文搜索

### 1.3 第二阶段范围

- 语义搜索
- Related Articles
- Vectorize
- 作者档案页
- 作者质量分
- Trending / Rising / Editor's Pick 多榜单
- Article 版本 diff
- 自动更新 metrics
- 内容推荐
- Newsletter / RSS / Sitemap 自动化

### 1.4 明确不做

第一阶段不做：

- X API
- X 全站 Discovery
- X 用户时间线自动扫描
- 实时全网热榜
- Elasticsearch
- 自建 Playwright/Puppeteer 集群
- Kubernetes
- 独立 VPS
- 复杂多租户 CMS

---

# 2. 总体架构

```text
                         ┌─────────────────────┐
                         │       Admin         │
                         │  粘贴 Article URL    │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │      Hono API       │
                         │ normalize / dedup   │
                         └──────────┬──────────┘
                                    │
                                    ▼
                               Cloudflare D1
                                    │
                              create crawl job
                                    │
                                    ▼
                             Cloudflare Queues
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │   Crawl Worker      │
                         │ Browser Run         │
                         │  /markdown         │
                         │  /content          │
                         └──────────┬──────────┘
                                    │
                     ┌──────────────┼──────────────┐
                     ▼                             ▼
                raw HTML/MD                    screenshot
                     │                             │
                     └──────────────┬──────────────┘
                                    ▼
                              Cloudflare R2
                              raw archive
                                    │
                                    ▼
                              Parser Worker
                                    │
                                    ▼
                           normalized Article JSON
                                    │
                                    ▼
                              Workers AI
                   ┌────────────────┼────────────────┐
                   ▼                ▼                ▼
                 Summary         Category           Tags
                   │                │                │
                   └────────────────┼────────────────┘
                                    ▼
                                   D1
                                    │
                     ┌──────────────┴─────────────┐
                     ▼                            ▼
                  Ranking                     FTS5 Search
                     │                            │
                     └──────────────┬─────────────┘
                                    ▼
                            Astro + Workers
                               Public Site
```

Cloudflare Browser Run 当前提供 Quick Actions，包括 `/content`、`/markdown`、`/screenshot`、`/scrape`、`/json`、`/links` 等；也支持通过 Workers Binding 直接调用。对于复杂浏览器自动化，则可使用 Playwright/Puppeteer/CDP/Stagehand。参考：[Browser Run](https://developers.cloudflare.com/browser-run/)。

---

# 3. Cloudflare 服务选型

| 能力 | Cloudflare 服务 | 角色 |
|---|---|---|
| 前端 | Astro + Workers | SEO、SSR、页面渲染 |
| API | Hono + Workers | REST API、Admin API |
| 关系数据库 | D1 | 元数据、状态、分类、评分、索引 |
| 对象存储 | R2 | HTML、Markdown、JSON、图片、截图 |
| 异步消息 | Queues | 抓取、解析、AI 等异步任务 |
| 浏览器 | Browser Run | X Article 页面抓取 |
| AI | Workers AI | 摘要、分类、Tag、质量分析 |
| 全文搜索 | D1 FTS5 | 标题和正文关键词搜索 |
| 定时任务 | Cron Triggers | 指标刷新、重算排名、维护 |
| 语义搜索 | Vectorize | 第二阶段增加 |
| Admin 鉴权 | Cloudflare Access | 后台保护 |
| CDN | Cloudflare Cache | 首页、分类页、Article 缓存 |
| 安全 | WAF / Rate Limiting | 防滥用、后台和 API 防护 |

D1 基于 SQLite，并支持 FTS5；R2 用于非结构化对象存储，且当前 Internet egress 不收费。Workers Paid 当前基础订阅为每账号每月 $5，其他组件按实际用量计费。具体价格应以部署时 Cloudflare 官方定价页为准。

参考：
- [D1 SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
- [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)

---

# 4. 核心设计原则

## 4.1 人工负责“选什么”

人工从 X 上发现 Article，并决定是否值得进入候选池。

系统不承担 X 全网发现任务。

## 4.2 Browser Run 负责“搬回来”

不要在 Worker 内自己维护浏览器集群。

默认使用 Browser Run Quick Actions。

## 4.3 Parser 负责“整理”

前端绝不直接消费 X 原始 HTML。

必须转换为内部标准 ArticleDocument。

## 4.4 Workers AI 负责“读懂”

AI 负责：

- 摘要
- 分类建议
- Topic
- Tag
- 可选质量分析

AI 不直接决定最终发布和排序。

## 4.5 D1 负责“索引”

所有可查询的数据进入 D1；大对象和原始归档进入 R2。

## 4.6 R2 负责“保存原貌”

原始抓取结果必须保留，确保 Parser 可以重新运行。

## 4.7 人工审核拥有最终解释权

AI 的 category/tag/quality 都视为 suggestion。

数据库必须允许 editor override。

---

# 5. URL 导入设计

## 5.1 支持的输入

后台可以一次提交：

- 单条 URL
- 多行 URL
- TXT
- CSV（第二阶段）

示例：

```text
https://x.com/username/article/123456789
https://x.com/another/article/987654321
```

## 5.2 URL Normalization

处理：

1. trim whitespace
2. URL decode
3. 统一协议为 `https`
4. 删除 tracking query 参数
5. 删除 fragment
6. 将 `twitter.com` / `www.x.com` 等可识别形式标准化
7. 提取 canonical URL

内部保存：

```text
source_url
canonical_url
```

## 5.3 去重策略

优先级：

```text
canonical_url UNIQUE
```

如果后续 Parser 能提取稳定 Article ID，则增加：

```text
x_article_id UNIQUE
```

重复导入时不要创建新 Article，而是返回已有 Article：

```json
{
  "status": "duplicate",
  "articleId": "art_xxx"
}
```

---

# 6. Article 状态机

```text
                    ┌──────────────┐
                    │   imported   │
                    └──────┬───────┘
                           ▼
                       queued
                           │
                           ▼
                       fetching
                      /         \
                     /           \
                  success       failure
                    │               │
                    ▼               ▼
                 fetched        retrying
                    │               │
                    ▼               ▼
                  parsing       failed
                    │
                    ▼
                  parsed
                    │
                    ▼
                enriching
                    │
                    ▼
                 ai_ready
                    │
                    ▼
                  review
                 /       \
                /         \
            published    rejected
                │
                ▼
             archived
```

建议 `articles.status`：

```text
pending
fetching
fetched
parsing
review
published
rejected
archived
takedown
failed
```

---

# 7. Browser Run 抓取策略

## 7.1 两级抓取

### Level 1：Quick Action

优先使用：

```text
/markdown
/content
/screenshot
```

建议顺序：

```text
Article URL
   ↓
/markdown
   ↓
是否有效？
   ├─ Yes → 保存
   └─ No  → /content
              ↓
           自定义 Parser
              ↓
          仍失败？
              ↓
        Browser Session
           Playwright
```

Browser Run `/markdown` 可以直接把网页转换为 Markdown，官方文档也将“文章保存、下游摘要、diff、embedding”作为典型用途；`/content` 用于获得执行 JS 后的完整渲染 HTML。

参考：
- [Browser Run Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/)
- [Markdown Endpoint](https://developers.cloudflare.com/browser-run/quick-actions/markdown-endpoint/)
- [Content Endpoint](https://developers.cloudflare.com/browser-run/quick-actions/content-endpoint/)

## 7.2 Level 1：Markdown 抓取

优点：

- 实现简单
- 输出适合 LLM
- 方便保存
- 页面 CSS / script 干扰少

缺点：

- 对复杂 X 页面结构的控制力有限
- 元数据和媒体映射需要额外处理

## 7.3 Level 2：Content HTML

保存 Browser Run 返回的完整 HTML：

```text
R2:
articles/{articleId}/raw/page.html
```

用于：

- 重新解析
- DOM 调试
- 找不到正文时 fallback

## 7.4 Level 3：Playwright

只在 Quick Action 不可靠时启用。

典型逻辑：

```ts
await page.goto(url, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});

await page.waitForSelector("main", {
  timeout: 60000,
});

const html = await page.content();
```

注意：X 页面 DOM 属于外部站点结构，Selector 不应散落在业务代码中，应集中在：

```text
packages/parser/src/x-selectors.ts
```

并允许多个 selector fallback。

---

# 8. 抓取结果归档

推荐 R2 目录：

```text
articles/
  {article_id}/
    raw/
      page.html
      page.md
      metadata.json
      screenshot.webp

    versions/
      v1/
        article.json
        article.md
        article.html
      v2/
        article.json
        article.md
        article.html

    media/
      cover.webp
      001.webp
      002.webp
```

原则：

> Raw 永远只追加，不覆盖；Normalized 可以由 Parser 重建。

---

# 9. Article Parser

Parser 的职责不是判断文章价值，而是将 X 页面转换成内部统一格式。

## 9.1 输出模型

```ts
export interface ArticleDocument {
  title: string;

  author: {
    name: string;
    username: string;
    avatar?: string;
  };

  publishedAt?: string;

  blocks: ArticleBlock[];

  links: ArticleLink[];
  images: ArticleImage[];

  source: {
    url: string;
    parserVersion: number;
    capturedAt: string;
  };
}
```

## 9.2 Block 类型

```ts
export type ArticleBlock =
  | {
      type: "paragraph";
      text: string;
    }
  | {
      type: "heading";
      level: 1 | 2 | 3;
      text: string;
    }
  | {
      type: "quote";
      text: string;
    }
  | {
      type: "list";
      ordered: boolean;
      items: string[];
    }
  | {
      type: "image";
      imageId: string;
    }
  | {
      type: "code";
      language?: string;
      code: string;
    }
  | {
      type: "embed";
      postId: string;
    };
```

## 9.3 Parser 原则

- 保留段落结构
- 保留 Heading 层级
- 保留链接
- 保留图片顺序
- 保留 Quote
- 尽量保留代码块
- 删除脚本和无关 UI
- 不在 Parser 阶段改写原文
- 不做 LLM 重写

---

# 10. 媒体处理

图片不要依赖前台直接加载 X 的 URL。

流程：

```text
source image URL
      ↓
Worker fetch
      ↓
content-type check
      ↓
optional image transform
      ↓
R2
```

R2 Key：

```text
articles/{articleId}/media/001.webp
```

D1 保存：

```text
image_id
article_id
position
source_url
r2_key
width
height
alt_text
```

失败图片不应导致整篇 Article 失败。

状态：

```text
ready
failed
external_fallback
```

---

# 11. D1 数据模型

## 11.1 authors

```sql
CREATE TABLE authors (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  bio TEXT,
  article_count INTEGER NOT NULL DEFAULT 0,
  quality_score REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## 11.2 categories

```sql
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

## 11.3 tags

```sql
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

## 11.4 articles

```sql
CREATE TABLE articles (
  id TEXT PRIMARY KEY,

  source_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,

  x_article_id TEXT UNIQUE,
  x_post_id TEXT,

  title TEXT NOT NULL,
  excerpt TEXT,

  author_id TEXT,
  author_name TEXT,
  author_username TEXT,
  author_avatar TEXT,

  published_at INTEGER,
  imported_at INTEGER NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending',

  category_id TEXT,

  ai_summary TEXT,
  ai_category TEXT,
  ai_confidence REAL,

  editor_category_id TEXT,
  editor_summary TEXT,

  quality_score REAL,
  popularity_score REAL,
  velocity_score REAL,
  editor_score REAL,
  final_score REAL,

  parser_version INTEGER NOT NULL DEFAULT 1,

  content_r2_key TEXT,
  raw_r2_key TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## 11.5 article_tags

```sql
CREATE TABLE article_tags (
  article_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ai',
  PRIMARY KEY (article_id, tag_id),
  FOREIGN KEY (article_id) REFERENCES articles(id),
  FOREIGN KEY (tag_id) REFERENCES tags(id)
);
```

`source`：

```text
ai
editor
```

## 11.6 article_versions

```sql
CREATE TABLE article_versions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(article_id, version)
);
```

## 11.7 article_metrics

```sql
CREATE TABLE article_metrics (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,

  likes INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  quotes INTEGER NOT NULL DEFAULT 0,
  bookmarks INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0
);
```

说明：由于本项目不使用 X 官方 API，metrics 获取应作为独立能力设计，不应阻塞 Article 正文归档。如果浏览页面无法可靠取得某项指标，该项可以为空或 0，Ranking 必须允许部分指标缺失。

## 11.8 crawl_jobs

```sql
CREATE TABLE crawl_jobs (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,

  job_type TEXT NOT NULL,
  status TEXT NOT NULL,

  attempt_count INTEGER NOT NULL DEFAULT 0,

  error_code TEXT,
  error_message TEXT,

  started_at INTEGER,
  completed_at INTEGER,

  created_at INTEGER NOT NULL
);
```

## 11.9 curation_events

```sql
CREATE TABLE curation_events (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
```

例如：

```text
import
publish
reject
archive
restore
takedown
category_override
summary_override
featured
unfeatured
```

---

# 12. 全文搜索

D1 使用 FTS5。

建议建立：

```text
articles_fts
```

字段：

```text
title
excerpt
content_text
author_name
author_username
tags_text
```

正文全文可以存在 R2，但将纯文本索引字段同步到 D1。

搜索流程：

```text
Query
 ↓
FTS5
 ↓
article ids
 ↓
D1 JOIN
 ↓
status = published
 ↓
Ranking / freshness
```

D1 当前支持 FTS5，因此第一阶段无需 Elasticsearch。

参考：[D1 SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/)。

---

# 13. Workers AI 设计

## 13.1 AI 的定位

Workers AI 是“编辑助手”，不是总编辑。

它主要负责：

1. 摘要
2. 分类建议
3. Topic
4. Tag
5. 可选质量分析

它不直接决定：

- 是否发布
- 是否 Featured
- 首页最终排序

## 13.2 AI Pipeline

```text
ArticleDocument
      ↓
prepareAiInput()
      ↓
Workers AI
      ↓
JSON Schema
      ↓
validate()
      ↓
D1
```

Workers AI 当前支持 JSON Mode，可要求模型按照 JSON Schema 返回结构化对象；但官方同时提示模型不能在极端情况下保证 100% 满足 Schema，因此应用必须做 schema validation 和失败重试。

参考：[Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)。

## 13.3 AI 输出

```json
{
  "summary": "...",
  "category": "AI",
  "topics": [
    "AI Agents"
  ],
  "tags": [
    "Coding",
    "Claude",
    "OpenAI"
  ],
  "quality": {
    "information_density": 88,
    "originality": 81,
    "insight": 90,
    "actionability": 72,
    "overall": 84
  }
}
```

## 13.4 AI 输入控制

不要直接把任意 HTML 给模型。

先使用：

```text
ArticleDocument → plain text
```

并限制长度。

对于超长 Article：

```text
full text
 ↓
chunk
 ↓
summarize chunk
 ↓
aggregate summary
```

第一阶段可以限制文章输入到模型的最大字符/token 数量。

## 13.5 分类体系

初版：

```text
AI
Technology
Business
Science
Ideas
```

二级 Topic：

```text
AI
├── Models
├── Agents
├── Coding
├── Robotics
└── AI Business

Technology
├── Developer Tools
├── Hardware
├── Semiconductor
├── Cloud
└── Open Source

Business
├── Startup
├── SaaS
├── Venture
├── Strategy
└── Markets

Science
├── Biology
├── Physics
├── Space
└── Mathematics

Ideas
├── Philosophy
├── Future
├── Society
└── Culture
```

不要第一版设计超过 10 个一级分类。

---

# 14. Ranking 设计

不要单纯按照 Likes 排名。

系统保留三个独立分数：

```text
popularity_score
velocity_score
quality_score
```

## 14.1 Popularity

对量级做 log 压缩：

```text
popularity =
  0.30 * log(likes + 1)
+ 0.25 * log(reposts + 1)
+ 0.15 * log(replies + 1)
+ 0.10 * log(quotes + 1)
+ 0.10 * log(bookmarks + 1)
+ 0.10 * log(views + 1)
```

之后做 min-max 或 percentile normalization 到 0~100。

## 14.2 Velocity

计算：

```text
Δlikes / Δtime
Δreposts / Δtime
Δviews / Δtime
```

建议使用多个时间窗口：

```text
1h
6h
24h
```

避免单次短期尖峰造成异常。

## 14.3 Quality

第一版：

```text
quality_score = AI quality
```

但它不能决定发布。

## 14.4 Final Score

建议初始：

```text
final_score =
  0.40 * popularity_score
+ 0.30 * velocity_score
+ 0.20 * quality_score
+ 0.10 * editor_score
```

权重必须配置化：

```json
{
  "popularity": 0.40,
  "velocity": 0.30,
  "quality": 0.20,
  "editor": 0.10
}
```

不要把权重写死在代码里。

---

# 15. 榜单设计

首页提供四个视图：

### Latest

```text
published_at DESC
```

### Trending

```text
final_score DESC
```

### Rising

```text
velocity_score DESC
```

### Editor's Pick

```text
featured = true
```

这样“人工精选”与“机器排序”并存。

---

# 16. Admin 后台

## 16.1 Dashboard

```text
Articles
  Published: 132
  Review: 18
  Processing: 4
  Failed: 2

Today
  Imported: 23
  Published: 16
  Failed: 1
```

## 16.2 Import

```text
┌─────────────────────────────────────┐
│ Import X Articles                  │
│                                     │
│ Paste URLs, one per line             │
│                                     │
│ https://x.com/...                    │
│ https://x.com/...                    │
│ https://x.com/...                    │
│                                     │
│             [ Import ]               │
└─────────────────────────────────────┘
```

## 16.3 Review

每篇 Article 展示：

```text
Original URL
Title
Author
Excerpt
Preview
Category
Topics
Tags
AI Summary
AI Quality
Fetch status
Media status
```

按钮：

```text
Publish
Reject
Retry
Archive
Featured
Edit Category
Edit Summary
```

## 16.4 Failed Jobs

必须提供：

```text
Retry
Retry with Browser Session
View Raw HTML
View Error
```

---

# 17. Public Site

## 17.1 路由

```text
/
/latest
/trending
/rising
/category/:slug
/tag/:slug
/author/:username
/article/:slug
/search
/about
```

## 17.2 Article 页面

建议结构：

```text
Category / Topics

Title

Author
Published Time

Score / Metrics

────────────────────

Article Body

────────────────────

Tags

[ View Original on X ]

Related Articles
```

## 17.3 首页

首页不是传统 CMS 列表，应突出内容发现：

```text
X ARTICLE

Today's Selection

🔥 Trending

📈 Rising Fast

⭐ Editor's Picks

AI
Technology
Business
Science
Ideas
```

---

# 18. Related Articles / Vectorize

第二阶段启用。

流程：

```text
Article
 ↓
Workers AI embedding
 ↓
Vectorize
 ↓
Top K similar
 ↓
D1 metadata filter
 ↓
Related Articles
```

建议过滤：

```text
status = published
language = current article language
category = optional
```

Workers AI 可以生成 embedding，Vectorize 负责向量索引与相似度查询。参考：[Vectorize + Workers AI](https://developers.cloudflare.com/vectorize/get-started/embeddings/)。

---

# 19. Queue 设计

建议不要只建立一个 queue。

第一阶段：

```text
article-ingest
article-process
article-metrics
```

消息格式统一：

```ts
interface JobMessage {
  jobId: string;
  articleId: string;
  type:
    | "crawl"
    | "parse"
    | "ai"
    | "metrics"
    | "reindex";
  attempt: number;
  createdAt: number;
}
```

### Queue 处理原则

- 消费者必须幂等
- 状态写 D1
- 错误可 retry
- 超过 retry 次数进入 failed
- 不允许因为单张图片失败导致整个 Article 失败

Queues 用于异步处理和解耦 producer / consumer，适合把抓取、解析、AI 等长链路从 HTTP 请求中剥离。

参考：[Cloudflare Queues](https://developers.cloudflare.com/queues/)。

---

# 20. 是否使用 Workflows

### MVP：不使用

第一阶段：

```text
D1 → Queue → Worker
```

即可。

### 第二阶段：可引入

当 Article Pipeline 达到：

```text
crawl
→ media
→ parse
→ AI
→ embedding
→ metrics
→ publish
```

并希望支持每一步 durable retry / resume 时，引入 Workflows。

Workflows 更适合可恢复的长生命周期任务；Queues 继续承担大量异步消息。

---

# 21. Cron Triggers

建议：

```text
*/15 * * * *     metrics refresh
0 * * * *        ranking refresh
0 3 * * *        maintenance
0 4 * * *        sitemap refresh
```

第一阶段不需要自动 Discovery，因此 Cron 不是用来找新 Article，而主要用于：

- metrics
- ranking
- maintenance
- sitemap
- re-index

Cloudflare Cron Triggers 使用 UTC 时间执行。

参考：[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

---

# 22. API 设计

## Public API

```text
GET /api/articles
GET /api/articles/:slug
GET /api/categories
GET /api/categories/:slug/articles
GET /api/tags/:slug/articles
GET /api/trending
GET /api/rising
GET /api/search?q=...
GET /api/authors/:username
```

## Admin API

```text
POST   /api/admin/articles/import
GET    /api/admin/articles
GET    /api/admin/articles/:id
PATCH  /api/admin/articles/:id
POST   /api/admin/articles/:id/retry
POST   /api/admin/articles/:id/publish
POST   /api/admin/articles/:id/reject
POST   /api/admin/articles/:id/archive
POST   /api/admin/articles/:id/featured
DELETE /api/admin/articles/:id
```

### Import API 示例

```http
POST /api/admin/articles/import
Content-Type: application/json
```

```json
{
  "urls": [
    "https://x.com/foo/article/123",
    "https://x.com/bar/article/456"
  ]
}
```

响应：

```json
{
  "created": 2,
  "duplicates": 0,
  "failed": 0,
  "articles": [
    {
      "id": "art_123",
      "status": "queued"
    }
  ]
}
```

---

# 23. Cache 策略

### Homepage

```text
TTL = 60s
```

### Category

```text
TTL = 300s
```

### Article

```text
TTL = 3600s
```

### Admin

```text
no-store
```

### API

根据 endpoint 单独配置：

```text
/articles          60s
/trending          60s
/categories        1h
/search            30s
```

缓存 key 必须包含：

```text
pathname
query string
```

发布 Article 后，可以主动 purge 对应 URL 或等待 TTL。

---

# 24. Admin 安全

Admin 站点建议：

```text
admin.example.com
       ↓
Cloudflare Access
       ↓
Astro Admin
```

不要自己实现完整管理员认证。

Cloudflare Access 可以位于自托管应用前面，根据 identity provider 和 policy 控制访问。

参考：[Cloudflare Access Web Applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)。

---

# 25. 错误与重试

## Crawl errors

```text
FETCH_TIMEOUT
PAGE_BLOCKED
EMPTY_CONTENT
ARTICLE_NOT_FOUND
LOGIN_REQUIRED
PARSER_FAILED
```

## AI errors

```text
AI_TIMEOUT
INVALID_JSON
SCHEMA_MISMATCH
MODEL_ERROR
TOKEN_LIMIT
```

## Media errors

```text
IMAGE_FETCH_FAILED
INVALID_CONTENT_TYPE
IMAGE_TOO_LARGE
```

### Retry policy

```text
Attempt 1 → 1 min
Attempt 2 → 5 min
Attempt 3 → 30 min
Attempt 4 → 2 h
Attempt 5 → 24 h
```

超过 5 次：

```text
failed
```

Admin 可以手动 Retry。

Browser Run Quick Actions 的页面加载、selector、action 都有单独 timeout，因此抓取 Worker 必须记录 timeout 类型，不要简单统一成“抓取失败”。

---

# 26. Browser Run 的 X 页面特殊处理

必须考虑：

1. 未登录与登录状态差异
2. Cookie / Session
3. 页面结构变化
4. 懒加载图片
5. 非 Article Post
6. Article 内容为空
7. 页面跳转
8. X 限制自动化访问
9. 403 / 429
10. CAPTCHA / challenge

### 设计原则

不要：

```text
if selector === "某个具体 class"
```

而应该：

```text
semantic selector
→ fallback selector
→ content extraction heuristic
```

并将 Selector / heuristic 全部集中管理。

如果未来需要处理登录或人工介入场景，可以升级到 Browser Session + Playwright。

---

# 27. Parser Versioning

数据库保存：

```text
parser_version = 1
```

以后：

```text
parser_version = 2
```

重新执行：

```text
R2 raw
 ↓
Parser v2
 ↓
ArticleDocument v2
```

不要重新访问 X。

这是为什么必须保留 Raw HTML / Markdown 的原因。

---

# 28. Article Versioning

同一篇 Article 如果再次抓取：

```text
source_hash old == new
```

则：

```text
不创建新版本
```

如果：

```text
source_hash old != new
```

创建：

```text
v2
```

记录：

```text
source_hash
content_hash
parser_version
captured_at
```

未来可以做：

```text
Article updated
View changes
```

---

# 29. 项目目录

建议采用 monorepo，但 MVP 保持简单：

```text
x-article-hub/
├── apps/
│   ├── web/
│   └── admin/
│
├── worker/
│   ├── api/
│   ├── jobs/
│   └── index.ts
│
├── packages/
│   ├── db/
│   │   ├── schema/
│   │   └── queries/
│   ├── parser/
│   │   ├── x/
│   │   └── types.ts
│   ├── ai/
│   ├── ranking/
│   └── shared/
│
├── migrations/
├── scripts/
├── tests/
│   ├── parser/
│   ├── ranking/
│   └── api/
│
├── wrangler.jsonc
├── package.json
└── README.md
```

如果初期只有一个开发者，可以进一步压缩为：

```text
src/
  api/
  jobs/
  parser/
  ai/
  ranking/
  db/
  routes/
```

---

# 30. Wrangler 绑定骨架

下面是概念配置，正式创建资源后填写实际 ID：

```jsonc
{
  "name": "x-article-hub",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-24",

  "browser": {
    "binding": "BROWSER",
    "remote": true
  },

  "ai": {
    "binding": "AI"
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "x-article-hub",
      "database_id": "YOUR_D1_DATABASE_ID"
    }
  ],

  "r2_buckets": [
    {
      "binding": "ARCHIVE",
      "bucket_name": "x-article-archive"
    }
  ],

  "queues": {
    "producers": [
      {
        "binding": "ARTICLE_INGEST_QUEUE",
        "queue": "article-ingest"
      }
    ],
    "consumers": [
      {
        "queue": "article-ingest",
        "max_batch_size": 10,
        "max_batch_timeout": 30
      }
    ]
  }
}
```

Browser Run Quick Actions 通过 Worker binding 调用时不需要 Browser Run API token；当前文档要求 compatibility date 至少为 `2026-03-24`，本地开发如使用 Quick Action 需要 remote mode。

参考：[Browser Run Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/)。

---

# 31. Worker 核心逻辑

## HTTP

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env) {
    for (const message of batch.messages) {
      await handleJob(message.body, env);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledJobs(controller.cron, env));
  }
};
```

## Crawl Job

```ts
async function crawlArticle(job: JobMessage, env: Env) {
  await setJobStatus(job.jobId, "fetching");

  const markdown = await env.BROWSER.quickAction("markdown", {
    url: await getArticleUrl(job.articleId, env.DB),
  });

  // validate result
  // save raw markdown to R2
  // optionally fetch rendered HTML
  // enqueue parse job
}
```

注意：实际 Browser Run 返回结构、错误对象和 SDK 类型以当前安装版本为准，开发时应直接对照官方 API Reference。

---

# 32. AI 调用设计

概念：

```ts
const result = await env.AI.run(MODEL, {
  messages,
  response_format: {
    type: "json_schema",
    json_schema: schema
  }
});
```

Workers AI 使用 binding 后，可以通过 `env.AI.run()` 调用模型。

模型选择不要硬编码成永久标准，应在：

```text
config/ai.ts
```

集中配置：

```ts
export const AI_CONFIG = {
  model: "<selected-model>",
  embeddingModel: "<selected-embedding-model>",
  maxInputChars: 30000,
};
```

当前 Workers AI 模型目录持续更新，因此正式开发时应以部署时模型目录和能力为准。

参考：[Workers AI Models](https://developers.cloudflare.com/workers-ai/models/)。

---

# 33. SEO

这是一个内容网站，因此 SEO 是核心能力。

每个 Article 必须有：

```text
<title>
<meta name="description">
canonical
OpenGraph
Twitter Card
JSON-LD Article
```

生成：

```text
/sitemap.xml
/robots.txt
/feed.xml
```

Article canonical 应指向自己的 Article 页面，同时显式提供：

```text
View Original on X
```

不要在 canonical 上混淆站内归档和 X 原始页面。

---

# 34. 性能目标

MVP 目标：

| 指标 | 目标 |
|---|---:|
| 首页 TTFB | < 500ms（缓存命中） |
| Article TTFB | < 500ms（缓存命中） |
| FTS 搜索 | < 500ms |
| 导入 API | < 300ms，不等待抓取 |
| Article 抓取 | 异步 |
| AI 处理 | 异步 |
| 图片 | R2/CDN |

绝不能让：

```text
POST /import
```

同步等待：

```text
Browser Run + AI + media
```

必须立即返回 Queue Job 状态。

---

# 35. 可观测性

每一个 Article Job 都必须有：

```text
job_id
article_id
job_type
attempt
started_at
completed_at
duration_ms
status
error_code
```

日志至少包含：

```text
crawl_success
crawl_failed
parse_success
parse_failed
ai_success
ai_failed
media_success
media_failed
publish
```

额外保存：

```text
browser_ms_used
```

Browser Run Quick Actions 会返回浏览器使用时长相关的响应头，可以用来做抓取成本监控。

---

# 36. 成本控制

主要成本来源：

```text
Browser Run
Workers AI
D1 writes
R2 storage / operations
Worker CPU / requests
```

最重要的成本控制原则：

### 1. 不重复抓取

通过 `source_hash` / `content_hash` 判断变化。

### 2. AI 不重复调用

只有以下情况才重新 AI：

```text
新 Article
parser_version changed
content_hash changed
prompt_version changed
```

### 3. 图片不重复下载

使用 hash / source URL 去重。

### 4. 热度更新分层

新文章：

```text
15 min
```

老文章：

```text
1h
```

更老文章：

```text
每天
```

### 5. 前台大量使用 CDN Cache

---

# 37. 内容合规与下架机制

项目涉及第三方内容存档，因此从第一版就应该加入内容治理能力。

数据库支持：

```text
display_mode

full
excerpt
link_only
takedown
```

以及：

```text
takedown_requested_at
takedown_reason
```

后台具备：

```text
Takedown
Archive
Restore
```

技术上不要把“网页抓到了”视为“可以永久公开展示全文”的自动结论。

需要根据内容来源、授权情况、适用法律和 X/作者相关条款制定实际展示政策。

---

# 38. MVP 实施阶段

## Phase 0：基础设施

目标：项目可以部署。

完成：

```text
Astro
Hono
Workers
D1
R2
Queues
Browser binding
Cloudflare Access
```

验收：

```text
npm run deploy
```

成功上线。

## Phase 1：人工导入

实现：

```text
Admin Import
 ↓
D1
 ↓
Queue
```

验收：

- 粘贴 URL
- 自动去重
- 创建 Job
- 返回 Article ID

## Phase 2：抓取归档

实现：

```text
Queue
 ↓
Browser Run
 ↓
R2
```

验收：

- 可以抓取目标 Article
- 保存 raw HTML
- 保存 Markdown
- 失败可 retry

## Phase 3：Parser

实现：

```text
raw
 ↓
ArticleDocument
 ↓
D1
```

验收：

- title
- author
- date
- paragraphs
- images
- links

## Phase 4：AI

实现：

```text
summary
category
topics
tags
quality
```

验收：

- AI JSON 可校验
- 失败可 retry
- 管理员可以 override

## Phase 5：Public Site

实现：

```text
/
/article/:slug
/category/:slug
/search
/trending
/latest
```

## Phase 6：Ranking

实现：

```text
Popularity
Velocity
Quality
Editor's Score
```

## Phase 7：Semantic

以后再加入：

```text
Vectorize
Related
Semantic Search
Recommendations
```

---

# 39. MVP 验收标准

### Import

- [ ] 支持批量 URL
- [ ] URL 标准化
- [ ] 重复 URL 不创建新 Article
- [ ] Import 不同步等待 Crawl

### Crawl

- [ ] Browser Run 成功抓取
- [ ] 保存 HTML
- [ ] 保存 Markdown
- [ ] 保存 screenshot（可选）
- [ ] 支持 retry

### Parser

- [ ] 文章标题正确
- [ ] 作者正确
- [ ] 正文结构正确
- [ ] 图片顺序正确
- [ ] 链接可保留
- [ ] Parser version 可追踪

### AI

- [ ] 摘要生成
- [ ] 分类生成
- [ ] Tag 生成
- [ ] JSON schema validation
- [ ] AI 失败不导致 Article 丢失
- [ ] 管理员可以修改 AI 结果

### Admin

- [ ] Review
- [ ] Publish
- [ ] Reject
- [ ] Archive
- [ ] Retry
- [ ] Featured
- [ ] Takedown

### Public

- [ ] 首页
- [ ] 分类页
- [ ] Article 页
- [ ] 搜索
- [ ] Trending
- [ ] Latest
- [ ] SEO
- [ ] Sitemap

---

# 40. 推荐的最终 MVP 架构

```text
                         ┌──────────────┐
                         │   YOU        │
                         │ Discover X   │
                         └──────┬───────┘
                                │ URL
                                ▼
                         ┌──────────────┐
                         │ Admin / Hono │
                         └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │      D1      │
                         └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │    Queue     │
                         └──────┬───────┘
                                │
                                ▼
                      ┌────────────────────┐
                      │    Browser Run     │
                      │ /markdown + HTML   │
                      └─────────┬──────────┘
                                │
                         ┌──────┴──────┐
                         ▼             ▼
                        R2          Parser
                         │             │
                         │             ▼
                         │        ArticleDocument
                         │             │
                         │             ▼
                         │       ┌───────────┐
                         │       │ Workers AI│
                         │       └─────┬─────┘
                         │             │
                         └─────────────┼─────────┐
                                       ▼         ▼
                                      D1      Ranking
                                       │         │
                                       └────┬────┘
                                            ▼
                                   Astro + Workers
                                            │
                                            ▼
                                         Readers
```

---

# 41. 产品演进方向

第一版形成：

> **人工精选 + 自动归档**

第二版形成：

> **人工精选 + AI 理解 + 热度排序**

第三版形成：

> **内容发现 + 语义关系 + 个性化推荐**

最终可以演变为：

```text
X Article
   ↓
Archive
   ↓
Knowledge Graph
   ↓
Topic / Author / Concept
   ↓
Search / Recommendation
   ↓
Personalized Reading
```

这时产品就不再只是一个“X Article 收藏网站”，而会逐渐变成一个围绕 X 长文建立的内容发现与知识索引系统。

---

# 42. 第一版开发优先级

严格按下面顺序开发：

```text
P0
D1 Schema
R2
Admin Import
Queue
Browser Run
Raw Archive

P1
Parser
Article Page
Publish Workflow
Categories

P2
Workers AI
Summary
Tags
Category Suggestion

P3
Metrics
Popularity
Velocity
Trending

P4
FTS5
Search
Author Page
Tag Page

P5
Vectorize
Related Articles
Semantic Search
```

第一版不要为了“架构完整”提前引入所有 Cloudflare 服务。

**真正应该先验证的只有三个核心假设：**

1. Browser Run 能否稳定抓取你实际选中的 X Article；
2. Parser 能否把抓取结果稳定转换成可阅读的 ArticleDocument；
3. 人工精选 + AI 分类 + 热度排序是否能形成一个比直接刷 X 更有效的阅读体验。

其中第一个是最大的技术风险，应在正式开发前先拿真实 Article URL 做一批抓取测试，并建立 fixture 数据集。
 Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledJobs(controller.cron, env));
  }
};
```

## Crawl Job

```ts
async function crawlArticle(job: JobMessage, env: Env) {
  await setJobStatus(job.jobId, "fetching");

  const markdown = await env.BROWSER.quickAction("markdown", {
    url: await getArticleUrl(job.articleId, env.DB),
  });

  // validate result
  // save raw markdown to R2
  // optionally fetch rendered HTML
  // enqueue parse job
}
```

注意：实际 Browser Run 返回结构、错误对象和 SDK 类型以当前安装版本为准，开发时应直接对照官方 API Reference。

---

# 32. AI 调用设计

概念：

```ts
const result = await env.AI.run(MODEL, {
  messages,
  response_format: {
    type: "json_schema",
    json_schema: schema
  }
});
```

Workers AI 使用 binding 后，可以通过 `env.AI.run()` 调用模型。

模型选择不要硬编码成永久标准，应在：

```text
config/ai.ts
```

集中配置：

```ts
export const AI_CONFIG = {
  model: "<selected-model>",
  embeddingModel: "<selected-embedding-model>",
  maxInputChars: 30000,
};
```

当前 Workers AI 模型目录持续更新，因此正式开发时应以部署时模型目录和能力为准。

参考：[Workers AI Models](https://developers.cloudflare.com/workers-ai/models/)。

---

# 33. SEO

这是一个内容网站，因此 SEO 是核心能力。

每个 Article 必须有：

```text
<title>
<meta name="description">
canonical
OpenGraph
Twitter Card
JSON-LD Article
```

生成：

```text
/sitemap.xml
/robots.txt
/feed.xml
```

Article canonical 应指向自己的 Article 页面，同时显式提供：

```text
View Original on X
```

不要在 canonical 上混淆站内归档和 X 原始页面。

---

# 34. 性能目标

MVP 目标：

| 指标 | 目标 |
|---|---:|
| 首页 TTFB | < 500ms（缓存命中） |
| Article TTFB | < 500ms（缓存命中） |
| FTS 搜索 | < 500ms |
| 导入 API | < 300ms，不等待抓取 |
| Article 抓取 | 异步 |
| AI 处理 | 异步 |
| 图片 | R2/CDN |

绝不能让：

```text
POST /import
```

同步等待：

```text
Browser Run + AI + media
```

必须立即返回 Queue Job 状态。

---

# 35. 可观测性

每一个 Article Job 都必须有：

```text
job_id
article_id
job_type
attempt
started_at
completed_at
duration_ms
status
error_code
```

日志至少包含：

```text
crawl_success
crawl_failed
parse_success
parse_failed
ai_success
ai_failed
media_success
media_failed
publish
```

额外保存：

```text
browser_ms_used
```

Browser Run Quick Actions 会返回浏览器使用时长相关的响应头，可以用来做抓取成本监控。

---

# 36. 成本控制

主要成本来源：

```text
Browser Run
Workers AI
D1 writes
R2 storage / operations
Worker CPU / requests
```

最重要的成本控制原则：

### 1. 不重复抓取

通过 `source_hash` / `content_hash` 判断变化。

### 2. AI 不重复调用

只有以下情况才重新 AI：

```text
新 Article
parser_version changed
content_hash changed
prompt_version changed
```

### 3. 图片不重复下载

使用 hash / source URL 去重。

### 4. 热度更新分层

新文章：

```text
15 min
```

老文章：

```text
1h
```

更老文章：

```text
每天
```

### 5. 前台大量使用 CDN Cache

---

# 37. 内容合规与下架机制

项目涉及第三方内容存档，因此从第一版就应该加入内容治理能力。

数据库支持：

```text
display_mode

full
excerpt
link_only
takedown
```

以及：

```text
takedown_requested_at
takedown_reason
```

后台具备：

```text
Takedown
Archive
Restore
```

技术上不要把“网页抓到了”视为“可以永久公开展示全文”的自动结论。

需要根据内容来源、授权情况、适用法律和 X/作者相关条款制定实际展示政策。

---

# 38. MVP 实施阶段

## Phase 0：基础设施

目标：项目可以部署。

完成：

```text
Astro
Hono
Workers
D1
R2
Queues
Browser binding
Cloudflare Access
```

验收：

```text
npm run deploy
```

成功上线。

## Phase 1：人工导入

实现：

```text
Admin Import
 ↓
D1
 ↓
Queue
```

验收：

- 粘贴 URL
- 自动去重
- 创建 Job
- 返回 Article ID

## Phase 2：抓取归档

实现：

```text
Queue
 ↓
Browser Run
 ↓
R2
```

验收：

- 可以抓取目标 Article
- 保存 raw HTML
- 保存 Markdown
- 失败可 retry

## Phase 3：Parser

实现：

```text
raw
 ↓
ArticleDocument
 ↓
D1
```

验收：

- title
- author
- date
- paragraphs
- images
- links

## Phase 4：AI

实现：

```text
summary
category
topics
tags
quality
```

验收：

- AI JSON 可校验
- 失败可 retry
- 管理员可以 override

## Phase 5：Public Site

实现：

```text
/
/article/:slug
/category/:slug
/search
/trending
/latest
```

## Phase 6：Ranking

实现：

```text
Popularity
Velocity
Quality
Editor's Score
```

## Phase 7：Semantic

以后再加入：

```text
Vectorize
Related
Semantic Search
Recommendations
```

---

# 39. MVP 验收标准

### Import

- [ ] 支持批量 URL
- [ ] URL 标准化
- [ ] 重复 URL 不创建新 Article
- [ ] Import 不同步等待 Crawl

### Crawl

- [ ] Browser Run 成功抓取
- [ ] 保存 HTML
- [ ] 保存 Markdown
- [ ] 保存 screenshot（可选）
- [ ] 支持 retry

### Parser

- [ ] 文章标题正确
- [ ] 作者正确
- [ ] 正文结构正确
- [ ] 图片顺序正确
- [ ] 链接可保留
- [ ] Parser version 可追踪

### AI

- [ ] 摘要生成
- [ ] 分类生成
- [ ] Tag 生成
- [ ] JSON schema validation
- [ ] AI 失败不导致 Article 丢失
- [ ] 管理员可以修改 AI 结果

### Admin

- [ ] Review
- [ ] Publish
- [ ] Reject
- [ ] Archive
- [ ] Retry
- [ ] Featured
- [ ] Takedown

### Public

- [ ] 首页
- [ ] 分类页
- [ ] Article 页
- [ ] 搜索
- [ ] Trending
- [ ] Latest
- [ ] SEO
- [ ] Sitemap

---

# 40. 推荐的最终 MVP 架构

```text
                         ┌──────────────┐
                         │   YOU        │
                         │ Discover X   │
                         └──────┬───────┘
                                │ URL
                                ▼
                         ┌──────────────┐
                         │ Admin / Hono │
                         └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │      D1      │
                         └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │    Queue     │
                         └──────┬───────┘
                                │
                                ▼
                      ┌────────────────────┐
                      │    Browser Run     │
                      │ /markdown + HTML   │
                      └─────────┬──────────┘
                                │
                         ┌──────┴──────┐
                         ▼             ▼
                        R2          Parser
                         │             │
                         │             ▼
                         │        ArticleDocument
                         │             │
                         │             ▼
                         │       ┌───────────┐
                         │       │ Workers AI│
                         │       └─────┬─────┘
                         │             │
                         └─────────────┼─────────┐
                                       ▼         ▼
                                      D1      Ranking
                                       │         │
                                       └────┬────┘
                                            ▼
                                   Astro + Workers
                                            │
                                            ▼
                                         Readers
```

---

# 41. 产品演进方向

第一版形成：

> **人工精选 + 自动归档**

第二版形成：

> **人工精选 + AI 理解 + 热度排序**

第三版形成：

> **内容发现 + 语义关系 + 个性化推荐**

最终可以演变为：

```text
X Article
   ↓
Archive
   ↓
Knowledge Graph
   ↓
Topic / Author / Concept
   ↓
Search / Recommendation
   ↓
Personalized Reading
```

这时产品就不再只是一个“X Article 收藏网站”，而会逐渐变成一个围绕 X 长文建立的内容发现与知识索引系统。

---

# 42. 第一版开发优先级

严格按下面顺序开发：

```text
P0
D1 Schema
R2
Admin Import
Queue
Browser Run
Raw Archive

P1
Parser
Article Page
Publish Workflow
Categories

P2
Workers AI
Summary
Tags
Category Suggestion

P3
Metrics
Popularity
Velocity
Trending

P4
FTS5
Search
Author Page
Tag Page

P5
Vectorize
Related Articles
Semantic Search
```

第一版不要为了“架构完整”提前引入所有 Cloudflare 服务。

**真正应该先验证的只有三个核心假设：**

1. Browser Run 能否稳定抓取你实际选中的 X Article；
2. Parser 能否把抓取结果稳定转换成可阅读的 ArticleDocument；
3. 人工精选 + AI 分类 + 热度排序是否能形成一个比直接刷 X 更有效的阅读体验。

其中第一个是最大的技术风险，应在正式开发前先拿真实 Article URL 做一批抓取测试，并建立 fixture 数据集。

---

# 43. 用户账号（Google 登录）

## 43.1 范围

第一版**只建账号体系，不接任何用户功能**。没有收藏、没有评论、没有付费墙。

原因不是省事，而是反向思考的结果：如果一上来就带功能，"登录是为了什么"这个问题永远不会被认真回答，而数据模型是围着这个答案长的。账号先落地，后面每个功能接进来时只需要加表，不需要改鉴权模型。

**只有 Google 一家。** 不做密码、不做邮箱验证码。不需要多一个 provider —— 这个站点没有多一个的理由，而每多一家就多一份凭据、一条回调路径、一组失败模式要维护。

`provider` 列保留（见 43.2）：`(provider, provider_user_id)` 才是"哪个平台的哪个账号"的正确复合键，将来要加第二个 provider 时不必重新设计它。缩小的只是**允许的取值集合**，由迁移 0009 完成。

## 43.2 数据模型

四张表，按生命周期分开：

| 表 | 生命周期 | 说明 |
|---|---|---|
| `users` | 一个人 | 与任何一次登录无关 |
| `user_identities` | 一个凭证 | 一个人可以有多个 |
| `user_sessions` | 一次登录 | 30 天，可撤销 |
| `oauth_states` | 一次跳转 | 10 分钟，单次消费 |

**身份键是 `(provider, provider_user_id)`，即 Google 的 `sub`，绝不是 email。**

理由在换成单 provider 时**换过一次**，所以要说明现在的理由，而不是继承旧的那条。旧理由是"X 发出的地址从不验证"；X 去掉后系统里根本不存在未验证地址，沿用旧理由会是错的。

现在成立的理由是：**Google 允许账号持有人修改自己账号的地址。** `sub` 是账号创建时由 Google 分配的，不会变；地址是归属账户的可编辑属性。用地址做键，意味着**下一个拿到该地址的人会继承这个身份** —— 和之前是同一个失败，只是换了一条路走，代价也一样。

### 43.2.1 为什么删掉了 `link_to_user_id`

迁移 0008 里 `oauth_states` 有一列 `link_to_user_id`：登录状态下连接第二个 provider。这在两家时是受支持的账号合并方式，安全性来自"账户归属的证据来自会话 cookie，不是查询参数"。

**只剩一家之后，它不再是合并，而是一个等着发生的意外。** 已登录为 A，然后用**另一个未知的** Google 账号登录，那个身份会被挂到 A 上 —— B 和 A 变成同一个人，而 B 既没有同意过、也看不到这件事发生过。A 的行只是多了一个身份，两个会话从此解析到同一个用户，任何地方都不会看起来不对。

所以登录**始终按身份本身的依据解析**，那一列和读它的分支一起删掉了。

`provider` 从 `IN ('x','google')` 收紧为 `IN ('google')`。SQLite 不能 ALTER 一个 CHECK，而 0008 已经应用到生产，改它会让本地库和线上库与仓库不一致 —— 所以是 0009 里重建两张表。两张表都是空的，所以重建只是 create、INSERT ... SELECT 零行、drop、rename。

## 43.3 为什么会话存在 D1 而不是 KV

KV 是最终一致的，读最多滞后 60 秒。这个延迟会让登录坏在一个没人注意的方向上：callback 写入会话，下一个请求读到还没追上的副本，于是**登录成功后一分钟内读者仍然是登出状态**；更糟的是登出后会短暂显示仍然登出。

一个读不到自己写入的存储，不能承载鉴权决策。`oauth_states` 同理。

cookie 里是 256 位随机数，D1 里只存它的 SHA-256 —— 拿到表也拿不到可用的凭据。

## 43.4 为什么 `state` 存在服务端而不是 cookie

常见做法是 `state` 参数配一个同值的签名 cookie，回调时比对。这需要**签名**，于是 `state` 对任何持有签名密钥的人都是可读可伪造的，CSRF 防护完全依赖那个密钥不被猜到。

存服务端则意味着能推进流程的只有本 Worker 写下的行，而且这一行只能被消费一次（`takeOAuthState` 用 `DELETE ... RETURNING` 单语句完成——D1 不支持跨语句事务，先 SELECT 再 DELETE 会有两个并发回调都读到同一个 `state` 的窗口）。

PKCE verifier 同样只存服务端。这本来就是 PKCE 的意义所在：verifier 永远不在别处。

Google 的 access token **从不落库**。它只在一个 callback 的生命周期内存活，用来读一次 profile 就丢掉。§43 之后没有任何代码会调 Google API，存下来只是一个没有用途、还带撤销问题的凭据。也不申请 `offline.access`，因为那只会换来一个 refresh token。

## 43.5 缓存策略：页头不按人渲染

`src/middleware.ts` 给首页 `s-maxage=60`、文章页 `s-maxage=3600`。**页头是全站唯一一处不同读者会看到不同 HTML 的地方，而它刻意不做按人渲染**：任何按人的标记都会被烤进缓存文档发给所有人——一个人的名字出现在另一个人的页头里。

`Vary: Cookie` 能解决，但那会让几乎所有缓存命中率归零（每个会话一份缓存条目）。

所以：

- 页面 HTML 对所有人完全一致，页头只是一个指向 `/account` 的普通链接；
- 一段 `is:inline` 脚本取 `/auth/me`，把槽位升级成读者的名字；
- `/auth/me` 和 `/account`、`/auth/*` 都是 `no-store`；
- 无 JS 时槽位永远显示 "Sign in"——那是一个仍然可点的链接，不是坏掉的控件；而 `/account` 是服务端渲染的，登录登出都不依赖那段脚本。

**显示名用 `textContent` 写入，绝不用 `innerHTML`** —— 它是 X 或 Google 账号持有人自己选的字符串，这个站点没有理由信任它（X 去掉后是 Google，理由不变）。

槽位宽度必须有上界（`flex: none` + `max-width` + 省略号），并且**在导航标签收窄的同一个断点（700px）收窄** —— 那个宽度上行里没有余量让两样东西各自独立收缩，而导航是不能丢内容的那一方。实测：640px、五个板块、36 字符昵称下 150px 的槽位会让导航差 22px，裁掉最后一项且没有任何提示；110px 刚好回到界内。

## 43.6 导航高亮之外的一个易错点

会话 cookie 是 `SameSite=Lax`，而且这是**承重**的。登录的最后一跳是来自 Google 的顶层 GET 跳转，只有 `Lax` 会在这条导航上带上 cookie。`Strict`——听起来更严格、也是 `setAdminCookie` 用的值——会扣住它，于是每次登录都落在 `/account` 且仍是登出状态，而**任何地方都没有报错可以解释原因**。

admin 那个 cookie 用 `Strict` 是对的：它从不是跨站跳转的目标。

## 43.7 admin 鉴权

共享 token 保留，并且**先**检查；真实账号是附加的第二条路。

顺序是有意的：token 是不会被 provider 侧任何状况夺走的路径——Google consent screen 被关、应用被删——所以它在替代方案不工作时仍然是入口，也在 43.x 这段代码万一写错时仍然是出口。

角色从 `users` 行读，不从 cookie 读。cookie 里带角色等于把管理员权限交给任何愿意改自己浏览器一个值的人。

## 43.8 待办

- 账号目前什么都不做。接第一个功能时，优先考虑收藏（范围最小、最自洽）。
- `deleteSessionsForUser`（全端登出）没有 UI，是被盗 cookie 的运维手段。
- `last_seen_at` 只在 `/account` 刷新。上到每个请求会给每个页面浏览加一次写。
- 需要周期清理 `oauth_states` / `user_sessions` 过期行（`deleteStaleAuthRows` 已就位，尚未挂到 cron）。
- 如果要加第二个 provider：恢复 `oauth_states.link_to_user_id` 是**安全决策**，不是功能开关。单 provider 下那条路径会把两个账号合并，见 43.2.1。届时先想清楚"合并"是否要用户明确同意。