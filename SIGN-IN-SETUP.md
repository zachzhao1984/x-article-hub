# 登录配置指南（SPEC §43）

只有 Google 一家。不做密码，不做邮箱验证码 —— 这个站点没有需要记住的凭据，也就没有需要泄露的凭据。

代码已经上线，但还没配置：`/account` 会明确说"登录不可用"以及缺哪个 secret，而不是报错。这是设计好的 —— 密钥还没设是部署过程中的正常状态。

---

## 1. 注册 Google 应用

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

### 申请的权限

只有三个：`openid email profile`，对应代码里 `src/lib/oauth.ts` 的 `scope`。全是基础资料权限，所以不需要走 Google 的审核队列。

`openid` 是关键 —— 它让 Google 返回 `sub`，那个是账号创建时分配、不会变的标识。站点认的是 `sub`，不是邮箱地址：Google 允许账号持有人改邮箱地址，而地址属于你可以改的东西，谁拿到它就归谁。所以换邮箱不会丢历史，也不会让别���拿到你的账号。

代码不申请 `offline.access`，因此不会拿到 refresh token —— 站点登录后不会再调 Google API，存着也没有用。

---

## 2. 部署密钥

两个都是 **secret**，不要写进 `wrangler.jsonc`：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

还有一个可选的：

```bash
npx wrangler secret put USER_SESSION_SECRET
```

这是给 `user_sessions.ip_hash` 加的 pepper。没有它，存下来的地址哈希可以被暴力枚举还原（IPv4 只有 2^32 种），那就不算隐私保护了。设成任意随机串：

```bash
openssl rand -hex 32
```

改完 secret 需要重新部署才生效（`npm run deploy`）。

### Cloudflare Access 不能挡在 `/auth` 前面

如果给这个域名配了 Access，**必须把 `/auth/*` 排除在策略外**。

Google 是从读者的浏览器跳回 `/auth/google/callback` 的。Access 会抢在那次导航前面先出自己的登录页，Worker 根本看不到 code，Google 只会报一个和真实原因毫无关系的错。

现在 admin 走的是 Access 头 + token 双保险，所以 `/admin` 挡着没问题；`/auth/*` 是给读者用的，必须公开可达。

---

## 3. 验证

```bash
# 1. 未登录时 /auth/me 应该返回 null user
curl -s https://x-article-hub.zachzhao.workers.dev/auth/me
#   → {"user":null}

# 2. 配好之后，start 应该 302 到 Google
curl -sI https://x-article-hub.zachzhao.workers.dev/auth/google/start | grep -i location
#   → Location: https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=...

# 3. 页面本身
#   https://x-article-hub.zachzhao.workers.dev/account
```

第 2 步如果还是跳到 `/account?error=not-configured`，说明 secret 没生效 —— 重新 `npm run deploy`。

---

## 4. 给自己管理员权限

管理员**不**来自 Google。`role` 是 `users` 表上的一列，只能由你在 D1 上执行：

```bash
npx wrangler d1 execute x-article-hub --remote --command \
  "UPDATE users SET role = 'admin', updated_at = unixepoch() * 1000 WHERE email = 'you@gmail.com'"
```

要在**先成功登录过一次之后**执行 —— 行还不存在。这条命令就是 `src/db/users.ts` 里导出的 `GRANT_ADMIN_SQL`，`tests/unit/user-auth.test.ts` 断言了它的内容，所以不用背。

改完立刻生效，不需要重新登录：角色是从 `users` 行读的，不是从 cookie 读的。

之后 `/admin` 会同时接受两条路 —— 共享 token（保留作为兜底）和你的真实账号。**token 先检查**，这样 Google 那边出问题也不会把你自己锁在门外。

如果 Google 账号没给邮箱（`email_verified` 为 false 时站点不存地址），按 user id 授予：

```bash
npx wrangler d1 execute x-article-hub --remote --command \
  "UPDATE users SET role = 'admin', updated_at = unixepoch() * 1000 WHERE id = 'usr_xxx'"
```

---

## 5. 出问题时看哪里

| 现象 | 原因 |
|---|---|
| `/account` 显示 "Sign in is not available" | 两个 secret 都没设，或设了但没重新部署 |
| Google 报 403 "App is blocked" | 你的邮箱不在 OAuth consent screen 的 Test users 里 |
| provider 报 redirect_uri 不匹配 | 注册的回调地址和 `SITE_ORIGIN` 拼出来的差一个字符 |
| 登录完立刻又变登出 | 检查 Cloudflare Access 有没有挡 `/auth/*` |
| `?error=state` | 回调里的 state 不存在或已被用过。单次消费，同一个链接点两次就会这样 |
| 401 进不了 admin | 账号已登录但 `role` 还是 `reader`。查日志里的 `admin_denied_role`，那行会写明是哪个账号 |

`?error=` 后面是给读者看的机器可读原因，`/account` 会把它翻成一句话。Google 自己的原始响应只在日志里，不进 URL —— URL 会被存进浏览器历史，也会通过 referrer 泄漏给第三方。