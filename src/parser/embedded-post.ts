/** Turn the flattened X post chip into one marker before parsing article prose. */
export function recoverEmbeddedPosts(markdown: string, html: string): {
  markdown: string;
  posts: Array<{ postId: string; url: string; author: string; text: string }>;
} {
  const posts: Array<{ postId: string; url: string; author: string; text: string }> = [];
  const ids = new Set([...html.matchAll(/data-href=["']\/i\/web\/status\/(\d+)["']/g)].map(m => m[1]));
  const recovered = markdown.replace(
    /\[!\[[^\]]*\]\([^\n]+\)\]\(https:\/\/x\.com\/[^\n]+\)\n\n\[([^\]]+)\]\(https:\/\/x\.com\/([^\s)]+)\)\n\n\[@[^\]]+\]\([^\n]+\)\n\n\[[^\]]+\]\(https:\/\/x\.com\/[^/]+\/status\/(\d+)\)\n\n([\s\S]*?)\n\n\[[^\]]+\]\(https:\/\/x\.com\/compose\/post\?in_reply_to=\3\)(?:\n\n[\d.,KM]+){0,4}/g,
    (whole, author: string, handle: string, postId: string, body: string) => {
      if (!ids.has(postId)) return whole;
      const text = body.replace(/\n\n\d{1,2}:\d{2}\s*$/, '').trim();
      posts.push({ postId, url: `https://x.com/${handle}/status/${postId}`, author, text });
      return `\n\nXEMBEDPOST${postId}\n\n`;
    },
  );
  return { markdown: recovered, posts };
}
