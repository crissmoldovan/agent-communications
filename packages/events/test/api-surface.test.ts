import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';
import { PACKAGE_ROOT } from './support/realm.ts';

const SOURCE_INDEX = join(PACKAGE_ROOT, 'src', 'index.ts');
const DIST_INDEX = join(PACKAGE_ROOT, 'dist', 'index.d.mts');
const EXPECTED = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'test', 'api-surface.json'), 'utf8')) as string[];

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function filesUnder(directory: string): SourceFile[] {
  return readdirSync(directory, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith('.ts'))
    .sort()
    .map((path) => ({ path: join(directory, path), text: readFileSync(join(directory, path), 'utf8') }));
}

/** Parse source and declarations without resolving them: this check needs their exported syntax, not their implementation. */
function syntaxTrees(files: readonly SourceFile[]) {
  const root = '/agentcomms-events-api-surface';
  const config = posix.join(root, 'tsconfig.json');
  const paths = files.map((file) => posix.join(root, file.path.slice(PACKAGE_ROOT.length + 1)));
  const api = new API({
    fs: createVirtualFileSystem({
      [config]: JSON.stringify({ compilerOptions: { noLib: true, noResolve: true }, files: paths }),
      ...Object.fromEntries(files.map((file, index) => [paths[index] as string, file.text])),
    }),
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      if (project === undefined) throw new Error('the export check could not open its project');
      const diagnostics = project.program.getSyntacticDiagnostics();
      if (diagnostics.length > 0)
        throw new Error(`the export check needs valid syntax: ${JSON.stringify(diagnostics)}`);
      return new Map(
        files.map((file, index) => {
          const path = paths[index] as string;
          const tree = project.program.getSourceFile(path);
          if (tree === undefined) throw new Error(`the export check did not parse ${file.path}`);
          return [path, tree] as const;
        }),
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function hasExportModifier(statement: ts.Statement): boolean {
  const modifiers = (statement as unknown as { readonly modifiers?: readonly ts.Modifier[] }).modifiers ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return undefined;
}

function declarationNames(statement: ts.Statement): readonly string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name !== undefined
  ) {
    return [statement.name.text];
  }
  return [];
}

/** The names a barrel exports, recursively following only its relative export-from declarations. */
function exportsOf(
  path: string,
  trees: ReadonlyMap<string, ts.SourceFile>,
  seen = new Map<string, Set<string>>(),
): Set<string> {
  const cached = seen.get(path);
  if (cached !== undefined) return cached;
  const tree = trees.get(path);
  if (tree === undefined) throw new Error(`the export check has no syntax tree for ${path}`);
  const names = new Set<string>();
  seen.set(path, names);
  for (const statement of tree.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause === undefined && statement.moduleSpecifier !== undefined) {
        const target = literalText(statement.moduleSpecifier);
        if (target?.startsWith('.')) {
          for (const name of exportsOf(resolve(dirname(path), target), trees, seen)) names.add(name);
        }
      } else if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      } else if (statement.exportClause !== undefined && ts.isNamespaceExport(statement.exportClause)) {
        names.add(statement.exportClause.name.text);
      }
      continue;
    }
    if (hasExportModifier(statement)) for (const name of declarationNames(statement)) names.add(name);
  }
  return names;
}

function namesFrom(path: string, files: readonly SourceFile[]): string[] {
  const root = '/agentcomms-events-api-surface';
  const trees = syntaxTrees(files);
  return [...exportsOf(posix.join(root, path.slice(PACKAGE_ROOT.length + 1)), trees)].sort();
}

test('the export list is frozen', () => {
  assert.deepEqual(EXPECTED, [...EXPECTED].sort(), 'api-surface.json is sorted');
  const source = filesUnder(join(PACKAGE_ROOT, 'src'));
  assert.deepEqual(namesFrom(SOURCE_INDEX, source), EXPECTED, 'src/index.ts exports');
  const declaration = { path: DIST_INDEX, text: readFileSync(DIST_INDEX, 'utf8') };
  assert.deepEqual(namesFrom(DIST_INDEX, [declaration]), EXPECTED, 'dist/index.d.mts exports');
});
