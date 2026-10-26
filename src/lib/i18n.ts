/**
 * SPEC §17.4 — the public site's user-facing strings, in three languages.
 *
 * ## The shape of this, and why it is not a runtime lookup
 *
 * A cached page cannot vary by reader: SPEC §23 gives the homepage `s-maxage=60` and article
 * pages `s-maxage=3600`, so whatever the server renders is handed to everybody until it
 * expires. Choosing the language server-side from a cookie would therefore either serve one
 * reader's language to all of them, or require `Vary: Cookie` — which makes every session its
 * own cache entry and gives up most of the hit rate. That trade is spelled out in
 * `SiteHeader.astro` for the account slot and it resolves the same way here.
 *
 * So the server always renders **English**, and every translatable element also carries the
 * other two languages in `data-*` attributes. A synchronous inline script reads the cookie
 * and swaps the text before first paint, which is exactly how the theme works
 * (`lib/theme.ts`), for exactly the same reason.
 *
 * That makes this module's job narrow: provide the strings, in three languages, plus the
 * function that renders the `data-*` attributes for a given key.
 *
 * ## Why the keys are flat and hand-written
 *
 * A dictionary keyed by a URL path or by an English string would be a second thing to keep in
 * step with the markup. `t(key)` returning a triple means a missing translation is a compile
 * error (the key is typed), not a page that silently falls back for one language.
 */

export const SITE_LANGS = ['en', 'zh', 'ja'] as const;
export type SiteLang = (typeof SITE_LANGS)[number];

/** The language every page is server-rendered in. */
export const DEFAULT_LANG: SiteLang = 'en';

/** The cookie the switcher writes. Same prefix convention as `xah_theme`. */
export const LANG_COOKIE = 'xah_lang';

/**
 * Every translatable string, keyed.
 *
 * `en` is the source; `zh` and `ja` are the translations. All three are required by the type,
 * so adding a key without translating it does not compile.
 */
export interface Translations {
  // --- header / navigation
  'nav.home': string;
  'nav.featured': string;
  'nav.latest': string;
  'nav.trending': string;
  'nav.authors': string;
  'nav.primary': string;
  'nav.categories': string;
  'nav.allTopics': string;
  'header.search.placeholder': string;
  'header.search.label': string;
  'header.signIn': string;
  'header.accountMenu': string;
  'header.accountMenuNamed': string;
  'header.menu.saved': string;
  'header.menu.account': string;
  'header.menu.admin': string;
  'header.langSwitcher': string;

  // --- footer
  'footer.tagline': string;
  'footer.about': string;
  'footer.rss': string;
  'footer.sitemap': string;
  'footer.admin': string;

  // --- theme switcher
  'theme.legend': string;
  'theme.light': string;
  'theme.dark': string;
  'theme.system': string;

  // --- card
  'card.editorsPick': string;
  'card.minRead': string;
  'card.views': string;
  'card.likes': string;
  'card.reposts': string;
  'card.replies': string;
  'card.bookmarks': string;
  'card.engagement': string;

  // --- board / pager
  'board.empty': string;
  'board.emptyBody': string;
  'board.admin': string;
  'board.orCheck': string;
  'board.latest': string;
  'board.newer': string;
  'board.older': string;
  'board.page': string;

  // --- home
  'home.eyebrow': string;
  'home.heroTitle': string;
  'home.heroBody': string;
  'home.heroCta': string;
  'home.noArticles': string;
  'home.noArticlesBody': string;
  'home.importer': string;
  'home.startPipeline': string;
  'home.pick': string;
  'home.allPicks': string;
  'home.trending': string;
  'home.allTrending': string;
  'home.latest': string;
  'home.allLatest': string;
  'home.popularTags': string;
  'home.archiveLine': string;
  'home.topics': string;
  'home.justArchived': string;
  'home.archivedCount': string;
  'home.editorsPick': string;
  'home.rackLead': string;
  'home.engagementPending': string;
  'home.seeAll': string;

  // --- board pages

  // --- search
  'search.title': string;
  'search.heroSub': string;
  'search.placeholder': string;
  'search.label': string;
  'search.submit': string;
  'search.emptyHeading': string;
  'search.emptyBody': string;
  'search.try': string;
  'search.or': string;
  'search.noResults': string;
  'search.noResultsBody': string;
  'search.results': string;
  'search.previous': string;
  'search.next': string;

  // --- account
  'account.title': string;
  'account.connected': string;
  'account.identityNote': string;
  'account.signOut': string;
  'account.signIn': string;
  'account.signInNote': string;
  'account.continueWith': string;
  'account.googleNote': string;
  'account.adminRole': string;
  'account.unavailable': string;
  'account.unavailableNote': string;
  'account.secretsNote': string;
  'account.err.cancelled': string;
  'account.err.declined': string;
  'account.err.notConfigured': string;
  'account.err.unknownProvider': string;
  'account.err.incomplete': string;
  'account.err.state': string;
  'account.err.tokenExchange': string;
  'account.err.profile': string;
  'account.err.generic': string;

  // --- authors / saved
  'authors.title': string;
  'authors.heroSub': string;
  'authors.empty': string;
  'authors.subtitle': string;
  'authors.count': string;
  'authors.cardCount': string;
  'saved.title': string;
  'saved.heroSub': string;
  'saved.emptyHeading': string;
  'saved.emptyBody': string;
  'saved.browse': string;
  'saved.note': string;
  'saved.count': string;
  'saved.description': string;
  'category.sort.latest': string;
  'category.sort.trending': string;

  // --- 404 / category / tag / author
  'notFound.heading': string;
  'notFound.body': string;
  'notFound.homepage': string;
  'notFound.latest': string;
  'notFound.search': string;
  'category.heading': string;
  'category.emptyHeading': string;
  'category.emptyBody': string;
  'category.emptyNamed': string;
  'tag.heading': string;
  'tag.emptyHeading': string;
  'tag.emptyBody': string;
  'tag.emptyNamed': string;
  'author.heading': string;
  'author.meta': string;

  // --- article page
  'article.videoLink': string;
  'article.videoNote': string;
  'article.imageMissing': string;
  'article.imageNote': string;
  'article.embed': string;
  'article.embedView': string;
  'article.appFrom': string;
  'article.embedCardLabel': string;
  'article.embedShowMore': string;
  'article.takenDown': string;
  'article.takenDownBody': string;
  'article.reason': string;
  'article.score.final': string;
  'article.score.popularity': string;
  'article.score.quality': string;
  'article.fullTextHidden': string;
  'article.fullTextHiddenBody': string;
  'article.excerptOnly': string;
  'article.excerptNote': string;
  'article.noDocument': string;
  'article.viewOriginal': string;
  'article.moreIn': string;
  'article.thisTopic': string;
  'article.save': string;
  'article.saved': string;
  'article.latest': string;

  // --- about
  'about.title': string;
  'about.intro': string;
  'about.introCount': string;
  'about.how': string;
  'about.step1': string;
  'about.step2': string;
  'about.step3': string;
  'about.step4': string;
  'about.step5': string;
  'about.step6': string;
  'about.importer': string;
  'about.rank': string;
  'about.rankIntro': string;
  'about.rankPopularity': string;
  'about.rankVelocity': string;
  'about.rankQuality': string;
  'about.rankEditor': string;
  'about.rankOutro': string;
  'about.rights': string;
  'about.rightsBody': string;
  'about.built': string;
  'about.builtBody': string;
}

/**
 * The translations.
 *
 * Chinese and Japanese are written for a reader of those languages rather than transposed
 * word for word — `Editor's Pick` becomes `编辑精选`, not a literal rendering of "the pick of
 * the editor", because that is what a Chinese-language publication calls it. Where a term has
 * a settled form in the language (`RSS`, `Sitemap`, `Cloudflare`) it is kept.
 */
export const TRANSLATIONS: Record<SiteLang, Translations> = {
  en: {
    'nav.home': 'Home',
    'nav.featured': 'Featured',
    'nav.latest': 'Latest',
    'nav.trending': 'Trending',
    'nav.authors': 'Authors',
    'nav.primary': 'Primary',
    'nav.categories': 'Categories',
    'nav.allTopics': 'All topics',
    'header.search.placeholder': 'Search articles',
    'header.search.label': 'Search articles',
    'header.signIn': 'Sign in',
    'header.accountMenu': 'Account menu',
    'header.accountMenuNamed': 'Account menu: {name}',
    'header.menu.saved': 'Saved',
    'header.menu.account': 'Account',
    'header.menu.admin': 'Admin',
    'header.langSwitcher': 'Language',

    'footer.tagline': 'human-curated X Articles, archived and indexed on Cloudflare.',
    'footer.about': 'About',
    'footer.rss': 'RSS',
    'footer.sitemap': 'Sitemap',
    'footer.admin': 'Admin',

    'theme.legend': 'Colour theme',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'theme.system': 'Match system',

    'card.editorsPick': "Editor's Pick",
    'card.minRead': 'min read',
    'card.views': 'Views on X',
    'card.likes': 'Likes on X',
    'card.reposts': 'Reposts on X',
    'card.replies': 'Replies on X',
    'card.bookmarks': 'Bookmarks on X',
    'card.engagement': 'Engagement on X',

    'board.empty': 'Nothing here yet',
    'board.emptyBody': 'No published articles match this board. Import an X Article from the',
    'board.admin': 'admin',
    'board.orCheck': ', or check',
    'board.latest': 'Latest',
    'board.newer': '← Newer',
    'board.older': 'Older →',
    'board.page': 'Page {page}',

    'home.eyebrow': 'X Article',
    'home.heroTitle': 'The long-form, archived.',
    'home.heroBody': 'A human-curated, machine-archived library of long X Articles — organized by topic, ranked by real engagement.',
    'home.heroCta': 'Read the latest →',
    'home.noArticles': 'No published articles yet',
    'home.noArticlesBody': 'Articles appear here after they are imported and parsed. Paste X Article URLs in the',
    'home.importer': 'admin importer',
    'home.startPipeline': 'to start the pipeline.',
    'home.pick': "Editor's Pick",
    'home.allPicks': 'All picks →',
    'home.trending': 'Trending',
    'home.allTrending': 'All trending →',
    'home.latest': 'Latest',
    'home.allLatest': 'All latest →',
    'home.popularTags': 'Popular tags',
    'home.archiveLine': '{articles} articles · {authors} authors · {topics} topics',
    'home.topics': 'Topics',
    'home.justArchived': 'Latest articles',
    'home.archivedCount': '{n} archived',
    'home.editorsPick': "Editor's pick",
    'home.rackLead': 'Trending №1',
    'home.engagementPending': 'Engagement data unavailable',
    'home.seeAll': 'All latest →',


    'search.title': 'Search',
    'search.heroSub': 'Find anything in the archive.',
    'search.placeholder': 'Search titles, body text, authors and tags',
    'search.label': 'Search articles',
    'search.submit': 'Search',
    'search.emptyHeading': 'Search the archive',
    'search.emptyBody': 'Titles, summaries, full body text, author names and tags are all indexed. Try',
    'search.try': 'try',
    'search.or': 'or',
    'search.noResults': 'No results for "{q}"',
    'search.noResultsBody': 'Nothing matched. Try fewer or broader terms.',
    'search.results': '{count} results for "{q}"',
    'search.previous': '← Previous',
    'search.next': 'Next →',

    'account.title': 'Account',
    'account.connected': 'Connected accounts',
    'account.identityNote':
      'Identity here is keyed on the id Google assigned when the account was created, not on your email address. Google lets an account holder change that address, so keying on it would hand whoever holds it next the identity — the address belongs to you, the id does not move.',
    'account.signOut': 'Sign out',
    'account.signIn': 'Sign in',
    'account.signInNote':
      'An account exists so there is something for a future feature to belong to. Nothing about reading, archiving or searching the site changes when you sign in.',
    'account.continueWith': 'Continue with {provider}',
    'account.googleNote':
      'Google is the only method. There is no password to choose, forget or leak, and Google hands this site nothing beyond what it already knows — an id it assigned once, a name, a picture, and an address it has verified. Your account here is keyed on the id, not the address, so changing your Google address later does not change who you are.',
    'account.adminRole': 'admin',
    'account.unavailable': 'Sign in is not available',
    'account.unavailableNote': 'No sign-in provider is configured on this deployment. That is a deployment setting rather than a broken page:',
    'account.secretsNote': 'have to be present as secrets.',
    'account.err.cancelled': 'Sign-in was cancelled, so nothing changed.',
    'account.err.declined': 'The provider declined the sign-in request.',
    'account.err.notConfigured': 'That sign-in method is not configured on this deployment.',
    'account.err.unknownProvider': 'That sign-in method does not exist.',
    'account.err.incomplete': 'The provider sent back an incomplete response. Try again.',
    'account.err.state': 'That sign-in link could not be verified. It is single-use and expires after ten minutes, so starting again is the fix.',
    'account.err.tokenExchange': 'The provider rejected the sign-in. This usually means the callback URL does not match the one registered with the provider.',
    'account.err.profile': 'Signed in, but the provider would not return a profile. Try again in a moment.',
    'account.err.generic': 'Sign-in did not complete.',

    'authors.title': 'Authors',
    'authors.heroSub': 'The people behind the articles in this archive.',
    'authors.empty': 'No authors yet — the archive is empty.',
    'authors.subtitle': '{authors} and {articles} archived.',
    'authors.count': '{authors} · {articles} archived',
    'authors.cardCount': '{articles} article(s)',
    'saved.title': 'Saved',
    'saved.heroSub': 'Your saved articles, newest first.',
    'saved.emptyHeading': 'No saved articles',
    'saved.emptyBody': 'Press Save on any article and it appears here. Saving is private — nobody else can see this list, and it is not counted anywhere.',
    'saved.browse': 'Browse latest →',
    'saved.note': 'An article removed from the site by an editor disappears from this list too, which is why it can be shorter than the number you saved.',
    'saved.count': '{count} articles · newest first',
    'saved.description': '{count} saved articles.',
    'category.sort.latest': 'Latest',
    'category.sort.trending': 'Trending',

    'notFound.heading': '404 — not found',
    'notFound.body': 'That page does not exist, or the article was never published. Try',
    'notFound.homepage': 'the homepage',
    'notFound.latest': 'Latest',
    'notFound.search': 'search',
    'category.heading': 'Category',
    'category.emptyHeading': 'No articles in this category yet',
    'category.emptyBody': 'Nothing has been published under this category.',
    'tag.heading': 'Tag',
    'tag.emptyHeading': 'Nothing tagged yet',
    'tag.emptyBody': 'Tags are assigned during AI enrichment.',
    'author.heading': 'Author',
    'author.meta': '@{username} · {articles}',
    'tag.emptyNamed': 'Nothing tagged #{tag} yet',
    'category.emptyNamed': 'No articles in {category} yet',

    'article.videoLink': 'Watch the video on x.com',
    'article.videoNote': 'the recording is not archived here; this link goes to X',
    'article.imageMissing': 'Image not archived',
    'article.imageNote': 'this figure still loads from x.com and may stop working',
    'article.embed': 'Embedded X post',
    'article.embedView': 'View post on X',
    'article.appFrom': 'From x.ai',
    'article.embedCardLabel': 'Article',
    'article.embedShowMore': 'Show more',
    'article.takenDown': 'This article has been taken down',
    'article.takenDownBody': 'The archived copy is no longer displayed. This usually means the author requested removal, or the content raised a rights concern.',
    'article.reason': 'Reason:',
    'article.score.final': 'Final',
    'article.score.popularity': 'Popularity',
    'article.score.quality': 'Quality',
    'article.fullTextHidden': 'Full text not displayed',
    'article.fullTextHiddenBody': 'This archive does not republish the full text of this article. Read it at the original source instead.',
    'article.excerptOnly': 'Excerpt only.',
    'article.excerptNote': 'The full text is archived but not published.',
    'article.noDocument': 'The archived document for this article is not available yet.',
    'article.viewOriginal': '↗ View original on X',
    'article.moreIn': 'More in {category}',
    'article.thisTopic': 'this topic',
    'article.save': '☆ Save',
    'article.saved': '★ Saved',
    'article.latest': 'Latest',

    'about.title': 'About',
    'about.intro': 'X Article Hub is an archive of long-form posts from X, chosen by a human and organized by machines. It is currently holding',
    'about.introCount': 'published article(s).',
    'about.how': 'How an article gets here',
    'about.step1': 'An editor pastes an X Article URL into the',
    'about.step2': 'The URL is normalized and de-duplicated by its canonical form.',
    'about.step3': 'A crawl job fetches the rendered page and archives the raw HTML and Markdown.',
    'about.step4': "A parser converts that into a structured document, preserving the author's structure.",
    'about.step5': 'A successfully parsed article is published automatically.',
    'about.step6': 'AI suggests a category; editors can adjust it or remove an article.',
    'about.importer': 'importer',
    'about.rank': 'How articles are ranked',
    'about.rankIntro': 'Three signals are kept separate and blended with configurable weights, so no single number decides what you see. A fourth, time decay, favours recent articles so the boards keep moving:',
    'about.rankPopularity': 'Popularity — log-compressed likes, reposts, replies, quotes, bookmarks and views.',
    'about.rankVelocity': 'Velocity — how fast engagement is arriving, averaged over 1h, 6h and 24h windows.',
    'about.rankQuality': 'Quality — an AI assessment that can inform ranking but never publishes anything.',
    'about.rankEditor': 'Editor score — a human override.',
    'about.rankOutro': 'Trending uses the blend. Latest is strictly chronological. Editor\'s Picks are a human decision and are not a ranking. Authors is every writer in the archive, most prolific first.',
    'about.rights': 'Content and rights',
    'about.rightsBody': 'Articles here are archived copies of work written by other people. Each reading page links back to the original. Successfully parsed imports are published automatically. Editors can limit an article to an excerpt or link, or take it down at any time.',
    'about.built': 'Built on Cloudflare',
    'about.builtBody': 'Workers, D1, R2, Queues, Browser Run and Workers AI. No external search cluster, no self-hosted browser fleet, no separate VPS.',
  },

  zh: {
    'nav.home': '首页',
    'nav.featured': '精选',
    'nav.latest': '最新',
    'nav.trending': '热门',
    'nav.authors': '作者',
    'nav.primary': '主导航',
    'nav.categories': '分类',
    'nav.allTopics': '全部分类',
    'header.search.placeholder': '搜索文章',
    'header.search.label': '搜索文章',
    'header.signIn': '登录',
    'header.accountMenu': '账户菜单',
    'header.accountMenuNamed': '账户菜单：{name}',
    'header.menu.saved': '我的收藏',
    'header.menu.account': '账户',
    'header.menu.admin': '管理',
    'header.langSwitcher': '语言',

    'footer.tagline': '——人工策划的 X 长文，在 Cloudflare 上归档与索引。',
    'footer.about': '关于',
    'footer.rss': 'RSS',
    'footer.sitemap': '站点地图',
    'footer.admin': '管理',

    'theme.legend': '配色主题',
    'theme.light': '浅色',
    'theme.dark': '深色',
    'theme.system': '跟随系统',

    'card.editorsPick': '编辑精选',
    'card.minRead': '分钟阅读',
    'card.views': 'X 上的浏览量',
    'card.likes': 'X 上的点赞',
    'card.reposts': 'X 上的转发',
    'card.replies': 'X 上的回复',
    'card.bookmarks': 'X 上的收藏',
    'card.engagement': 'X 上的互动数据',

    'board.empty': '暂时还没有内容',
    'board.emptyBody': '这个榜单还没有已发布的文章。可以在',
    'board.admin': '管理后台',
    'board.orCheck': '导入文章，或查看',
    'board.latest': '最新',
    'board.newer': '← 更新',
    'board.older': '更早 →',
    'board.page': '第 {page} 页',

    'home.eyebrow': 'X 长文',
    'home.heroTitle': '长文，归档。',
    'home.heroBody': '人工挑选、机器归档的 X 长文库 —— 按主题组织，按真实互动排序。',
    'home.heroCta': '去读最新 →',
    'home.noArticles': '还没有已发布的文章',
    'home.noArticlesBody': '文章成功导入并解析后会自动出现在这里。将 X 长文链接粘贴到',
    'home.importer': '管理后台的导入器',
    'home.startPipeline': '即可开始流程。',
    'home.pick': '编辑精选',
    'home.allPicks': '全部精选 →',
    'home.trending': '热门',
    'home.allTrending': '全部热门 →',
    'home.latest': '最新',
    'home.allLatest': '全部最新 →',
    'home.popularTags': '热门标签',
    'home.archiveLine': '{articles} 篇文章 · {authors} 位作者 · {topics} 个主题',
    'home.topics': '主题',
    'home.justArchived': '最新文章',
    'home.archivedCount': '已归档 {n} 篇',
    'home.editorsPick': '编辑精选',
    'home.rackLead': '热门第 1',
    'home.engagementPending': '尚未采集互动数据',
    'home.seeAll': '全部最新 →',


    'search.title': '搜索',
    'search.heroSub': '在归档库中查找任何内容。',
    'search.placeholder': '搜索标题、正文、作者与标签',
    'search.label': '搜索文章',
    'search.submit': '搜索',
    'search.emptyHeading': '搜索归档库',
    'search.emptyBody': '标题、摘要、正文、作者名与标签都已建立索引。试试',
    'search.try': '试试',
    'search.or': '或',
    'search.noResults': '没有找到与“{q}”相关的结果',
    'search.noResultsBody': '没有匹配项。试试更少或更宽泛的关键词。',
    'search.results': '关于“{q}”的 {count} 条结果',
    'search.previous': '← 上一页',
    'search.next': '下一页 →',

    'account.title': '账户',
    'account.connected': '已关联的账户',
    'account.identityNote':
      '这里的身份以 Google 在账户创建时分配的那个 id 为准，而不是你的邮箱地址。Google 允许账户持有人更换邮箱，所以若以邮箱为准，下一个持有该邮箱的人就会继承这个身份——邮箱属于你，但那个 id 不会变动。',
    'account.signOut': '退出登录',
    'account.signIn': '登录',
    'account.signInNote': '账户的存在是为了让未来的功能有个归属。登录与否不会改变你阅读、归档或搜索本站的任何体验。',
    'account.continueWith': '使用 {provider} 继续',
    'account.googleNote':
      'Google 是唯一的登录方式。没有密码需要设置、遗忘或泄露，Google 也不会向本站提供超出它已知范围的信息——一个它曾分配的 id、一个名字、一张头像，以及一个它验证过的邮箱。你的账户以 id 为准而非邮箱，所以之后更换 Google 邮箱不会改变你的身份。',
    'account.adminRole': '管理员',
    'account.unavailable': '暂不能登录',
    'account.unavailableNote': '本次部署没有配置任何登录方式。这是部署设置问题，而不是页面坏了：',
    'account.secretsNote': '需要作为 secret 配置。',
    'account.err.cancelled': '登录已取消，因此没有任何更改。',
    'account.err.declined': '登录服务方拒绝了此次登录请求。',
    'account.err.notConfigured': '本次部署没有配置这种登录方式。',
    'account.err.unknownProvider': '这种登录方式不存在。',
    'account.err.incomplete': '登录服务方返回了不完整的响应。请重试。',
    'account.err.state': '无法验证该登录链接。它是一次性的，十分钟后失效，重新开始即可。',
    'account.err.tokenExchange': '登录服务方拒绝了此次登录。通常意味着回调地址与在服务方注册的不一致。',
    'account.err.profile': '已登录，但登录服务方未能返回个人资料。请稍后重试。',
    'account.err.generic': '登录未能完成。',

    'authors.title': '作者',
    'authors.heroSub': '这些文章背后的人。',
    'authors.empty': '还没有作者——归档库是空的。',
    'authors.subtitle': '{authors}，共 {articles}。',
    'authors.count': '{authors} · 已归档 {articles}',
    'authors.cardCount': '{articles} 篇文章',
    'saved.title': '我的收藏',
    'saved.heroSub': '你收藏的文章，最新在前。',
    'saved.emptyHeading': '还没有收藏的文章',
    'saved.emptyBody': '在任意文章上点击“收藏”，它就会出现在这里。收藏是私密的——别人看不到这个列表，也不会被计入任何统计。',
    'saved.browse': '浏览最新 →',
    'saved.note': '被编辑从站点移除的文章，也会从这个列表中消失，所以这里的数量可能少于你收藏时的数量。',
    'saved.count': '{count} 篇文章 · 最新在前',
    'saved.description': '{count} 篇收藏的文章。',
    'category.sort.latest': '最新',
    'category.sort.trending': '热门',

    'notFound.heading': '404 —— 页面不存在',
    'notFound.body': '该页面不存在，或这篇文章从未发布过。试试',
    'notFound.homepage': '返回首页',
    'notFound.latest': '最新',
    'notFound.search': '搜索',
    'category.heading': '分类',
    'category.emptyHeading': '这个分类下还没有文章',
    'category.emptyBody': '该分类下还没有已发布的内容。',
    'tag.heading': '标签',
    'tag.emptyHeading': '这个标签下还没有内容',
    'tag.emptyBody': '标签在 AI 处理阶段分配。',
    'author.heading': '作者',
    'author.meta': '@{username} · {articles}',
    'tag.emptyNamed': '“#{tag}”标签下还没有内容',
    'category.emptyNamed': '“{category}”分类下还没有文章',

    'article.videoLink': '在 x.com 上观看视频',
    'article.videoNote': '录像未在本地归档；此链接指向 X',
    'article.imageMissing': '图片未归档',
    'article.imageNote': '这张图仍从 x.com 加载，可能随时失效',
    'article.embed': '嵌入的 X 帖子',
    'article.embedView': '在 X 上查看原帖',
    'article.appFrom': '来自 x.ai',
    'article.embedCardLabel': '文章',
    'article.embedShowMore': '展开更多',
    'article.takenDown': '这篇文章已被下架',
    'article.takenDownBody': '归档副本不再展示。通常是作者要求移除，或内容存在版权方面的顾虑。',
    'article.reason': '原因：',
    'article.score.final': '综合',
    'article.score.popularity': '热度',
    'article.score.quality': '质量',
    'article.fullTextHidden': '未展示全文',
    'article.fullTextHiddenBody': '本站不转载这篇文章的全文。请前往原始来源阅读。',
    'article.excerptOnly': '仅摘要。',
    'article.excerptNote': '全文已归档，但未发布。',
    'article.noDocument': '这篇文章的归档文档暂时不可用。',
    'article.viewOriginal': '↗ 在 X 上查看原文',
    'article.moreIn': '{category} 中的更多文章',
    'article.thisTopic': '这个话题',
    'article.save': '☆ 收藏',
    'article.saved': '★ 已收藏',
    'article.latest': '最新',

    'about.title': '关于',
    'about.intro': 'X Article Hub 是 X 上长文的归档库，由人工挑选、由机器整理。目前收录了',
    'about.introCount': '篇已发布的文章。',
    'about.how': '一篇文章是怎么进来的',
    'about.step1': '编辑把 X 长文的链接粘贴到',
    'about.step2': 'URL 会被规范化，并按其规范形式去重。',
    'about.step3': '抓取任务获取渲染后的页面，归档原始 HTML 与 Markdown。',
    'about.step4': '解析器将其转换为结构化文档，保留作者原有的结构。',
    'about.step5': '解析成功后，文章自动发布。',
    'about.step6': 'AI 建议分类；编辑可以调整分类或下架文章。',
    'about.importer': '导入器',
    'about.rank': '文章是如何排序的',
    'about.rankIntro': '三个信号彼此独立，以可配置的权重混合，所以没有任何单一数字能决定你看到什么。第四个信号是时间衰减，优先展示近期文章，让榜单持续流动性：',
    'about.rankPopularity': '热度——对数压缩后的点赞、转发、回复、引用、收藏与浏览量。',
    'about.rankVelocity': '速度——互动增长有多快，取 1 小时、6 小时与 24 小时窗口的平均值。',
    'about.rankQuality': '质量——AI 的评估，可以影响排序，但永远不会直接发布任何内容。',
    'about.rankEditor': '编辑评分——人工的覆盖。',
    'about.rankOutro': '热门使用这个混合分。最新严格按时间排列。编辑精选是人工决定，不是排序。作者收录了归档库中的每一位写作者，按产量从多到少排列。',
    'about.rights': '内容与权利',
    'about.rightsBody': '这里的文章是他人作品的归档副本。每个阅读页都会链回原文。成功解析的导入文章会自动发布。编辑可以将文章限制为摘要或原文链接，也可以随时下架。',
    'about.built': '构建于 Cloudflare',
    'about.builtBody': 'Workers、D1、R2、Queues、Browser Run 与 Workers AI。没有外部搜索集群，没有自建的浏览器机群，没有独立的 VPS。',
  },

  ja: {
    'nav.home': 'ホーム',
    'nav.featured': '特集',
    'nav.latest': '新着',
    'nav.trending': '急上昇',
    'nav.authors': '著者',
    'nav.primary': 'メインナビゲーション',
    'nav.categories': 'カテゴリ',
    'nav.allTopics': 'すべて',
    'header.search.placeholder': '記事を検索',
    'header.search.label': '記事を検索',
    'header.signIn': 'ログイン',
    'header.accountMenu': 'アカウントメニュー',
    'header.accountMenuNamed': 'アカウントメニュー：{name}',
    'header.menu.saved': '保存済み',
    'header.menu.account': 'アカウント',
    'header.menu.admin': '管理',
    'header.langSwitcher': '言語',

    'footer.tagline': '——人が選び、Cloudflare 上でアーカイブ・索引化された X の長文記事。',
    'footer.about': 'このサイトについて',
    'footer.rss': 'RSS',
    'footer.sitemap': 'サイトマップ',
    'footer.admin': '管理',

    'theme.legend': 'カラーテーマ',
    'theme.light': 'ライト',
    'theme.dark': 'ダーク',
    'theme.system': 'システムに合わせる',

    'card.editorsPick': '編集部の選定',
    'card.minRead': '分で読めます',
    'card.views': 'X での表示回数',
    'card.likes': 'X でのいいね',
    'card.reposts': 'X でのリポスト',
    'card.replies': 'X での返信',
    'card.bookmarks': 'X でのブックマーク',
    'card.engagement': 'X でのエンゲージメント',

    'board.empty': 'まだ何もありません',
    'board.emptyBody': 'このボードに該当する公開記事はありません。',
    'board.admin': '管理画面',
    'board.orCheck': 'から記事をインポートするか、',
    'board.latest': '新着',
    'board.newer': '← 新しい',
    'board.older': '古い →',
    'board.page': '{page} ページ目',

    'home.eyebrow': 'X の長文記事',
    'home.noArticles': '公開された記事はまだありません',
    'home.heroTitle': '長文を、保存する。',
    'home.heroBody': '人手で選んだ X の長文記事を機械で保存・索引したライブラリ —— テーマ別整理、実 Engagement による並べ替え。',
    'home.heroCta': '最新を読む →',
    'home.noArticlesBody': '記事のインポートと解析が完了すると、ここに自動で表示されます。X の記事 URL を',
    'home.importer': '管理画面のインポーター',
    'home.startPipeline': 'に貼り付けると処理が始まります。',
    'home.pick': '編集部の選定',
    'home.allPicks': '選定記事をすべて見る →',
    'home.trending': '急上昇',
    'home.allTrending': '急上昇をすべて見る →',
    'home.latest': '新着',
    'home.allLatest': '新着をすべて見る →',
    'home.popularTags': '人気のタグ',
    'home.archiveLine': '{articles} 記事 · {authors} 著者 · {topics} テーマ',
    'home.topics': 'テーマ',
    'home.justArchived': '新着記事',
    'home.archivedCount': '{n} 本を保存',
    'home.editorsPick': '編集部の選定',
    'home.rackLead': '人気 №1',
    'home.engagementPending': 'エンゲージメントは未取得',
    'home.seeAll': '新着をすべて見る →',


    'search.title': '検索',
    'search.heroSub': 'アーカイブの中から何でも探せます。',
    'search.placeholder': 'タイトル・本文・著者・タグを検索',
    'search.label': '記事を検索',
    'search.submit': '検索',
    'search.emptyHeading': 'アーカイブを検索',
    'search.emptyBody': 'タイトル・要約・本文・著者名・タグがすべて索引化されています。',
    'search.try': '試す',
    'search.or': 'または',
    'search.noResults': '「{q}」に一致する結果はありません',
    'search.noResultsBody': '一致するものがありませんでした。より少ない、または広いキーワードで試してください。',
    'search.results': '「{q}」の検索結果 {count} 件',
    'search.previous': '← 前へ',
    'search.next': '次へ →',

    'account.title': 'アカウント',
    'account.connected': '連携済みアカウント',
    'account.identityNote':
      'ここでの識別は、アカウント作成時に Google が割り当てた id に基づいており、メールアドレスではありません。Google はアカウント保持者によるアドレス変更を認めているため、アドレスを基準にすると、次にそのアドレスを保持する人に身元が渡ってしまいます——アドレスはあなたのものでも、id は動きません。',
    'account.signOut': 'ログアウト',
    'account.signIn': 'ログイン',
    'account.signInNote':
      'アカウントは、将来の機能が属する先として存在しています。ログインしても、閲覧・アーカイブ・検索の体験は何も変わりません。',
    'account.continueWith': '{provider} で続ける',
    'account.googleNote':
      'Google が唯一の方法です。設定・忘れる・漏れるパスワードはなく、Google がこのサイトに渡すのは、すでに知られている情報だけです——かつて割り当てた id、名前、画像、そして検証済みのアドレス。あなたのアカウントはアドレスではなく id に基づくので、後で Google のアドレスを変えても、あなた自身は変わりません。',
    'account.adminRole': '管理者',
    'account.unavailable': 'ログインを利用できません',
    'account.unavailableNote': 'このデプロイにはログイン方法が設定されていません。これはページの不具合ではなくデプロイの設定です：',
    'account.secretsNote': 'を secret として設定する必要があります。',
    'account.err.cancelled': 'ログインがキャンセルされたため、何も変更されていません。',
    'account.err.declined': 'ログイン先がログイン要求を拒否しました。',
    'account.err.notConfigured': 'このデプロイにはそのログイン方法が設定されていません。',
    'account.err.unknownProvider': 'そのログイン方法は存在しません。',
    'account.err.incomplete': 'ログイン先から不完全な応答が返りました。もう一度お試しください。',
    'account.err.state': 'ログインリンクを検証できませんでした。これは一度きりで、10 分後に失効します。やり直せば解決します。',
    'account.err.tokenExchange': 'ログイン先がログインを拒否しました。多くの場合、コールバック URL が先方に登録されたものと一致していないことを意味します。',
    'account.err.profile': 'ログインはできましたが、ログイン先がプロフィールを返しませんでした。しばらくして再度お試しください。',
    'account.err.generic': 'ログインが完了しませんでした。',

    'authors.title': '著者',
    'authors.heroSub': 'このアーカイブの記事を書いた人々。',
    'authors.empty': 'まだ著者がいません——アーカイブは空です。',
    'authors.subtitle': '{authors}、アーカイブ済み {articles}。',
    'authors.count': '{authors} · アーカイブ済み {articles}',
    'authors.cardCount': '記事 {articles} 件',
    'saved.title': '保存済み',
    'saved.heroSub': '保存した記事を、新しい順に。',
    'saved.emptyHeading': '保存した記事はありません',
    'saved.emptyBody': '記事の「保存」を押すと、ここに表示されます。保存は非公開です——他の誰にも見えず、どこにも集計されません。',
    'saved.browse': '新着を見る →',
    'saved.note': '編集部がサイトから削除した記事は、このリストからも消えます。そのため、保存した数より少なく表示されることがあります。',
    'saved.count': '記事 {count} 件 · 新しい順',
    'saved.description': '保存した記事 {count} 件。',
    'category.sort.latest': '新着',
    'category.sort.trending': '急上昇',

    'notFound.heading': '404 —— ページが見つかりません',
    'notFound.body': 'そのページは存在しないか、記事が公開されていません。',
    'notFound.homepage': 'ホームへ戻る',
    'notFound.latest': '新着',
    'notFound.search': '検索',
    'category.heading': 'カテゴリ',
    'category.emptyHeading': 'このカテゴリの記事はまだありません',
    'category.emptyBody': 'このカテゴリにはまだ公開された記事がありません。',
    'tag.heading': 'タグ',
    'tag.emptyHeading': 'このタグの記事はまだありません',
    'tag.emptyBody': 'タグは AI 処理の段階で付与されます。',
    'author.heading': '著者',
    'author.meta': '@{username} · {articles}',
    'tag.emptyNamed': '「#{tag}」の記事はまだありません',
    'category.emptyNamed': '「{category}」の記事はまだありません',

    'article.videoLink': 'x.com で動画を見る',
    'article.videoNote': 'この録画はここにはアーカイブされていません。リンク先は X です',
    'article.imageMissing': '画像は未アーカイブ',
    'article.imageNote': 'この図は x.com から読み込まれており、表示できなくなる可能性があります',
    'article.embed': '埋め込み X 投稿',
    'article.embedView': 'X で元の投稿を見る',
    'article.appFrom': 'x.ai より',
    'article.embedCardLabel': '記事',
    'article.embedShowMore': 'もっと見る',
    'article.takenDown': 'この記事は削除されました',
    'article.takenDownBody': 'アーカイブされたコピーは表示されていません。多くの場合、著者による削除の依頼か、権利上の懸念によるものです。',
    'article.reason': '理由：',
    'article.score.final': '総合',
    'article.score.popularity': '人気度',
    'article.score.quality': '品質',
    'article.fullTextHidden': '全文は表示されていません',
    'article.fullTextHiddenBody': 'このアーカイブは、この記事の全文を再掲載していません。元の出典でお読みください。',
    'article.excerptOnly': '抜粋のみ。',
    'article.excerptNote': '全文はアーカイブされていますが、公開されていません。',
    'article.noDocument': 'この記事のアーカイブ文書はまだ利用できません。',
    'article.viewOriginal': '↗ X で原文を見る',
    'article.moreIn': '{category} のその他の記事',
    'article.thisTopic': 'このトピック',
    'article.save': '☆ 保存',
    'article.saved': '★ 保存済み',
    'article.latest': '新着',

    'about.title': 'このサイトについて',
    'about.intro': 'X Article Hub は、X の長文投稿を人が選び、機械が整理したアーカイブです。現在',
    'about.introCount': '件の公開記事を収録しています。',
    'about.how': '記事がここに来るまで',
    'about.step1': '編集者が X の記事 URL を',
    'about.step2': 'URL は正規化され、正規形によって重複排除されます。',
    'about.step3': 'クロールジョブがレンダリング済みのページを取得し、生の HTML と Markdown をアーカイブします。',
    'about.step4': 'パーサーがそれを構造化文書に変換し、著者の構成を保ちます。',
    'about.step5': '解析に成功した記事は自動的に公開されます。',
    'about.step6': 'AI がカテゴリを提案し、編集者はカテゴリの変更や記事の公開停止ができます。',
    'about.importer': 'インポーター',
    'about.rank': '記事の順位づけ',
    'about.rankIntro': '3 つの信号を互いに独立させ、設定可能な重みで合成します。だから単一の数字が表示内容を決めることはありません。4 つ目の時間減衰が最近の記事を優先し、ランキングを動かし続けます：',
    'about.rankPopularity': '人気度——対数圧縮した「いいね」、リポスト、返信、引用、ブックマーク、表示回数。',
    'about.rankVelocity': '勢い——エンゲージメントがどれだけ速く集まっているか。1 時間・6 時間・24 時間の窓で平均します。',
    'about.rankQuality': '品質——AI による評価。順位づけには影響しますが、何かを公開することはありません。',
    'about.rankEditor': '編集スコア——人による上書き。',
    'about.rankOutro': '急上昇はこの合成スコアを使います。新着は厳密に時系列です。編集部の選定は人の判断であり、順位づけではありません。著者にはアーカイブ内のすべての書き手が、執筆量の多い順に並びます。',
    'about.rights': 'コンテンツと権利',
    'about.rightsBody': 'ここにある記事は、他の人が書いた作品のアーカイブ複製です。各閲覧ページは原文へリンクしています。解析に成功した記事は自動的に公開されます。編集者は抜粋や原文へのリンクのみの表示に切り替えたり、いつでも公開を停止したりできます。',
    'about.built': 'Cloudflare 上に構築',
    'about.builtBody': 'Workers、D1、R2、Queues、Browser Run、Workers AI。外部の検索クラスタも、自前のブラウザ群も、別途の VPS もありません。',
  },
};

export type TranslationKey = keyof Translations;

/**
 * Fill a key's placeholders, for the strings that carry values.
 *
 * `{name}`, `{page}`, `{q}`, `{count}`, `{provider}`, `{category}`. A missing placeholder is
 * left as its literal `{token}` rather than blanked, so a mistake in the call site is visible
 * on the page instead of silently producing a sentence with a hole in it.
 *
 * The translations are applied client-side from the `data-i18n-*` attribute, which holds the
 * *unfilled* template — so the client script calls this function too, with the same values.
 * That is why the values travel in separate `data-i18n-*` companion attributes rather than
 * being baked into the stored string.
 */
/**
 * Translate an *attribute* rather than an element's text.
 *
 * `i18nAttrSpread('title', 'card.views')` produces the `data-i18n-attr-title-*` attributes
 * `LANG_SCRIPT` reads. Needed because some strings are not a text node: a metric's tooltip is
 * the `title` attribute of a list item that also holds an icon and a number, and setting
 * `textContent` there would delete both.
 */
export function i18nAttrSpread(attr: string, key: TranslationKey): Record<string, string> {
  return {
    [`data-i18n-attr-${attr}-key`]: key,
    [`data-i18n-attr-${attr}-en`]: TRANSLATIONS.en[key],
    [`data-i18n-attr-${attr}-zh`]: TRANSLATIONS.zh[key],
    [`data-i18n-attr-${attr}-ja`]: TRANSLATIONS.ja[key],
  };
}

/**
 * The `data-*` attributes that carry every language's string for a key, as an object Astro
 * can spread onto an element.
 *
 * The server renders English as the element's text; each `data-i18n-<lang>` holds the same
 * key in another language, and `LANG_SCRIPT` swaps `textContent` from one of them. Attribute
 * names are lowercased by the HTML parser, so `data-i18n-ja` reaches the DOM as written.
 *
 * Values for the strings that carry placeholders travel in their own `data-i18n-v-*`
 * attributes rather than being baked into each translated string, because the substitution
 * has to happen after the language is chosen — baking it in would need one fully-rendered
 * string per language per value, which is the combinatorics this avoids.
 */
export function i18nSpread(  key: TranslationKey,
  values: Record<string, string | number> = {},
): Record<string, string> {
  const attrs: Record<string, string> = {
    'data-i18n-key': key,
    'data-i18n-en': TRANSLATIONS.en[key],
    'data-i18n-zh': TRANSLATIONS.zh[key],
    'data-i18n-ja': TRANSLATIONS.ja[key],
  };
  const names = Object.keys(values);
  if (names.length > 0) {
    attrs['data-i18n-v'] = names.join(',');
    for (const name of names) attrs[`data-i18n-v-${name}`] = String(values[name]);
  }
  return attrs;
}

/**
 * The script that applies the reader's language, run before first paint.
 *
 * Same shape and same reasoning as `THEME_HEAD_SCRIPT`: a synchronous inline script in the
 * body, plain ES5 in a string rather than a module, because a deferred or bundled script runs
 * after the page has already painted — which would show English and then swap, the flash the
 * theme script exists to prevent.
 *
 * ## What it does
 *
 * The server renders English. Every translatable element carries `data-i18n-key` plus
 * `data-i18n-zh` / `data-i18n-ja`. This walks them and, when the cookie says another
 * language, replaces the text with that language's string, filling any `{placeholder}` from
 * the companion `data-i18n-v-*` attributes (the values are data, so they live in their own
 * attributes rather than being baked into each translated string).
 *
 * ## Why it also sets `lang` on <html>
 *
 * The document is served as `lang="en"`. A page showing Japanese with `lang="en"` is wrong
 * for a screen reader and for hyphenation, so the attribute is corrected in the same pass.
 *
 * ## Degradation
 *
 * With JavaScript off, every reader gets English. That is the language the strings are
 * authored in, so the page is complete rather than broken — the same trade the theme control
 * makes, and the reason the server renders a full language's worth of text and not a blank
 * that only a script can fill.
 */
export const LANG_SCRIPT = `(function () {
  var COOKIE = '${LANG_COOKIE}';
  var LANGS = ['${SITE_LANGS.join("','")}'];
  var DEFAULT = '${DEFAULT_LANG}';

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split('; ') : [];
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq > 0 && parts[i].slice(0, eq) === name) {
        try { return decodeURIComponent(parts[i].slice(eq + 1)); } catch (e) { return parts[i].slice(eq + 1); }
      }
    }
    return null;
  }

  var stored = readCookie(COOKIE);
  var lang = LANGS.indexOf(stored) >= 0 ? stored : DEFAULT;

  function apply(next) {
    document.documentElement.setAttribute('lang', next === 'zh' ? 'zh-Hans' : next);

    var nodes = document.querySelectorAll('[data-i18n-key]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var text = next === DEFAULT ? el.getAttribute('data-i18n-en') : el.getAttribute('data-i18n-' + next);
      if (text === null || text === undefined) continue;

      // Placeholders. The values are per-element data, so they arrive as their own attributes
      // and are substituted here rather than being frozen into each translated string.
      var vkeys = el.getAttribute('data-i18n-v');
      if (vkeys) {
        var names = vkeys.split(',');
        for (var j = 0; j < names.length; j++) {
          var name = names[j];
          var value = el.getAttribute('data-i18n-v-' + name) || '';
          text = text.split('{' + name + '}').join(value);
        }
      }
      el.textContent = text;
    }

    // Attributes that carry a translated string: a search input's placeholder, a control's
    // aria-label, a metric's title. Two spellings, because the simple one covers the fixed
    // attributes and the general one covers any attribute a caller names:
    //
    //   data-i18n-placeholder-key / data-i18n-aria-key   plus data-i18n-<kind>-<lang>
    //   data-i18n-attr-<attr>-key                        plus data-i18n-attr-<attr>-<lang>
    //
    // Kept as attributes rather than elements because there is no text node to swap — an
    // input has no children, and a list item's title needs its attribute changed, not its
    // text.
    var attrKinds = ['placeholder', 'aria'];
    for (var a = 0; a < attrKinds.length; a++) {
      var kind = attrKinds[a];
      var els = document.querySelectorAll('[data-i18n-' + kind + '-key]');
      for (var b = 0; b < els.length; b++) {
        var host = els[b];
        var val = host.getAttribute('data-i18n-' + kind + '-' + next);
        if (val === null || val === undefined) continue;
        if (kind === 'placeholder') host.setAttribute('placeholder', val);
        else host.setAttribute('aria-label', val);
      }
    }

    // The general form. The attribute name sits between data-i18n-attr- and -key, so
    // data-i18n-attr-title-key="card.views" writes the language's string into title.
    var all = document.querySelectorAll('*');
    for (var c = 0; c < all.length; c++) {
      var node = all[c];
      var names = node.getAttributeNames ? node.getAttributeNames() : [];
      for (var d = 0; d < names.length; d++) {
        var name = names[d];
        if (name.indexOf('data-i18n-attr-') !== 0 || name.slice(-4) !== '-key') continue;
        var attr = name.slice('data-i18n-attr-'.length, name.length - '-key'.length);
        var translated = node.getAttribute('data-i18n-attr-' + attr + '-' + next);
        if (translated !== null && translated !== undefined) node.setAttribute(attr, translated);
      }
    }

    // The switcher marks the active language. Falls back silently when absent, because the
    // control is rendered by the header and this script never assumes it ran first.
    var opts = document.querySelectorAll('[data-lang-option]');
    for (var k = 0; k < opts.length; k++) {
      var chosen = opts[k].getAttribute('data-lang-option') === next;
      opts[k].setAttribute('aria-pressed', chosen ? 'true' : 'false');
      if (chosen) opts[k].classList.add('is-active');
      else opts[k].classList.remove('is-active');
    }
  }

  apply(lang);

  // The switcher persists the choice and re-applies immediately. Applying is not optional:
  // the failure this pattern guards against is a control that records a preference and
  // repaints nothing, which is exactly what the theme switch did before it was fixed.
  document.addEventListener('click', function (event) {
    var target = event.target;
    while (target && target !== document) {
      if (target.getAttribute && target.getAttribute('data-lang-option')) break;
      target = target.parentNode;
    }
    if (!target || target === document) return;
    event.preventDefault();
    var chosen = target.getAttribute('data-lang-option');
    if (LANGS.indexOf(chosen) < 0) return;
    try {
      document.cookie = COOKIE + '=' + encodeURIComponent(chosen) + '; path=/; max-age=' + (60 * 60 * 24 * 365) + '; SameSite=Lax';
    } catch (e) { /* storage denied: the choice still applies for this page */ }
    apply(chosen);
  });
})();`;
