import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import light from 'shiki/themes/github-light.mjs';
import dark from 'shiki/themes/github-dark.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import json from 'shiki/langs/json.mjs';
import html from 'shiki/langs/html.mjs';
import css from 'shiki/langs/css.mjs';
import bash from 'shiki/langs/bash.mjs';
import python from 'shiki/langs/python.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import http from 'shiki/langs/http.mjs';
import sql from 'shiki/langs/sql.mjs';
import tsx from 'shiki/langs/tsx.mjs';

// A bounded grammar bundle and JS regex engine work without WASM in Workers.
const highlighter = createHighlighterCore({
  themes: [light, dark],
  langs: [javascript, typescript, json, html, css, bash, python, markdown, http, sql, tsx],
  engine: createJavaScriptRegexEngine(),
});

export async function highlightCode(code: string, language?: string): Promise<string> {
  const h = await highlighter;
  const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', jsx: 'tsx', sh: 'bash', shell: 'bash', py: 'python', md: 'markdown', plaintext: 'text' };
  const requested = (language || 'text').toLowerCase();
  const lang = aliases[requested] || requested;
  return h.codeToHtml(code, {
    lang: h.getLoadedLanguages().includes(lang) ? lang : 'text',
    themes: { light: 'github-light', dark: 'github-dark' },
  });
}
