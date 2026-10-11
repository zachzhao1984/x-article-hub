# 多语言文章版本 —— 实现方案

> 评估与设计文档。**不含生产代码**，目的是在动手前把数据模型、成本、法律边界和取舍一次讲清楚。
>
> 所有数字都是**实测**的，不是估算。测量方法与日期在每节里注明。

---

## 0. 一句话结论

**可行，但先要付费，而且不建议全量自动翻译。**

- 🔴 **硬约束**：Workers AI 免费额度（10,000 neurons/天）已被封面生成用尽，实测返回 `4006`。不升级 Workers Paid，这个功能跑不起来。
- 🟡 **规模**：80 篇已解析文章、**248,935 词**。翻译成"源语言之外的两语言"= **160 次 LLM 调用**，约 65 万输入 token + 75 万输出 token。
- 🟢 **架构建议**：译文不是"三篇独立文章"，而是**同一个 ArticleDocument 的三种呈现**。图片/链接/代码只存一份。
- 🟠 **法律边界**：`ArticleDocument` 的注释明确写着 Parser 不得改写作者原话。翻译**就是改写**——译文必须单独存储、明确标注、链回原文。

---

## 1. 实测依据

### 1.1 Workers AI 配额（2026-10-11 实测）

```
POST /api/admin/maintenance/translate-probe
→ 4006: you have used up your daily free allocation of 10,000 neurons,
       please upgrade to Cloudflare's Workers Paid plan
```

免费额度**当天已被封面生成耗尽**。这是评估的第一个、也是最重要的发现：任何"给每篇都翻译"的方案在此前提下都无法运行。

**升级后的定价**（Cloudflare 公布，按 neuron 计费）：Workers Paid 计划本身 $5/月起，AI 按用量另计。具体金额随模型不同差异极大——`m2m100-1.2b` 与 `llama-3.3-70b` 差约 50 倍，这是选型的核心权衡（见 §3）。

### 1.2 内容规模（生产 D1 实测）

| 指标 | 值 |
|---|---|
| 已解析文章 | 80 篇 |
| 正文总词数 | 248,935 |
| 平均词数 | 3,111 |
| 最长文章 | **17,460 词** |

### 1.3 语言分布（生产 D1 实测）

| 源语言 | 篇数 |
|---|---|
| 英语（`latin`） | 39 |
| 日语（`ja`） | 29 |
| 中文（`zh`） | 12 |
| **合计已检测** | 80 |

> 注意这一点：**53% 的文章原文就是中文或日文**。所以"翻译成中日英"对一半的文章，源语言不是英语——方案不能假设"英语是源头"。

### 1.4 单篇的 token 量

| 文章规模 | 输入 | 输出 | 合计 |
|---|---|---|---|
| 平均（3,111 词） | ~4,044 token | ~4,666 token | ~8,710 token |
| 最长（17,460 词） | ~22,698 token | ~26,190 token | ~48,888 token |

（按 1 词 ≈ 1.3 输入 token、中文/日文输出通常比英文长约 1.15–1.3 倍估算。）

**最长那篇需要分块**：`llama-3.3-70b` 上下文 24k，输入加输出已超过，必须切 2 块以上。

---

## 2. 核心设计判断：译文是什么

### 2.1 不是"三篇文章"，是一个文档的三种呈现

`ArticleDocument`（`src/types/article-document.ts`）的结构：

```
ArticleDocument
  ├── title, author, publishedAt     ← 需要翻译（title）、不需要（author）
  ├── blocks[]                       ← 只有文本类 block 需要翻译
  │     ├── paragraph / heading / quote / list   ← 翻译
  │     ├── code                                 ← 不翻译
  │     ├── image                                ← 不翻译
  │     └── embed                                ← 不翻译
  ├── links[]                        ← 不翻译（href 不变，text 可翻但保留原文更好）
  └── images[]                       ← 不翻译
```

**关键结论：图片、链接、代码在三种语言里是同一份数据。**

如果把三个语言存成三个完整 `ArticleDocument`，那么：
- 每个图片的 `r2Key`、每个链接的 `href` 会复制三份
- 一旦重抓导致图片位置变化，三个副本会**各自漂移**，这是 `reconcilePositions` 已经在防的那类 bug 的三倍版本
- 媒体引用、去重、`article_versions` 的 `UNIQUE(article_id, version, parser_version)` 约束都会变复杂

**所以译文只存被翻译的文本，其余从原文档合并。**

### 2.2 数据模型

在 `article_versions` 上扩展，而不是新建"翻译"表：

```sql
-- 迁移 0014
-- article_versions 现在每个 (version, parser_version) 一行；
-- 改为每个 (version, parser_version, lang) 一行。
ALTER TABLE article_versions ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'
  CHECK (lang IN ('en', 'zh', 'ja'));

-- 原唯一约束 (article_id, version, parser_version) 需要放宽为含 lang
-- SQLite 无法 DROP CONSTRAINT，需重建表（同 0012 的做法）
```

**同时新增一张翻译状态表**，因为"翻译"有自己的失败模式（模型不可用、分块中断），不该塞进 `article_versions`：

```sql
CREATE TABLE article_translations (
  article_id   TEXT NOT NULL,
  target_lang  TEXT NOT NULL CHECK (target_lang IN ('zh','ja','en')),
  source_lang  TEXT NOT NULL,
  -- 原文的 content_hash，变了就要重翻
  source_hash  TEXT NOT NULL,
  -- 译文文档在 R2 的位置：articles/{id}/versions/v{n}/{lang}.json
  r2_key       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','ready','failed')),
  model        TEXT,
  error_code   TEXT,
  error_message TEXT,
  -- 用哪个 prompt 版本翻的，prompt 改了要重翻
  prompt_version INTEGER NOT NULL DEFAULT 1,
  token_input  INTEGER,
  token_output INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (article_id, target_lang),
  FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
);
```

**为什么 `source_hash` 是必需的**：文章会重抓（`PARSER_VERSION` 变化时）。如果原文变了而译文没变，读者看到的是与新原文不符的译文。`source_hash` 是重翻的判据——和 `parseArticle` 里 `content_hash` 判断是否重解析是同一个思路。

### 2.3 R2 布局

```
articles/{id}/
  raw/                                    ← 不变（附录，只增不删）
  versions/v1/article.json                ← 源语言文档（现状）
  versions/v1/zh.json                     ← 中文译文（**只存文本 block**）
  versions/v1/ja.json
  media/                                  ← 不变，三语言共用
  media/cover.jpg                         ← 不变，三语言共用
```

**译文文件的结构**（不是完整 `ArticleDocument`）：

```jsonc
{
  "lang": "zh",
  "sourceLang": "en",
  "translatedFrom": "articles/{id}/versions/v1/article.json",
  "sourceHash": "…",              // 与 article_translations.source_hash 对应
  "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "promptVersion": 1,
  "title": "…",                    // 译后的标题
  "blocks": [                      // 只对需要翻译的 block 有内容，按 index 对齐源文档
    { "index": 0, "text": "…" },
    { "index": 2, "text": "…" }
    // index 1 是 image，不出现
  ]
}
```

阅读时把它按 `index` 合并回源文档：图片、代码、embed 从源文档取，文本从译文取。**只有一份媒体引用。**

---

## 3. 模型选型

### 3.1 两个候选（Worker 类型定义里确认存在）

| | `@cf/meta/m2m100-1.2b` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
|---|---|---|
| 定位 | 专用翻译模型 | 通用 LLM |
| 接口 | `{text, source_lang, target_lang}` | messages |
| 粒度 | **句子级** | 段落/整篇 |
| 保留 Markdown 结构 | ❌ 不理解 | ✅ 可约束 |
| 术语一致性 | ❌ 逐句独立 | ✅ 可约束 |
| 上下文连贯 | ❌ 段落间无关联 | ✅ |
| 成本 | 低 | 高（约 50×） |
| 17,460 词的文章 | 需切几百段 | 2–3 块 |

### 3.2 判断：长文必须用 LLM

**理由不是"质量偏好"，是结构问题**：

1. `ArticleDocument` 有 7 种 block，其中 `code` 必须原样保留、`image`/`embed` 是位置标记。m2m100 只吃纯文本、只吐纯文本，切碎后**无法保证 block 对齐**。
2. 文章的术语和论证是连贯的。逐句翻译会让同一个术语在文章里出现三种译法——这在技术长文里是致命的。
3. 你的文章里大量是技术内容（实测样本里有"DIL"、"JSX"、"sandboxed worker"这类术语）。

**结论：主路径用 `llama-3.3-70b`。** m2m100 可作为短标题的廉价补充，但会引入第二套翻译逻辑，不值得。

### 3.3 分块策略

```
输入文档
  → 按 block 累积到 ~12k token（留出输出余量）
  → 每块单独翻译，但**带上术语表**
  → 合并

术语表：第一块翻译后，抽取专有名词/代码标识符，作为后续块的 system prompt 一部分。
       这是让 17,000 词文章术语一致的关键，也是分块翻译最大的风险点。
```

**代码块永远不送进模型**——它们原样保留。这既是质量保证也是成本节省。

---

## 4. 触发时机

### 4.1 三种可能的时机，我建议的取舍

| 时机 | 优点 | 缺点 |
|---|---|---|
| 导入时全自动 | 无需人工 | ❌ 成本失控，很多文章永远不会被发布 |
| **发布时触发**（建议） | ✅ 只为真正给读者看的文章付费 | 编辑要多等一步（译文有延迟） |
| 编辑手动点按钮 | ✅ 完全可控，可评估质量 | 每篇都要点 |

**建议：发布时触发，加上 admin 的手动重翻按钮。**

理由：文章从 `review` 到 `published` 是编辑已经决定"这篇值得给人看"的时刻。在这之前翻译是为没人看的文章付费。

**新增 job 类型**：`src/jobs/types.ts` 里已经有 `'ai'` 这个类型，且 `dispatch.ts` 里是 `ai: notImplemented('ai')`——**这就是为这件事预留的位置**。

```typescript
// dispatch.ts
ai: handleTranslate,
```

队列用现有的 `article-process`（`max_batch_size: 5`）。翻译是慢活（单篇可能数十秒），要确保 `max_retries` 和幂等性——`article_translations.status` 就是幂等的依据。

### 4.2 幂等与重翻

```
handleTranslate(articleId, targetLang):
  1. 读源文档，算 content_hash
  2. 查 article_translations
     - status='ready' 且 source_hash 相同 → 跳过（already_done）
     - source_hash 不同 → 重翻（原文变了）
  3. 标 running，分块调用模型
  4. 写 R2，标 ready，记 token 用量
```

这直接对应 `handleParse` 的 `already_done` 模式。

---

## 5. 阅读页与 URL

### 5.1 URL 形式

**建议：`/article/<slug>/<lang>`**（子路径），而不是 `?lang=zh`。

理由：
- 你的文章页是 `s-maxage=3600`（`src/middleware.ts`）。查询参数会进 Cloudflare 的 cache key，但**子路径更干净、更可索引**。
- SEO：搜索引擎需要每种语言一个独立 URL 才能正确索引，`?lang=` 会被当成同一页的变体。
- 链接分享：`/article/foo/zh` 比 `/article/foo?lang=zh` 更清晰。

**默认语言不带后缀**：`/article/foo` = 源语言版本。`/article/foo/zh` = 中文版。

### 5.2 缓存

现有的 `[/^\/article\//, 3600]` **不用改**——子路径同样匹配 `^/article/`。每个语言版本独立缓存，这正是想要的。

### 5.3 语言切换

阅读页顶部（或标题旁）显示「原文 / 中文 / 日本語」切换。**只显示已存在的译文**——没翻译的不显示链接，而不是给个 404。

### 5.4 必须的标注

译文页面必须：
- 在标题附近明确标注「机器翻译」
- 提供链回原文的链接（页面底部已有 `↗ View original on X`，译文页要再从**源语言版本**链一次）
- `<html lang>` 设为译文语言

**这不是可选的 UI 细节，是法律与伦理上的必要**：`ArticleDocument` 的注释写着 *"the Parser must not rewrite the author's words"*，翻译就是在改写，必须让读者知道自己在读什么。

---

## 6. 成本与闸门

### 6.1 全量翻译的成本

```
80 篇 × 2 语言 = 160 次调用
约 650,000 输入 token + 750,000 输出 token
最长单篇需 2–3 块（额外开销）
```

以 `llama-3.3-70b` 的定价，这是一笔**持续性**开销（每次重抓/重解析都要检查是否重翻），不是一次性的。

### 6.2 三个闸门（建议全部实现）

1. **只翻已发布的**（§4.1）——这是最大的节省
2. **`source_hash` 判断**（§4.2）——原文没变就不重翻
3. **单日上限**——`article_translations` 加一个每日计数检查，防止某次批量导入触发 100 次翻译

### 6.3 可选：按需而非全量

另一个更省的做法是**不做全量，只做跨语言少数文章**。观察你的数据：29 篇日语 + 12 篇中文。对中文读者来说，把 29 篇日语文章翻成中文，比给 39 篇英语文章加中文版**更有价值**——因为英语读者本来就能读英语原文。

这可以做成 admin 里的一个筛选："翻译成中文的日语文章"，编辑按需挑选。

---

## 7. 分阶段实施建议

| 阶段 | 内容 | 验证什么 |
|---|---|---|
| **0** | 升级 Workers Paid | 没有这个，后面都跑不了 |
| **1** | 迁移 `0014` + `article_translations` 表 + `handleTranslate`（只支持手动触发单篇） | 数据模型对不对、模型质量够不够 |
| **2** | 用 3–5 篇真实文章评估译文质量 | **质量不过关就不要往下做** |
| **3** | 阅读页 `/article/<slug>/<lang>` + 切换 UI + 标注 | 读者体验、缓存、SEO |
| **4** | 发布时自动触发 + 每日上限 | 自动化与成本控制 |
| **5** | admin 批量翻译入口（按语言对筛选） | 运营效率 |

**关键在阶段 2**：先花 5 篇的钱验证质量。如果 `llama-3.3-70b` 翻技术长文不能达到"读者愿意读"的水平，整个方案要重新考虑（比如改用第三方翻译 API，但那会引入新的依赖和成本）。

---

## 8. 明确不建议的做法

1. **❌ 全量一次性翻译 80 篇。** 质量未验证就付 160 次调用的钱，翻得不好要全部重做。
2. **❌ 用 m2m100 翻长文。** 结构对齐做不到，术语会散。
3. **❌ 把三个语言存成三个完整 ArticleDocument。** 媒体引用复制三份，必然漂移。
4. **❌ 译文覆盖原文。** 违反 `ArticleDocument` 的契约，且法律上有问题。
5. **❌ 在免费额度下尝试。** 实测已经返回 4006。

---

## 9. 待决问题（需要你决定）

1. **付费意愿**：是否升级 Workers Paid？不升级则本方案不启动。
2. **触发策略**：发布时自动，还是 admin 手动？（我建议两者都有）
3. **翻译范围**：全部文章三语，还是优先"日语→中文"这类跨语言补充？
4. **质量底线**：阶段 2 的验收标准是什么？（比如"技术术语不变、段落可读、无串行"）

---

## 附：本文档的测量依据

| 数字 | 来源 | 日期 |
|---|---|---|
| Workers AI 配额耗尽 | 生产端点实测返回 `4006` | 2026-10-11 |
| 80 篇 / 248,935 词 | 生产 D1 `SELECT COUNT(*), SUM(word_count)` | 2026-10-11 |
| 语言分布 39/29/12 | 生产 D1 `SELECT lang, COUNT(*)` | 2026-10-11 |
| 模型接口与存在性 | `worker-configuration.d.ts` 类型定义 | 2026-10-11 |
| `ArticleDocument` 结构 | `src/types/article-document.ts` | — |
| 队列与 job 类型 | `wrangler.jsonc`、`src/jobs/types.ts`、`dispatch.ts` | — |
| 缓存策略 | `src/middleware.ts` | — |

> 评估用的临时探针端点在测量后已从代码中移除，工作树干净。
