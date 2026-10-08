# 登录配置指南（SPEC §43）

X 和 Google 的 OAuth 应用你还没有，所以代码已经上线但两家都处于"未配置"状态 —— `/account` 会明确显示这一点，而不是报错。这是设计好的：密钥只缺一半是部署过程中的正常状态。

按顺序做完下面三节，然后按 [§4 验证](#4-验证) 自查。

---

## 1. Google

个人站点不需要走 Google 的审核流程 —— 只要你自己在测试用户列表里，Testing 模式就够用。

1. 打开 <https://console.cloud.google.com/>，新建或选一个项目。
2. 左侧 **APIs & Services → OAuth consent screen**：
   - User type 选 **External**
   - 填 App name、User support email、Developer contact email
   - 不需要填 Scope（下一步会自动生成）
3. 在 **Test users** 里把你自己的邮箱加进去。**这一步不能跳过** —— 不加的话连你自己都会看到 "App is blocked" 那个 403 页面。
4. 左侧 **Credentials → Create Credentials → OAuth client ID**：
   - Application type: **Web application**
   - Name: 随便，例如 `x-article-hub`
   - **Authorized redirect URIs**:
     ```
     https://x-article-hub.zachzhao.workers.dev/auth/google/callback
     ```
   - **Authorized JavaScript origins**:
     ```
     https://x-article-hub.zachzhao.workers.dev
     ```
5. 点 Create，会给你 **Client ID** 和 **Client secret**。

> 回调地址必须**逐字节一致**。多一个斜杠、少一个斜杠、或者用了 `http://`，Google 都会在换 token 时以一条看不出原因的信息拒绝它。

---

## 2. X

**先看这一条**：X 的 `/2/users/me`（读你自己的账号信息，用来证明"你是谁"）在 X 当前的 API 分层里**需要付费档**。这是 X 侧的商业政策，代码改不了，也没法绕过。注册时请在他们的定价页确认当前档位要求。如果不想付费，**只做 Google 也能跑** —— `/account` 会只显示 Google 一个入口，这是完全可用的状态，不是半成品。

如果要走 X：

1. 打开 <https://developer.x.com/> → 进入 Developer Portal → 建一个 **Project**。
2. 在 Project 里 **Add App**，类型选带 OAuth 2.0 的那一种（Web App）。
3. 填：
   - **Website URL**: `https://x-article-hub.zachzhao.workers.dev`
   - **Callback URI**:
     ```
     https://x-article-hub.zachzhao.workers.dev/auth/x/callback
     ```
4. **App permissions**：只勾 **Read**，然后展开 Users，把 `Read users` 打开。

   `/2/users/me` 需要 `users.read` 和 `tweet.read` 两个 scope，代码里两个都申请了。

   **不要申请 Write 权限。** 登录一个阅读站不需要发帖权限，申请了只是徒增审核和风险。
5. 左侧 **Keys and tokens → OAuth 2.0**，生成并复制 **Client ID** 和 **Client Secret**。

> X 的 token 端点即使在用 PKCE 也要求 HTTP Basic 客户端认证（`Authorization: Basic base64(id:secret)`），代码已经按这个实现了。X 和 Google 在这一点上是唯一的技术差异。

---

## 3. 部署密钥

四个都是 **secret**，不是 `vars`，不要写进 `wrangler.jsonc`：

```bash
npx wrangler secret put X_CLIENT_ID
npx wrangler secret put X_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

还有一个可选的：

```bash
npx wrangler secret put USER_SESSION_SECRET
```

这是给 `user_sessions.ip_hash` 加的pepper。没有它，存下来的地址哈希可以被暴力枚举还原（IPv4 只有 2^32 种），那就不算隐私保护了。设成任意随机串即可：

```bash
openssl rand -hex 32
```

改完 secret 需要重新部署才会生效（`npm run deploy`）。

### Cloudflare Access 不能挡在 `/auth` 前面

如果给这个域名配了 Access，**必须把 `/auth/*` 排除在策略外**。

provider 是从读者的浏览器跳回 `/auth/<provider>/callback` 的。Access 会抢在那次导航前面先出自己的登录页，Worker 根本看不到 code，provider 只会报一个和真实原因毫无关系的错。

现在 admin 走的是 Access 头 + token 双保险，所以 `/admin` 挡着没问题；`/auth/*` 是给读者用的，必须公开可达。

---

## 4. 验证

```bash
# 1. 未登录时 /auth/me 应该返回 null user
curl -s https://x-article-hub.zachzhao.workers.dev/auth/me
#   → {"user":null}

# 2. 配好之后，start 应该 302 到 provider
curl -sI https://x-article-hub.zachzhao.workers.dev/auth/google/start | grep -i location
#   → Location: https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=...

# 3. 页面本身
#   https://x-article-hub.zachzhao.workers.dev/account
```

第 2 步如果还是跳到 `/account?error=not-configured`，说明 secret 没生效 —— 重新 `npm run deploy`。

---

## 5. 给自己管理员权限

管理员**不**来自 provider。`role` 是 `users` 表上的一列，只能由你在 D1 上执行：

```bash
npx wrangler d1 execute x-article-hub --remote --command \
  "UPDATE users SET role = 'admin', updated_at = unixepoch() * 1000 WHERE email = 'you@example.com'"
```

要在**先成功登录过一次之后**执行 —— 行还不存在。这条命令就是 `src/db/users.ts` 里导出的 `GRANT_ADMIN_SQL`，`tests/unit/user-auth.test.ts` 断言了它的内容，所以不用背。

改完立刻生效，不需要重新登录：角色是从 `users` 行读的，不是从 cookie 读的。

之后 `/admin` 会同时接受两条路 —— 共享 token（保留作为兜底）和你的真实账号。

**X 账号可能没有 email。** 那条 `UPDATE ... WHERE email` 就匹配不到任何行。X 不验证地址，所以代码从不把 email 当身份，也就不保证它存在。这种情况下按 user id 授予：

```bash
npx wrangler d1 execute x-article-hub --remote --command \
  "UPDATE users SET role = 'admin', updated_at = unixepoch() * 1000 WHERE id = 'usr_xxx'"
```

---

## 6. 出问题时看哪里

| 现象 | 原因 |
|---|---|
| `/account` 显示 "Sign in is not available" | 四个 secret 都没设，或设了但没重新部署 |
| 只有 Google 能登录 | 只配了 Google。这是可用状态 |
| provider 报 redirect_uri 不匹配 | 注册的回调地址和 `SITE_ORIGIN` 拼出来的差一个字符 |
| Google 报 403 "App is blocked" | 你的邮箱不在 OAuth consent screen 的 Test users 里 |
| 登录完立刻又变登出 | 检查 Cloudflare Access 有没有挡 `/auth/*` |
| `?error=state` | 回调里的 state 不存在或已被用过。单次消费，同一个链接点两次就会这样 |
| X 报 403 权限不足 | API 档位不够，`/2/users/me` 需要付费档 |
| 401 进不了 admin | 账号已登录但 `role` 还是 `reader`。查日志里的 `admin_denied_role`，那行会写明是哪个账号 |

`?error=` 后面是给读者看的机器可读原因，`/account` 会把它翻成一句话。provider 自己的原始响应只在日志里，不进 URL —— URL 会被存进浏览器历史，也会通过 referrer 泄漏给第三方。