import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Every identifier an `.astro` template uses must be imported (or declared) in its frontmatter.
 *
 * ## Why this exists
 *
 * Three times now a helper has been used in an `.astro` file and not imported, and every time it
 * shipped: `tsc` skips `.astro` files and `astro check` is not installed, so an undefined name in
 * a template compiles, passes every test that reads the file as text, deploys, and then throws
 * `ReferenceError` on the Worker. The page renders its `<head>` and stops, so the site looks
 * healthy from the front door while the affected route returns an empty 500.
 *
 *   - `i18nAttrSpread` in `SiteHeader.astro` — every page
 *   - `inlineToText` in `article/[slug].astro` — every article page, twice
 *
 * A test that reads the source and looks for the import is crude, and it is the only thing in this
 * pipeline that can catch the mistake before production.
 *
 * ## How it decides
 *
 * For each `.astro` file it collects the identifiers used in the template half, drops the ones
 * that are locally declared, imported, built-in globals, or HTML/Astro keywords, and asserts the
 * rest are known. The known set is assembled from the frontmatter's imports plus the file's own
 * declarations, which is exactly what the template can legally reference.
 */

/** Directories never worth scanning. */
const SKIP = new Set(['node_modules', 'dist', '.git', '.wrangler']);

function astroFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP.has(entry)) return [];
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? astroFiles(full) : entry.endsWith('.astro') ? [full] : [];
  });
}

/** The frontmatter and the template, split on the two `---` fences. */
function split(source: string): { front: string; template: string } {
  if (!source.startsWith('---')) return { front: '', template: source };
  const end = source.indexOf('\n---', 3);
  if (end === -1) return { front: '', template: source };
  return { front: source.slice(3, end), template: source.slice(end + 4) };
}

/** Identifiers the frontmatter makes available to the template. */
function declared(front: string): Set<string> {
  const names = new Set<string>();
  // import … from '…' — default, named (with aliases), and namespace forms.
  for (const m of front.matchAll(/import\s+([^'";]+?)\s+from\s+['"]/g)) {
    const clause = m[1] ?? '';
    for (const part of clause.matchAll(/([A-Za-z_$][\w$]*)\s*(?:,|$|\})/g)) {
      if (part[1]) names.add(part[1]);
    }
    for (const part of clause.matchAll(/as\s+([A-Za-z_$][\w$]*)/g)) {
      if (part[1]) names.add(part[1]);
    }
  }
  // `const`/`let`/`function` declarations in the frontmatter.
  for (const m of front.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) {
    if (m[1]) names.add(m[1]);
  }
  // Destructuring: `const { a, b: c } = …`.
  for (const m of front.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const name = part.includes(':') ? part.split(':')[1] : part;
      const trimmed = (name ?? '').trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) names.add(trimmed);
    }
  }
  // `Astro`, `props` and `slots` come from the framework.
  for (const n of ['Astro', 'props', 'slots', 'Fragment']) names.add(n);
  return names;
}

/**
 * Names a template may use without importing them.
 *
 * Deliberately explicit rather than derived: a name that is missing from here is a false
 * positive, and a false positive makes the test something people learn to ignore. Adding to this
 * list should be a decision, not a shrug.
 */
const ALLOWED = new Set([
  // ECMAScript / web globals a template might reasonably touch.
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'Math', 'Number', 'String', 'Boolean',
  'Array', 'Object', 'JSON', 'Date', 'Map', 'Set', 'Promise', 'Error', 'RegExp', 'Symbol', 'BigInt',
  'Intl', 'URL', 'URLSearchParams', 'encodeURIComponent', 'decodeURIComponent', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'console', 'globalThis', 'window', 'document',
  // Astro / language keywords that appear in a template.
  'as', 'of', 'in', 'typeof', 'instanceof', 'new', 'void', 'delete', 'keyof', 'infer', 'await',
  'async', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'default', 'break', 'continue',
  'const', 'let', 'var', 'function', 'class', 'extends', 'try', 'catch', 'finally', 'throw',
  'this', 'super', 'yield', 'import', 'export', 'from', 'type', 'interface', 'enum',
  // HTML / SVG element and attribute names that look like identifiers in `{}` expressions.
  'style', 'class', 'id', 'title', 'name', 'type', 'value', 'href', 'src', 'alt', 'width', 'height',
]);

describe('astro templates import what they use', () => {
  const files = astroFiles(resolve('src'));

  it('scans a meaningful number of files', () => {
    // A glob that silently matches nothing would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(10);
  });

  it('uses no undefined identifier in any template', () => {
    const problems: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const { front, template } = split(source);
      const known = declared(front);

        // Both halves are scanned. `tsc` processes neither — an `.astro` file is not a `.ts`
        // file it looks at — so a name missing from the frontmatter imports goes unchecked there
        // too, which is exactly how `inlineToText` shipped twice.
        //
        // `<script>` bodies are their own scope (a function defined inside one is not a template
        // identifier), and comments and string literals are not code: a `{/* … */}` and a quoted
        // SQL fragment both look like calls otherwise.
        const strip = (t: string): string =>
          t
            .replace(/<script[\s\S]*?<\/script>/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/`[^`]*`/g, '``')
            .replace(/'[^'\n]*'/g, "''")
            .replace(/"[^"\n]*"/g, '""');

        const markup = strip(front) + '\n' + strip(template);

      // Only call-shaped identifiers: `name(`. A bare name in text is prose, and a component
      // used as a tag is already covered because Astro resolves it from the import.
      for (const m of markup.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = m[1];
        if (!name || ALLOWED.has(name) || known.has(name)) continue;
        // A member call (`a.b(`) is not this; the lookbehind above already excludes `.`.
        problems.push(`${file.replace(resolve('.'), '.')}: ${name}(`);
      }
    }
    expect(problems, `undefined identifiers:\n${problems.join('\n')}`).toEqual([]);
  });

  it('catches a helper that is used but not imported', () => {
    // The self-check: if this assertion ever passes trivially the test above proves nothing.
    // It builds the same decision from a string, so the logic is exercised rather than assumed.
    const source = `---\nconst local = 1;\n---\n<p>{local}</p>{missingHelper()}`;
    const { front, template } = split(source);
    const known = declared(front);
    const used = [...template.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
    expect(used).toContain('missingHelper');
    expect(known.has('local')).toBe(true);
    expect(known.has('missingHelper')).toBe(false);
  });
});
