// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * cue-ui 0.34.0's gliding marks and swipeable tabs (cue-ui-79, cue-ui-80), which a component draws only when asked:
 * every tab strip holds a `Tabs.Indicator`, every segmented control and the sidebar take `indicator`, and every tab
 * strip is a page's own, so each swipes. Read from the source, so a strip or a control added later is held to it too;
 * `marks.test.tsx` sees the same in the rendered app.
 */

const SRC = fileURLToPath(new URL('../', import.meta.url));

/** Every `.tsx` the app is built from, by its path under `src/`, with its text. */
function sources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'test') walk(path);
      } else if (name.endsWith('.tsx'))
        out.push([relative(SRC, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')]);
    }
  };
  walk(SRC);
  return out;
}

/** Each opening tag of `<name` in `text`, up to the `>` that closes it outside any `{…}` expression. */
function openingTags(text: string, name: string): string[] {
  const tags: string[] = [];
  const pattern = new RegExp(`<${name.replace('.', '\\.')}(?![\\w.])`, 'g');
  for (const match of text.matchAll(pattern)) {
    let depth = 0;
    for (let i = match.index; i < text.length; i += 1) {
      const char = text[i];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (char === '>' && depth === 0) {
        tags.push(text.slice(match.index, i + 1));
        break;
      }
    }
  }
  return tags;
}

/** Whether a JSX opening tag sets the boolean `prop`, bare or as `{true}`. */
const sets = (tag: string, prop: string): boolean => new RegExp(`\\s${prop}(?:=\\{true\\})?(?=[\\s/>])`).test(tag);

describe('the marks and the swipe, in the source', () => {
  const files = sources();

  it('every tab strip holds a gliding indicator', () => {
    let lists = 0;
    for (const [path, text] of files) {
      for (const [index, open] of [...text.matchAll(/<Tabs\.List\b/g)].entries()) {
        const close = text.indexOf('</Tabs.List>', open.index);
        expect(close, `${path}: list ${index + 1} closes`).toBeGreaterThan(-1);
        expect(text.slice(open.index, close), `${path}: list ${index + 1}`).toContain('<Tabs.Indicator />');
        lists += 1;
      }
    }
    expect(lists).toBe(4);
  });

  it('every tab strip is a page-level one, on the four screens that have one, and swipes', () => {
    const roots = files.flatMap(([path, text]) => openingTags(text, 'Tabs.Root').map((tag) => [path, tag] as const));
    expect(roots.map(([path]) => path).sort()).toEqual([
      'screens/Accounts.tsx',
      'screens/Approvals.tsx',
      'screens/Events.tsx',
      'screens/Queue.tsx',
    ]);
    for (const [path, tag] of roots) expect(sets(tag, 'swipe'), `${path}: ${tag}`).toBe(true);
  });

  it('every segmented control glides', () => {
    const controls = files.flatMap(([path, text]) =>
      openingTags(text, 'SegmentedControl').map((tag) => [path, tag] as const),
    );
    expect(controls).toHaveLength(19);
    for (const [path, tag] of controls) expect(sets(tag, 'indicator'), `${path}: ${tag}`).toBe(true);
  });

  it("the sidebar's ground glides", () => {
    const sidebars = files.flatMap(([, text]) => openingTags(text, 'AppShell.Sidebar'));
    expect(sidebars).toHaveLength(1);
    expect(sets(sidebars[0] ?? '', 'indicator')).toBe(true);
  });
});
