/**
 * Where the repository's tests build rule documents: every object literal with a `deliveryRateCap` and either `targets`
 * or a spread, found by syntax with the repository's own TypeScript. The harvester (`harvest.mjs`) evaluates these
 * literals into `test/fixtures/rule-text/repository-rules.json`; `rule-text-fixtures.test.ts` counts them again per
 * file, so a rule literal added anywhere, in a new file or in one already harvested, fails until it is harvested.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';

export interface TestSource {
  /** The path from the repository root, with forward slashes. */
  readonly path: string;
  readonly text: string;
}

export interface RuleLiteralSite {
  /** 1-based, in source order within its file: how the harvester's locals name a literal. */
  readonly ordinal: number;
  /** 1-based line of the literal's `{`. */
  readonly line: number;
  /** UTF-16 offsets of the literal, `{` to `}`. */
  readonly start: number;
  readonly end: number;
  /** Whether the literal is inside a function, so a module's top level cannot evaluate it as it stands. */
  readonly inFunction: boolean;
  /** The module-level function the literal is in, when it is one, so the harvester can call it where the file does. */
  readonly helper?: string;
}

export interface RuleLiteralFile {
  readonly sites: readonly RuleLiteralSite[];
  /** Each call of one of the file's helpers, as offsets, for the harvester to try in the module's scope. */
  readonly calls: readonly { readonly start: number; readonly end: number }[];
}

const EXTENSIONS = ['.ts', '.mts', '.mjs', '.js'];

/** The repository's test sources outside this package that name `deliveryRateCap`: the only ones that can build a rule. */
export function repositoryTestSources(repository: string): TestSource[] {
  const found: TestSource[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(repository, directory), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const path = posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
      if (!(path.includes('/test/') || path.startsWith('test/')) || path.startsWith('packages/events/')) continue;
      const text = readFileSync(join(repository, ...path.split('/')), 'utf8');
      if (text.includes('deliveryRateCap')) found.push({ path, text });
    }
  };
  for (const root of ['packages', 'apps', 'test']) visit(root);
  return found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function parse(sources: readonly TestSource[]): Map<string, ts.SourceFile> {
  const root = '/agentcomms-rule-fixture-sites';
  const config = posix.join(root, 'tsconfig.json');
  const api = new API({
    fs: createVirtualFileSystem({
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, allowJs: true },
        files: sources.map((source) => source.path),
      }),
      ...Object.fromEntries(sources.map((source) => [posix.join(root, source.path), source.text])),
    }),
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      if (project === undefined) throw new Error('the rule fixture scan could not open its project');
      const broken = project.program.getSyntacticDiagnostics();
      if (broken.length > 0)
        throw new Error(`the rule fixture scan needs valid syntax: ${JSON.stringify(broken.slice(0, 3))}`);
      return new Map(
        sources.map((source) => {
          const tree = project.program.getSourceFile(posix.join(root, source.path));
          if (tree === undefined) throw new Error(`the rule fixture scan did not parse ${source.path}`);
          return [source.path, tree] as const;
        }),
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
    const name = property.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  }
  return undefined;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** The name of a module-level function `node` is, by declaration or as a `const` initialiser. */
function moduleFunctionName(node: ts.Node, tree: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.parent === tree) return node.name.text;
  const declaration = node.parent;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer !== node)
    return undefined;
  const statement = declaration.parent?.parent;
  if (statement === undefined || !ts.isVariableStatement(statement) || statement.parent !== tree) return undefined;
  return ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

/** Every rule literal of each source that has one, in source order, with the calls of its module-level helpers. */
export function ruleLiteralSites(sources: readonly TestSource[]): Map<string, RuleLiteralFile> {
  const trees = parse(sources);
  const result = new Map<string, RuleLiteralFile>();
  for (const source of sources) {
    const tree = trees.get(source.path) as ts.SourceFile;
    const sites: RuleLiteralSite[] = [];
    const helpers = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const names = node.properties.map(propertyName);
        const spread = node.properties.some((property) => ts.isSpreadAssignment(property));
        if (names.includes('deliveryRateCap') && (names.includes('targets') || spread)) {
          let outer: ts.Node | undefined;
          for (let at = node.parent; at !== undefined; at = at.parent) if (isFunctionLike(at)) outer = at;
          const helper = outer === undefined ? undefined : moduleFunctionName(outer, tree);
          if (helper !== undefined) helpers.add(helper);
          const start = node.getStart(tree);
          sites.push({
            ordinal: sites.length + 1,
            line: source.text.slice(0, start).split('\n').length,
            start,
            end: node.end,
            inFunction: outer !== undefined,
            ...(helper === undefined ? {} : { helper }),
          });
        }
      }
      node.forEachChild(visit);
    };
    visit(tree);
    if (sites.length === 0) continue;
    const calls: { start: number; end: number }[] = [];
    const findCalls = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text))
        calls.push({ start: node.getStart(tree), end: node.end });
      node.forEachChild(findCalls);
    };
    findCalls(tree);
    result.set(source.path, { sites, calls });
  }
  return result;
}

/** The repository root, from this file's place in it. */
export function repositoryRoot(): string {
  return join(import.meta.dirname, '..', '..', '..', '..');
}
