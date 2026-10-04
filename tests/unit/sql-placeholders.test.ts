import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every SQL statement in this repo binds its values by number — `?1`, `?2`, … — and D1
 * rejects a mismatch at runtime with a 500 and nothing resembling a useful message.
 *
 * This exists because of one: adding four columns to the demo seeder's INSERT also added
 * a fifth placeholder, so the statement had 36 columns and 37 values. Nothing local
 * caught it — the type checker cannot count SQL values, and no unit test touched the
 * seeder. What caught it was the public-site acceptance run failing to seed, which is a
 * long way round from a typo.
 *
 * So the statements are checked structurally: an INSERT's column list and value list must
 * be the same length, and the highest placeholder must not exceed the number of
 * arguments actually bound.
 */

const read = (path: string) => readFileSync(resolve(path), 'utf8');

/**
 * Split on commas that are not inside a string or a nested bracket.
 *
 * Counting bind arguments with a plain `split(',')` is wrong: `a.tags.join(' ')` and
 * `clampInt(a, b, c)` both contain commas that are not argument separators, and an
 * over-count here means the guard cannot fail.
 */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? '';
    if (quote) {
      current += char;
      if (char === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

/** The `INSERT INTO <table> (cols…) VALUES (vals…)` statements in a file. */
function inserts(source: string): Array<{ table: string; columns: string[]; values: string[] }> {
  const found: Array<{ table: string; columns: string[]; values: string[] }> = [];
  // `[^`]` rather than `[\s\S]`, and it is load-bearing. These are SQL inside template
  // literals, so a lazy `[\s\S]*?` happily runs past the end of one statement into the
  // next: `article_tags` uses `INSERT … SELECT` with no VALUES clause at all, and the
  // first version of this reported it as "9 columns and 6 values" by pairing its column
  // list with the *following* statement's VALUES. Excluding the backtick makes crossing
  // a statement boundary impossible, at the cost of not checking INSERT…SELECT — which
  // binds positionally and cannot have this bug.
  const re = /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^`]*?)\)\s*VALUES\s*\(([^`]*?)\)`/g;
  for (const match of source.matchAll(re)) {
    found.push({
      table: match[1] ?? '',
      columns: splitTopLevel(match[2] ?? ''),
      values: splitTopLevel(match[3] ?? ''),
    });
  }
  return found;
}

/** Placeholder numbers used in a fragment, e.g. `[1, 2, 5]`. */
function placeholders(fragment: string): number[] {
  return [...new Set([...fragment.matchAll(/\?(\d+)/g)].map((m) => Number(m[1] ?? 0)))].sort((a, b) => a - b);
}

/** The argument list of the `.bind(…)` that follows a statement, counted properly. */
function bindArgsAfter(source: string, from: number): number {
  const open = source.indexOf('.bind(', from);
  if (open === -1) return 0;
  let depth = 0;
  let quote: string | null = null;
  let args = 0;
  let sawContent = false;

  for (let i = open + '.bind('.length; i < source.length; i++) {
    const char = source[i] ?? '';
    if (quote) {
      if (char === quote && source[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      sawContent = true;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth++;
    if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return args;
      depth--;
      continue;
    }
    if (char === ',' && depth === 0) {
      args++;
      continue;
    }
    if (!/\s/.test(char)) sawContent = true;
  }
  return args + (sawContent ? 1 : 0);
}

const WRITERS = ['src/services/seed-demo.ts', 'src/services/parse.ts', 'src/services/crawl.ts'];

describe('SQL placeholders', () => {
  it('gives every INSERT the same number of columns and values', () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const file of WRITERS) {
      for (const statement of inserts(read(file))) {
        checked++;
        if (statement.columns.length !== statement.values.length) {
          offenders.push(
            `${file}: INSERT INTO ${statement.table} has ${statement.columns.length} columns ` +
              `and ${statement.values.length} values`,
          );
        }
      }
    }
    expect(offenders, offenders.join('; ')).toEqual([]);
    // If the pattern stopped matching, the guard would pass vacuously.
    expect(checked, 'no INSERT statements were found to check').toBeGreaterThan(1);
  });

  it('never binds fewer arguments than the highest placeholder', () => {
    const source = read('src/services/seed-demo.ts');
    const offenders: string[] = [];

    for (const match of source.matchAll(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+articles[\s\S]*?`/g)) {
      const used = placeholders(match[0]);
      if (used.length === 0) continue;
      const bound = bindArgsAfter(source, (match.index ?? 0) + match[0].length);
      if (bound < used[used.length - 1]!) {
        offenders.push(`binds ${bound} arguments but uses ?${used[used.length - 1]}`);
      }
    }
    expect(offenders, offenders.join('; ')).toEqual([]);
  });

  it('does not leave a placeholder gap', () => {
    // `?1, ?2, ?4` binds three values and numbers them as if they were four, which reads
    // as a typo even where the count happens to line up.
    const source = read('src/services/seed-demo.ts');
    for (const match of source.matchAll(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+articles[\s\S]*?`/g)) {
      const used = placeholders(match[0]);
      expect(used, 'placeholders must start at 1').toContain(1);
      for (let i = 1; i <= used.length; i++) {
        expect(used, `?${i} is missing`).toContain(i);
      }
    }
  });

  it('splits bind arguments on top-level commas only', () => {
    // The guard is only as good as this. If it over-counted, `binds 3 arguments but uses
    // ?4` could never fire and the check above would be decoration.
    expect(splitTopLevel("'a,b', c, d")).toEqual(["'a,b'", 'c', 'd']);
    expect(splitTopLevel('f(1, 2), g')).toEqual(['f(1, 2)', 'g']);
    expect(splitTopLevel('a.tags.join(\' \'), now')).toEqual(["a.tags.join(' ')", 'now']);
  });
});