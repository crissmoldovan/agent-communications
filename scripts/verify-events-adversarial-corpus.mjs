import assert from 'node:assert/strict';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFlags, SyntaxKind } from 'typescript/unstable/ast';
import { API, TypeFlags } from 'typescript/unstable/sync';

const SYNTHETIC_HOST_SUFFIXES = Object.freeze(['.test', '.invalid', '.example']);
const SYNTHETIC_NON_HOST_IDENTIFIERS = new Set([
  'answer.match',
  'answer.noul',
  'answer.tool',
  'answer.type',
  'assert.deepequal',
  'buffer.concat',
  'buffer.from',
  'gmail.message.received',
  'input.maxoutputtokens',
  'inputs.map',
  'judgetransport.execute',
  'judgepurge.event',
  'normalised.endswith',
  'number.isfinite',
  'object.keys',
  'parsed.usage',
  'parsed.usage.input',
  'parsed.usage.output',
  'reservation.id',
  'socket.write',
  'suffixes.some',
  'work.account',
  'work.event',
  'work.rule',
  'work.source',
]);
const KNOWN_SECRET_MATERIAL =
  /(?<![A-Za-z0-9])(?:npm_|glpat-|gh[opusr]_|github_pat_|sk-|sk_live_|sk_test_|rk_|re_|SG\.|xox[abprs]-|AKIA|ASIA|AIza|ya29\.)[A-Za-z0-9+/_-]+|(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}(?![A-Za-z0-9])|-----BEGIN/u;
const CREDENTIAL_ASSIGNMENT =
  /(?<![A-Za-z0-9_-])(?:key|token|secret|password|authorization|bearer|api[_-]?key)["']?\s*[:=]\s*["']?[^\s"',}\]]+/iu;
const CREDENTIAL_FIELD = /^(?:key|token|secret|password|authorization|bearer|api[_-]?key)$/iu;
const KEY_LIKE_RUN = /(?:[A-Za-z0-9+/_-]{24,}|[A-Za-z0-9+/_-]{22,}={1,2})/gu;
const KEY_LIKE_IDENTIFIER = /[A-Za-z0-9+/_-]{24,}/u;
const PROVIDER_CAPTURE_FIELD = /["']?(?:x-request-id|cf-ray|x-ratelimit-limit|set-cookie|server)["']?\s*:/iu;
const PROVIDER_CAPTURE_TUPLE = /\[\s*["'](?:x-request-id|cf-ray|x-ratelimit-limit|set-cookie|server)["']\s*,/iu;
const PROVIDER_CAPTURE_NAME = /^(?:x-request-id|cf-ray|x-ratelimit-limit|set-cookie|server)$/iu;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIRECTORY = 'packages/events-daemon/test/fixtures/judges';
const SUPPORT_DIRECTORY = 'packages/events-daemon/test/support';
const TYPESAFE_ENDPOINT_IDENTIFIER = 'TYPESAFE_SYSTEM_ONE_ENDPOINT';
const TYPESAFE_ENDPOINT_MODULE = '../../src/domain/judges.ts';
const EVENT_EVALUATOR_IDENTIFIER = 'EventEvaluator';
const EVENT_EVALUATOR_MODULE = '../../src/runtime/evaluate.ts';
const ASSIGNMENT_OPERATORS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '&&=',
  '||=',
  '??=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
]);
const ALLOWED_STRING_CALLS = new Set([
  'this.#values.get(ref)',
  'row.id.slice(0,12)',
  "'x'.repeat(66_000)",
  'JSON.parse(stored.document)',
  'JSON.stringify(changed)',
  "row.id.replaceAll(/[^a-z0-9]/giu,'').padEnd(29,'0').slice(0,29)",
  "row.id.replaceAll(/[^a-z0-9]/giu,'').padEnd(29,'0')",
  "row.id.replaceAll(/[^a-z0-9]/giu,'')",
  'String(event.type)',
  'String(error)',
  "(awaitcipher.decrypt({table:'decisions',column:'encryptedRecord',key:[{type:'text',value:decision.id}]},decision.encrypted_record,)).toString('utf8')",
  "transportRefusal.code.toLowerCase().replaceAll('_','-')",
  'transportRefusal.code.toLowerCase()',
  'JSON.stringify(durableContent)',
  "join(import.meta.dirname,'..','..')",
  "join(packageRoot,'..','..')",
  "join(packageRoot,'.mutants')",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source text for the closed call allowlist.
  "name.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')",
  "join(root,'packages','events-daemon')",
  "join(packageRoot,'src')",
  "join(copiedPackage,'src')",
  "join(packageRoot,'test')",
  "join(copiedPackage,'test')",
  "join(packageRoot,'package.json')",
  "join(copiedPackage,'package.json')",
  "join(packageRoot,'tsconfig.json')",
  "join(copiedPackage,'tsconfig.json')",
  "join(repositoryRoot,'scripts')",
  "join(root,'scripts')",
  "join(repositoryRoot,'test','helpers')",
  "join(root,'test','helpers')",
  "join(repositoryRoot,'capabilities.json')",
  "join(root,'capabilities.json')",
  "join(repositoryRoot,'package.json')",
  "join(root,'package.json')",
  "join(repositoryRoot,'tsconfig.base.json')",
  "join(root,'tsconfig.base.json')",
  "join(repositoryRoot,'node_modules')",
  "join(root,'node_modules')",
  "join(packageRoot,'node_modules')",
  "join(copiedPackage,'node_modules')",
  "join(process.platform==='win32'?tmpdir():'/tmp',prefix)",
  'tmpdir()',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source text for the closed call allowlist.
  "mutation.testName.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')",
  "join(mutantsRoot,mutation.id,'tree')",
  'join(mutantsRoot,mutation.id)',
  'join(root,mutation.source)',
  "join(root,'test/helpers/loopback-seal-preload.mjs')",
  'exactTestName(mutation.testName)',
  'join(root,mutation.test)',
  'original.replace(mutation.before,mutation.after)',
]);
const ALLOWED_HELPER_LITERAL_RUNS = new Set([
  '/src/runtime/judge-coordinator',
  '/src/runtime/judge-recovery',
  '/src/runtime/judge-transport',
  '/src/runtime/writer-quiescer',
  '/src/store/event-secrets',
  '/test/helpers/loopback-seal-preload',
  'authorization_activation_id',
  'endpoint-host-drift-race',
  'judge_budget_reservations',
  'synthetic-boundary-value',
  'OUTPUT_TOKEN_LIMIT_EXCEEDED',
  'assertJudgeReservationStillInFlight',
  'authorizationActivationId',
  'e11-provider-match-authority',
  'e11-host-drift-before-byte',
  'e11-refusal-content-free',
  'e11-corpus-integrity-allowlist',
  'e11-response-fixture-pinning',
  'e11-corpus-manifest-pairing',
  'host-drift-write-fence-refusal',
  'judge-adversarial-mutants',
  'JudgeAdversarialMutation',
  'JUDGE_ADVERSARIAL_MUTATIONS',
  'JUDGE_ADVERSARIAL_MUTATION_TIMEOUT_MS',
  'STRICT_MUTATION_CHILD_TIMEOUT_MS',
  'StrictMutationChildResult',
  'runStrictMutationChild',
  'late-response-after-expiry',
  'packages/events-daemon/src/runtime/expiry',
  'packages/events-daemon/src/runtime/judge-adapters',
  'packages/events-daemon/src/runtime/judge-coordinator',
  'packages/events-daemon/src/runtime/judge-transport',
  'packages/events-daemon/test/fixtures/judges/case-manifest',
  'packages/events-daemon/test/judge-adversarial-corpus',
  'packages/events-daemon/test/judge-corpus-integrity',
  'provider-match-is-not-authority',
  'provider-match-low-score-refusal',
  'scripts/verify-events-adversarial-corpus',
  'scripts/verify-events-phase-e-tests',
  'test/helpers/loopback-seal-preload',
  'TYPESAFE_SYSTEM_ONE_ENDPOINT',
  'ObservedJudgeCoordinator',
  'displayNameContainsOtherAddress',
  'expectJudgeAdversarialMutationToFail',
  'expirySweepBeforeResponse',
  'inputTokensPerRolling30Days',
  'wrong-type-score-refusal',
  '--experimental-strip-types',
]);
const ALLOWED_DATA_LITERAL_RUNS = new Set([
  'INPUT_TOKEN_LIMIT_EXCEEDED',
  'adapter-reference-blocked',
  'endpoint-host-drift-race',
  'exact-input-control-unicode',
  'exact-input-envelope-injection',
  'host-drift-write-fence-refusal',
  'injection-envelope-forgery',
  'judge-adversarial-journal-v1',
  'judge-adversarial-manifest-v1',
  'late-response-after-expiry',
  'output-token-limit-exceeded',
  'oversize-response-refusal',
  'packages/events-daemon/test/fixtures/judges/adversarial-v1',
  'packages/events-daemon/test/support/judge-adversarial-fixture',
  'packages/events-daemon/test/support/judge-adversarial-mutants',
  'packages/events-daemon/test/support/short-temp',
  'packages/events-daemon/test/support/strict-mutation-child',
  'packages/events-daemon/test/support/writer-quiescer',
  'provider-match-is-not-authority',
  'provider-match-low-score-refusal',
  'response-after-hold-expiry',
  'userinfo-endpoint-refusal',
  'wrong-nan-infinite-range-score',
  'wrong-type-score-refusal',
]);
const ALLOWED_SOURCE_FILE_NAMES = new Set([
  'adversarial-v1.journal.json',
  'adversarial-v1.jsonl',
  'adversarial-v1.manifest.json',
  'capabilities.json',
  'case-manifest.json',
  'database.ts',
  'evaluate.ts',
  'event-secrets.ts',
  'expiry.ts',
  'holds.ts',
  'judge-adapters.ts',
  'judge-adversarial-corpus.test.ts',
  'judge-adversarial-fixture.ts',
  'judge-adversarial-mutants.ts',
  'judge-coordinator.ts',
  'judge-corpus-integrity.test.ts',
  'judge-recovery.ts',
  'judge-transport.ts',
  'judges.ts',
  'loopback-seal-preload.mjs',
  'package.json',
  'records.ts',
  'short-temp.ts',
  'strict-mutation-child.ts',
  'tsconfig.base.json',
  'tsconfig.json',
  'untrusted.ts',
  'verify-events-adversarial-corpus.mjs',
  'verify-events-phase-e-tests.mjs',
  'versions.ts',
  'writer-quiescer.ts',
]);
const ALLOWED_STRING_AWAITS = new Set([
  // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source text for the closed await allowlist.
  'awaitshortTempDir(`events-e11-${row.id.slice(0,12)}-`)',
  'awaitracingEvaluator.evaluate(admission)',
  'awaitfirstPromise',
  'awaitevaluator.admit(admission)',
  'awaitevaluator.evaluate(admission)',
  'awaitpending',
  'awaitmkdir(copiedPackage,{recursive:true})',
  "awaitreadFile(target,'utf8')",
]);
const ALLOWED_OBJECT_SPREADS = new Set([
  "...(judge.kind==='typesafe'?{endpoint:TYPESAFE_SYSTEM_ONE_ENDPOINT}:{})",
  '...TEST_EVENT',
  "...(row.scenario==='dns-rebinding'?{resolver:{asynclookup(){return['203.0.113.17'];},},}:{})",
  "...(row.scenario==='dns-rebinding'?{hostedApiKeyFor:async()=>'synthetic-boundary-value'}:{})",
  "...(row.scenario==='post-io-unknown'?{failpoint:(point)=>{if(point==='after-decision')thrownewError('syntheticpost-I/Ointerruption');},}:{})",
]);
const ALLOWED_ARRAY_SPREADS = new Set([
  '...expectedKinds',
  '...input.args',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source text for the closed spread allowlist.
  "...output.matchAll(newRegExp(`^#${label}(\\\\d+)$`,'gmu'))",
  '...result.output.matchAll(/^#Subtest:(.+)$/gmu)',
]);
const ALLOWED_PROPERTY_STRING_READS = new Set([
  'attempt.target',
  'coordinatorRefusal.reason',
  'coordinatorRefusal?.kind',
  'decision.id',
  'decision.metadata_state',
  'decision.outcome',
  'error.code',
  'error.message',
  'event.id',
  'event.type',
  'held?.hold_bound_by',
  'held?.outcome',
  'import.meta.dirname',
  'input.command',
  'input.cwd',
  'journal.destination',
  'judge.kind',
  'judge.provider',
  "pathToFileURL(join(root,'test/helpers/loopback-seal-preload.mjs')).href",
  'baseline.output',
  'mutation.after',
  'mutation.before',
  'mutation.id',
  'mutation.killingAssertion',
  'mutation.source',
  'mutation.test',
  'mutation.testName',
  'options.host',
  'process.execPath',
  'process.platform',
  'row.expected.metadataState',
  'row.expected.outcome',
  'row.expected.projection',
  'row.expected.reservation',
  'row.id',
  'rule.ruleId',
  'run.destination',
  'run.durableContent',
  'run.evaluationFailure',
  'run.metadataState',
  'run.outcome',
  'run.refusal',
  'run.reservation',
  'result.output',
  'result.kind',
  'reservation?.state',
  'row.expected.refusal',
  'row.response',
  'row.scenario',
  'row.subject',
  'store.installationId',
  'stored.document',
  'transportRefusal.code',
  'transportRefusal?.kind',
  'entry.pointer',
]);
const ALLOWED_COMPUTED_STRING_READS = new Set(['match[1]', 'matches[0]?.[1]']);
function mayProduceString(type, seen = new Set()) {
  if (type === undefined) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.StringLike)) !== 0) return true;
  if (type.isUnionType?.() || type.isIntersectionType?.())
    return type.getTypes().some((member) => mayProduceString(member, seen));
  return false;
}

function templateExpressions(node, source) {
  return (node.templateSpans ?? []).map((span) => span.expression.getText(source).replaceAll(/\s+/gu, ''));
}

function allowedComputedTemplate(node, source) {
  const compact = node.getText(source).replaceAll(/\s+/gu, '');
  const expressions = templateExpressions(node, source);
  if (/^`\$\{INJECTED_HOST\}:\$\{INJECTED_PORT\}`$/u.test(compact)) return true;
  if (
    /^`events-e11-\$\{row\.id\.slice\(0,12\)\}-`$/u.test(compact) ||
    /^`(?:judge-e11-|rule-e11-|target-e11-|reservation-e11-|decision-e11-|race-decision-e11-)\$\{(?:row\.id|\+\+ids)\}`$/u.test(
      compact,
    ) ||
    /^`judge-kind:\$\{judge\.kind\}`$/u.test(compact) ||
    /^`e11:\$\{row\.id\}`$/u.test(compact) ||
    /^`e11\$\{row\.id\.replaceAll\(\/\[\^a-z0-9\]\/giu,''\)\.padEnd\(29,'0'\)\.slice\(0,29\)\}`$/u.test(compact)
  )
    return true;
  if (/^`\$\{row\.id\}:[^$`]+`$/u.test(compact)) return true;
  if (
    compact.startsWith('`INSERTINTOactive_versions') &&
    compact.endsWith(';`') &&
    JSON.stringify(expressions) === JSON.stringify(['judge.kind', 'NOW', 'NOW', 'NOW', 'rule.ruleId'])
  )
    return true;
  return (
    /^`\^\$\{name\.replace\(.+\)\}\$`$/u.test(compact) ||
    /^`\^#\$\{label\}\(\\\\d\+\)\$`$/u.test(compact) ||
    /^`strictchildemittedoneTAP\$\{label\}summary\\n\$\{output\}`$/u.test(compact) ||
    /^`strictmutationchildtimedoutafter\$\{timeoutMs\}ms;itwaskilledbytherunner`$/u.test(compact) ||
    /^`\$\{mutation\.id\}:[^$`]*(?:\\n\$\{(?:result|baseline)\.output\})?`$/u.test(compact) ||
    /^`\^notok\\\\d\+-\$\{escaped\}\(\?:\\\\s\|\$\)`$/u.test(compact)
  );
}

function assertClosedComputedStrings(text, file, declaredHashes, sourcePath) {
  assert.equal(KNOWN_SECRET_MATERIAL.test(text), false, `${file}: fixture has no recognised secret-looking material`);
  assert.equal(
    PROVIDER_CAPTURE_TUPLE.test(text),
    false,
    `${file}: fixture has no captured provider-response shape (header tuple)`,
  );
  for (const comment of text.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu))
    assertSyntheticPlainText({
      text: comment[0],
      file: `${file}: TypeScript comment`,
      declaredHashes,
      sourceCode: false,
      allowedKeyRuns: ALLOWED_HELPER_LITERAL_RUNS,
      scanNetwork: false,
    });
  // TypeScript names files with forward slashes on every platform, while `resolve` gives Windows backslashes. Hand
  // TypeScript one spelling and match it case-insensitively where Windows does, or the in-memory text is never
  // served and TypeScript scans the file on disk instead of the text under test.
  const apiPath = sourcePath.replaceAll('\\', '/');
  const samePath = (candidate) => {
    const spelled = candidate.replaceAll('\\', '/');
    return process.platform === 'win32' ? spelled.toLowerCase() === apiPath.toLowerCase() : spelled === apiPath;
  };
  const api = new API({
    cwd: REPOSITORY_ROOT,
    fs: { readFile: (path) => (samePath(path) ? text : undefined) },
  });
  let snapshot;
  try {
    snapshot = api.updateSnapshot({ openFiles: [apiPath] });
    const project = snapshot.getDefaultProjectForFile(apiPath);
    assert.ok(project, `${file}: fixture helper has a TypeScript project for structural scanning`);
    const source = project.program.getSourceFile(apiPath);
    assert.ok(source, `${file}: fixture helper source parses for structural scanning`);
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(apiPath),
      [],
      `${file}: fixture helper has no syntax error that can evade structural scanning`,
    );
    const exactImportSpecifiers = (moduleName, importedName) =>
      source.statements.flatMap((statement) =>
        statement.kind === SyntaxKind.ImportDeclaration && statement.moduleSpecifier?.text === moduleName
          ? (statement.importClause?.namedBindings?.elements ?? []).filter(
              (element) =>
                element.name?.text === importedName &&
                (element.propertyName?.text ?? element.name?.text) === importedName,
            )
          : [],
      );
    const endpointImportSpecifiers = exactImportSpecifiers(TYPESAFE_ENDPOINT_MODULE, TYPESAFE_ENDPOINT_IDENTIFIER);
    const evaluatorImportSpecifiers = exactImportSpecifiers(EVENT_EVALUATOR_MODULE, EVENT_EVALUATOR_IDENTIFIER);
    const joinImportSpecifiers = exactImportSpecifiers('node:path', 'join');
    const readFileImportSpecifiers = exactImportSpecifiers('node:fs/promises', 'readFile');
    const mkdirImportSpecifiers = exactImportSpecifiers('node:fs/promises', 'mkdir');
    const shortTempDirImportSpecifiers = exactImportSpecifiers('./short-temp.ts', 'shortTempDir');
    const defaultImportSpecifiers = source.statements.flatMap((statement) =>
      statement.kind === SyntaxKind.ImportDeclaration &&
      statement.importClause?.name !== undefined &&
      statement.importClause.isTypeOnly !== true
        ? [statement.importClause.name]
        : [],
    );
    const defaultImportSymbols = new Set(
      defaultImportSpecifiers.map((specifier) => project.checker.getSymbolAtLocation(specifier)).filter(Boolean),
    );
    const hasAncestorKind = (candidate, kind) => {
      for (let parent = candidate.parent; parent !== undefined; parent = parent.parent)
        if (parent.kind === kind) return true;
      return false;
    };
    const resolvesToDefaultImport = (candidate, seen = new Set()) => {
      const value = unwrapExpression(candidate);
      if (value?.kind !== SyntaxKind.Identifier) return false;
      const symbol = project.checker.getSymbolAtLocation(value);
      if (symbol === undefined || seen.has(symbol)) return false;
      if (defaultImportSymbols.has(symbol)) return true;
      seen.add(symbol);
      return (symbol.declarations ?? []).some(
        (declaration) =>
          declaration.kind === SyntaxKind.VariableDeclaration &&
          declaration.initializer !== undefined &&
          resolvesToDefaultImport(declaration.initializer, seen),
      );
    };
    assert.ok(endpointImportSpecifiers.length <= 1, `${file}: the production TypeSafe endpoint import is unique`);
    assert.ok(evaluatorImportSpecifiers.length <= 1, `${file}: the production evaluator import is unique`);
    const importedEndpointSymbol = endpointImportSpecifiers[0]
      ? project.checker.getSymbolAtLocation(endpointImportSpecifiers[0].name)
      : undefined;
    const importedEvaluatorSymbol = evaluatorImportSpecifiers[0]
      ? project.checker.getSymbolAtLocation(evaluatorImportSpecifiers[0].name)
      : undefined;
    const importedJoinSymbol = joinImportSpecifiers[0]
      ? project.checker.getSymbolAtLocation(joinImportSpecifiers[0].name)
      : undefined;
    const importedReadFileSymbol = readFileImportSpecifiers[0]
      ? project.checker.getSymbolAtLocation(readFileImportSpecifiers[0].name)
      : undefined;
    const importedMkdirSymbol = mkdirImportSpecifiers[0]
      ? project.checker.getSymbolAtLocation(mkdirImportSpecifiers[0].name)
      : undefined;
    const importedShortTempDirSymbol = shortTempDirImportSpecifiers[0]
      ? project.checker.getSymbolAtLocation(shortTempDirImportSpecifiers[0].name)
      : undefined;
    for (const statement of source.statements)
      if (
        statement.kind === SyntaxKind.ImportDeclaration &&
        ['node:process', 'process'].includes(statement.moduleSpecifier?.text)
      )
        assert.fail(`${file}: TypeScript adversarial helpers must not read process.env`);
    for (const statement of source.statements) {
      if (statement.kind !== SyntaxKind.ImportDeclaration) continue;
      const clause = statement.importClause;
      for (const element of clause?.namedBindings?.elements ?? [])
        if (element.propertyName !== undefined && element.propertyName.text !== element.name.text)
          assert.fail(`${file}: imported aliases may carry a URL`);
    }
    const isImportedEndpointIdentifier = (node) =>
      node?.kind === SyntaxKind.Identifier &&
      node.text === TYPESAFE_ENDPOINT_IDENTIFIER &&
      importedEndpointSymbol !== undefined &&
      project.checker.getSymbolAtLocation(node) === importedEndpointSymbol;
    const unwrapExpression = (node) => {
      let current = node;
      while (
        current !== undefined &&
        [
          SyntaxKind.ParenthesizedExpression,
          SyntaxKind.AsExpression,
          SyntaxKind.TypeAssertionExpression,
          SyntaxKind.NonNullExpression,
          SyntaxKind.SatisfiesExpression,
        ].includes(current.kind)
      )
        current = current.expression;
      return current;
    };
    const defaultConstructorNames = new Set(defaultImportSpecifiers.map((specifier) => specifier.text));
    let addedConstructorAlias = true;
    while (addedConstructorAlias) {
      addedConstructorAlias = false;
      const collectConstructorAliases = (candidate) => {
        if (
          candidate.kind === SyntaxKind.VariableDeclaration &&
          candidate.name?.kind === SyntaxKind.Identifier &&
          unwrapExpression(candidate.initializer)?.kind === SyntaxKind.Identifier &&
          defaultConstructorNames.has(unwrapExpression(candidate.initializer).text) &&
          !defaultConstructorNames.has(candidate.name.text)
        ) {
          defaultConstructorNames.add(candidate.name.text);
          addedConstructorAlias = true;
        }
        candidate.forEachChild(collectConstructorAliases);
      };
      collectConstructorAliases(source);
    }
    const staticString = (node) => {
      const value = unwrapExpression(node);
      return [SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral].includes(value?.kind)
        ? value.text
        : undefined;
    };
    const outerExpression = (node) => {
      let current = node;
      while (
        [
          SyntaxKind.ParenthesizedExpression,
          SyntaxKind.AsExpression,
          SyntaxKind.TypeAssertionExpression,
          SyntaxKind.NonNullExpression,
          SyntaxKind.SatisfiesExpression,
        ].includes(current.parent?.kind)
      )
        current = current.parent;
      return current;
    };
    const allowedUrlPart = (node) => {
      if (node === undefined) return false;
      if (isImportedEndpointIdentifier(node)) return true;
      if (node.kind !== SyntaxKind.StringLiteral && node.kind !== SyntaxKind.NoSubstitutionTemplateLiteral)
        return false;
      try {
        const parsed = new URL(node.text);
        return ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname.length > 0;
      } catch {
        return false;
      }
    };
    const assertLiteralUrlSource = (node) =>
      assert.equal(
        allowedUrlPart(node),
        true,
        `${file}: a URL must be a complete string literal or the imported ${TYPESAFE_ENDPOINT_IDENTIFIER}`,
      );
    const propertyName = (node) => {
      if (node === undefined) return undefined;
      if (
        node.kind === SyntaxKind.Identifier ||
        node.kind === SyntaxKind.StringLiteral ||
        node.kind === SyntaxKind.NoSubstitutionTemplateLiteral
      )
        return node.text;
      if (node.kind === SyntaxKind.ComputedPropertyName) return staticString(node.expression);
      return undefined;
    };
    const assignedPropertyName = (node) => {
      if (node?.kind === SyntaxKind.PropertyAccessExpression) return node.name?.text;
      if (node?.kind === SyntaxKind.ElementAccessExpression) return staticString(node.argumentExpression);
      return undefined;
    };
    const assertSafePropertyName = (name, node) => {
      const exactEncryptionKeyDescriptor =
        name === 'key' &&
        node?.kind === SyntaxKind.PropertyAssignment &&
        node.getText(source).replaceAll(/\s+/gu, '') === "key:[{type:'text',value:decision.id}]";
      assert.equal(
        CREDENTIAL_FIELD.test(name ?? '') && !exactEncryptionKeyDescriptor,
        false,
        `${file}: fixture has no credential assignment`,
      );
      assert.equal(
        PROVIDER_CAPTURE_NAME.test(name ?? ''),
        false,
        `${file}: fixture has no captured provider-response shape`,
      );
    };
    const variableDeclaration = (identifier) => {
      const symbol = project.checker.getSymbolAtLocation(identifier);
      if (symbol === undefined) return undefined;
      const declarations = [];
      const collect = (candidate) => {
        if (
          candidate.kind === SyntaxKind.VariableDeclaration &&
          candidate.name?.kind === SyntaxKind.Identifier &&
          project.checker.getSymbolAtLocation(candidate.name) === symbol
        )
          declarations.push(candidate);
        candidate.forEachChild(collect);
      };
      collect(source);
      return declarations.length === 1 ? declarations[0] : undefined;
    };
    const variableInitializer = (identifier) => variableDeclaration(identifier)?.initializer;
    const symbolHasWrite = (symbol, protectedProperties = new Set()) => {
      let written = false;
      const inspect = (candidate) => {
        if (written) return;
        if (
          candidate.kind === SyntaxKind.BinaryExpression &&
          ASSIGNMENT_OPERATORS.has(candidate.operatorToken.getText(source))
        ) {
          const left = unwrapExpression(candidate.left);
          if (left?.kind === SyntaxKind.Identifier && project.checker.getSymbolAtLocation(left) === symbol)
            written = true;
          if (left?.kind === SyntaxKind.PropertyAccessExpression || left?.kind === SyntaxKind.ElementAccessExpression) {
            let receiver = unwrapExpression(left.expression);
            while (
              receiver?.kind === SyntaxKind.PropertyAccessExpression ||
              receiver?.kind === SyntaxKind.ElementAccessExpression
            )
              receiver = unwrapExpression(receiver.expression);
            if (
              project.checker.getSymbolAtLocation(receiver) === symbol &&
              (protectedProperties.size === 0 || protectedProperties.has(assignedPropertyName(left)))
            )
              written = true;
          }
        }
        if (
          candidate.kind === SyntaxKind.VariableDeclaration &&
          unwrapExpression(candidate.initializer)?.kind === SyntaxKind.Identifier &&
          project.checker.getSymbolAtLocation(unwrapExpression(candidate.initializer)) === symbol &&
          project.checker.getSymbolAtLocation(candidate.name) !== symbol
        ) {
          written = true;
        }
        candidate.forEachChild(inspect);
      };
      inspect(source);
      return written;
    };
    const isConstAndUnwritten = (identifier, protectedProperties = new Set()) => {
      const declaration = variableDeclaration(identifier);
      const symbol = project.checker.getSymbolAtLocation(identifier);
      return (
        declaration !== undefined &&
        symbol !== undefined &&
        (declaration.parent?.flags & NodeFlags.Const) !== 0 &&
        !symbolHasWrite(symbol, protectedProperties)
      );
    };
    const isProductionEvaluatorInitializer = (initializer) => {
      const value = unwrapExpression(initializer);
      if (
        value?.kind === SyntaxKind.NewExpression &&
        unwrapExpression(value.expression)?.kind === SyntaxKind.Identifier &&
        project.checker.getSymbolAtLocation(unwrapExpression(value.expression)) === importedEvaluatorSymbol
      )
        return true;
      if (value?.kind !== SyntaxKind.ConditionalExpression) return false;
      return (
        isProductionEvaluatorInitializer(value.whenTrue) &&
        value.whenFalse?.kind === SyntaxKind.Identifier &&
        value.whenFalse.text === 'undefined'
      );
    };
    const isProductionEvaluator = (identifier) => {
      if (identifier?.kind !== SyntaxKind.Identifier || importedEvaluatorSymbol === undefined) return false;
      return (
        isConstAndUnwritten(identifier, new Set(['admit', 'evaluate'])) &&
        isProductionEvaluatorInitializer(variableInitializer(identifier))
      );
    };
    const allowedStringAwait = (node) => {
      const compact = node.getText(source).replaceAll(/\s+/gu, '');
      if (!ALLOWED_STRING_AWAITS.has(compact)) return false;
      const awaitedCall = unwrapExpression(node.expression);
      const awaitedCallee = unwrapExpression(awaitedCall?.expression);
      const importedAwaitSymbols = new Map([
        ['shortTempDir', importedShortTempDirSymbol],
        ['mkdir', importedMkdirSymbol],
        ['readFile', importedReadFileSymbol],
      ]);
      if (awaitedCall?.kind === SyntaxKind.CallExpression && awaitedCallee?.kind === SyntaxKind.Identifier) {
        const requiredSymbol = importedAwaitSymbols.get(awaitedCallee.text);
        if (requiredSymbol !== undefined) return project.checker.getSymbolAtLocation(awaitedCallee) === requiredSymbol;
      }
      if (['awaitevaluator.admit(admission)', 'awaitevaluator.evaluate(admission)'].includes(compact))
        return isProductionEvaluator(node.expression.expression.expression);
      if (compact === 'awaitracingEvaluator.evaluate(admission)')
        return isProductionEvaluator(node.expression.expression.expression);
      if (!['awaitpending', 'awaitfirstPromise'].includes(compact)) return true;
      const initializer = variableInitializer(node.expression);
      return (
        initializer?.kind === SyntaxKind.CallExpression &&
        initializer.expression?.kind === SyntaxKind.PropertyAccessExpression &&
        initializer.expression.name?.text === 'admit' &&
        isProductionEvaluator(initializer.expression.expression)
      );
    };
    const isPlainFrozenValue = (node, seen = new Set()) => {
      if (node === undefined || seen.has(node)) return false;
      seen.add(node);
      if (
        [
          SyntaxKind.StringLiteral,
          SyntaxKind.NoSubstitutionTemplateLiteral,
          SyntaxKind.NumericLiteral,
          SyntaxKind.TrueKeyword,
          SyntaxKind.FalseKeyword,
          SyntaxKind.NullKeyword,
        ].includes(node.kind)
      )
        return true;
      if (
        [SyntaxKind.AsExpression, SyntaxKind.SatisfiesExpression, SyntaxKind.ParenthesizedExpression].includes(
          node.kind,
        )
      )
        return isPlainFrozenValue(node.expression, seen);
      if (node.kind === SyntaxKind.ArrayLiteralExpression)
        return node.elements.every((element) => isPlainFrozenValue(element, seen));
      if (node.kind === SyntaxKind.ObjectLiteralExpression)
        return node.properties.every(
          (property) =>
            property.kind === SyntaxKind.PropertyAssignment &&
            propertyName(property.name) !== undefined &&
            isPlainFrozenValue(property.initializer, seen),
        );
      if (node.kind === SyntaxKind.Identifier)
        return isConstAndUnwritten(node) && isPlainFrozenValue(variableInitializer(node), seen);
      return false;
    };
    const allowedObjectSpread = (node) => {
      const compact = node.getText(source).replaceAll(/\s+/gu, '');
      if (!ALLOWED_OBJECT_SPREADS.has(compact)) return false;
      if (compact !== '...TEST_EVENT') return true;
      const initializer = variableInitializer(node.expression);
      if (
        initializer?.kind !== SyntaxKind.CallExpression ||
        initializer.expression?.getText(source) !== 'Object.freeze'
      )
        return false;
      const symbol = project.checker.getSymbolAtLocation(initializer.expression);
      return (
        symbol?.declarations?.some((declaration) => declaration.path?.replaceAll('\\', '/').includes('/lib/lib.es')) ===
          true &&
        initializer.arguments?.length === 1 &&
        initializer.arguments[0]?.kind === SyntaxKind.ObjectLiteralExpression &&
        isPlainFrozenValue(initializer.arguments[0])
      );
    };
    const enclosingFunction = (node) => {
      for (let current = node.parent; current !== undefined; current = current.parent)
        if (current.kind === SyntaxKind.FunctionDeclaration) return current;
      return undefined;
    };
    const dnsSelectionForHostedDeclaration = (hostedDeclaration) => {
      if (hostedDeclaration?.kind !== SyntaxKind.VariableDeclaration) return undefined;
      const owner = enclosingFunction(hostedDeclaration);
      const hostedSymbol = project.checker.getSymbolAtLocation(hostedDeclaration.name);
      if (owner?.name?.text !== 'runAdversarialCase' || hostedSymbol === undefined) return undefined;
      const selections = [];
      const hostedReferences = [];
      const inspect = (candidate) => {
        if (candidate.kind === SyntaxKind.Identifier && project.checker.getSymbolAtLocation(candidate) === hostedSymbol)
          hostedReferences.push(candidate);
        if (
          candidate.kind === SyntaxKind.VariableDeclaration &&
          candidate.name?.kind === SyntaxKind.Identifier &&
          candidate.name.text === 'judge' &&
          unwrapExpression(candidate.initializer)?.kind === SyntaxKind.ConditionalExpression
        ) {
          const conditional = unwrapExpression(candidate.initializer);
          const scenarioAccess = unwrapExpression(conditional.condition?.left);
          const rowIdentifier = unwrapExpression(scenarioAccess?.expression);
          const rowSymbol = project.checker.getSymbolAtLocation(rowIdentifier);
          const rowParameter = owner.parameters?.find(
            (parameter) => parameter.name?.kind === SyntaxKind.Identifier && parameter.name.text === 'row',
          );
          const rowIsCorpusParameter =
            scenarioAccess?.kind === SyntaxKind.PropertyAccessExpression &&
            scenarioAccess.name?.text === 'scenario' &&
            rowIdentifier?.kind === SyntaxKind.Identifier &&
            rowIdentifier.text === 'row' &&
            rowParameter !== undefined &&
            project.checker.getSymbolAtLocation(rowParameter.name) === rowSymbol &&
            rowParameter.type?.getText(source) === 'AdversarialCorpusCase' &&
            !symbolHasWrite(rowSymbol, new Set(['scenario']));
          if (
            conditional.condition?.getText(source).replaceAll(/\s+/gu, '') === "row.scenario==='dns-rebinding'" &&
            rowIsCorpusParameter &&
            conditional.whenTrue?.kind === SyntaxKind.Identifier &&
            project.checker.getSymbolAtLocation(conditional.whenTrue) === hostedSymbol &&
            conditional.whenFalse?.kind === SyntaxKind.Identifier &&
            conditional.whenFalse.text === 'localJudge'
          )
            selections.push(candidate);
        }
        candidate.forEachChild(inspect);
      };
      inspect(owner);
      if (selections.length !== 1 || hostedReferences.length !== 2) return undefined;
      const selectedJudgeSymbol = project.checker.getSymbolAtLocation(selections[0].name);
      if (selectedJudgeSymbol === undefined || symbolHasWrite(selectedJudgeSymbol, new Set(['kind']))) return undefined;
      return selections[0];
    };
    const dnsSelectionForJudgeIdentifier = (identifier) => {
      const declaration = variableDeclaration(identifier);
      const conditional = unwrapExpression(declaration?.initializer);
      if (
        declaration?.name?.kind !== SyntaxKind.Identifier ||
        declaration.name.text !== 'judge' ||
        conditional?.kind !== SyntaxKind.ConditionalExpression ||
        conditional.condition?.getText(source).replaceAll(/\s+/gu, '') !== "row.scenario==='dns-rebinding'" ||
        conditional.whenTrue?.kind !== SyntaxKind.Identifier
      )
        return undefined;
      const hostedDeclaration = variableDeclaration(conditional.whenTrue);
      return dnsSelectionForHostedDeclaration(hostedDeclaration) === declaration ? declaration : undefined;
    };
    const approvedTypeSafeEndpointUse = (node) => {
      if (!isImportedEndpointIdentifier(node) || node.parent?.kind !== SyntaxKind.PropertyAssignment) return false;
      if (propertyName(node.parent.name) !== 'endpoint' || node.parent.initializer !== node) return false;
      const objectLiteral = node.parent.parent;
      if (objectLiteral?.kind !== SyntaxKind.ObjectLiteralExpression) return false;
      if (
        objectLiteral.parent?.kind === SyntaxKind.VariableDeclaration &&
        objectLiteral.parent.name?.kind === SyntaxKind.Identifier &&
        objectLiteral.parent.name.text === 'hostedJudge'
      )
        return dnsSelectionForHostedDeclaration(objectLiteral.parent) !== undefined;
      const conditional = objectLiteral.parent;
      const parenthesized = conditional?.parent;
      return (
        conditional?.kind === SyntaxKind.ConditionalExpression &&
        conditional.condition?.kind === SyntaxKind.BinaryExpression &&
        conditional.condition.left?.kind === SyntaxKind.PropertyAccessExpression &&
        conditional.condition.left.name?.text === 'kind' &&
        dnsSelectionForJudgeIdentifier(conditional.condition.left.expression) !== undefined &&
        parenthesized?.kind === SyntaxKind.ParenthesizedExpression &&
        parenthesized.parent?.kind === SyntaxKind.SpreadAssignment &&
        allowedObjectSpread(parenthesized.parent)
      );
    };
    const allowsHelperLoopback = (node) => {
      if (
        node.text === '127.0.0.1' &&
        node.parent?.kind === SyntaxKind.VariableDeclaration &&
        node.parent.name?.getText(source) === 'INJECTED_HOST'
      )
        return true;
      if (!['http://127.0.0.1:49152/v1/systemone', 'http://synthetic@127.0.0.1:49152/v1/systemone'].includes(node.text))
        return false;
      if (node.parent?.kind === SyntaxKind.PropertyAssignment)
        return propertyName(node.parent.name) === 'endpoint' && node.parent.initializer === node;
      return (
        node.parent?.kind === SyntaxKind.BinaryExpression &&
        node.parent.operatorToken.kind === SyntaxKind.EqualsToken &&
        assignedPropertyName(node.parent.left) === 'endpoint' &&
        node.parent.right === node
      );
    };
    const isUrlConstructor = (node) => {
      const expression = unwrapExpression(node);
      if (expression?.kind === SyntaxKind.Identifier) return expression.text === 'URL';
      if (expression?.kind === SyntaxKind.PropertyAccessExpression) return expression.name?.text === 'URL';
      if (expression?.kind === SyntaxKind.ElementAccessExpression)
        return staticString(expression.argumentExpression) === 'URL';
      return false;
    };
    const isFetchCallee = (node) => {
      const expression = unwrapExpression(node);
      if (expression?.kind === SyntaxKind.Identifier) return expression.text === 'fetch';
      if (expression?.kind === SyntaxKind.PropertyAccessExpression) return expression.name?.text === 'fetch';
      if (expression?.kind === SyntaxKind.ElementAccessExpression)
        return staticString(expression.argumentExpression) === 'fetch';
      return false;
    };
    const assertReflectivePropertyWrite = (node) => {
      const callee = node.expression?.getText(source).replaceAll(/\s+/gu, '');
      if (!['Reflect.set', 'Object.defineProperty'].includes(callee)) return;
      const name = staticString(node.arguments?.[1]);
      assert.notEqual(name, undefined, `${file}: fixture has no unresolved computed property name`);
      assertSafePropertyName(name, node);
      if (!/^(?:address|destination|endpoint|host|hostname|url)$/iu.test(name ?? '')) return;
      if (callee === 'Reflect.set') {
        assertLiteralUrlSource(node.arguments?.[2]);
        return;
      }
      const descriptor = unwrapExpression(node.arguments?.[2]);
      const valueProperty = descriptor?.properties?.find(
        (property) => property.kind === SyntaxKind.PropertyAssignment && propertyName(property.name) === 'value',
      );
      assertLiteralUrlSource(valueProperty?.initializer);
    };
    const literalIsHandledPropertyName = (node) => {
      const outer = outerExpression(node);
      if (outer.parent?.kind === SyntaxKind.ComputedPropertyName) return true;
      if (
        [
          SyntaxKind.PropertyAssignment,
          SyntaxKind.PropertyDeclaration,
          SyntaxKind.GetAccessor,
          SyntaxKind.SetAccessor,
          SyntaxKind.MethodDeclaration,
        ].includes(outer.parent?.kind) &&
        outer.parent.name === outer
      )
        return true;
      if (outer.parent?.kind === SyntaxKind.ElementAccessExpression && outer.parent.argumentExpression === outer)
        return (
          outer.parent.parent?.kind === SyntaxKind.BinaryExpression &&
          ASSIGNMENT_OPERATORS.has(outer.parent.parent.operatorToken.getText(source)) &&
          outer.parent.parent.left === outer.parent
        );
      if (outer.parent?.kind === SyntaxKind.CallExpression) {
        const callee = outer.parent.expression?.getText(source).replaceAll(/\s+/gu, '');
        return ['Reflect.set', 'Object.defineProperty'].includes(callee) && outer.parent.arguments?.[1] === outer;
      }
      return false;
    };
    const visit = (node) => {
      const templatePart =
        node.kind === SyntaxKind.TemplateHead ||
        node.kind === SyntaxKind.TemplateMiddle ||
        node.kind === SyntaxKind.TemplateTail;
      if (
        node.kind === SyntaxKind.StringLiteral ||
        node.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
        node.kind === SyntaxKind.RegularExpressionLiteral ||
        templatePart
      )
        assertSyntheticPlainText({
          text: node.text,
          file: `${file}: decoded TypeScript literal`,
          declaredHashes,
          sourceCode: false,
          completeValue: !templatePart,
          checkKeyRuns: true,
          allowedKeyRuns: ALLOWED_HELPER_LITERAL_RUNS,
          allowLoopback: allowsHelperLoopback(node),
        });
      if (
        [SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral].includes(node.kind) &&
        !literalIsHandledPropertyName(node)
      ) {
        if (['node:process', 'process'].includes(node.text))
          assert.fail(`${file}: TypeScript adversarial helpers must not read process.env`);
        assertSafePropertyName(node.text, node);
        if (/^(?:endpoint|url)$/iu.test(node.text)) assertLiteralUrlSource(undefined);
      }
      if (
        [SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral].includes(node.kind) &&
        ['process', 'env'].includes(node.text) &&
        node.parent?.kind === SyntaxKind.ElementAccessExpression &&
        node.parent.argumentExpression === node
      )
        assert.fail(`${file}: TypeScript adversarial helpers must not read process.env`);
      if (
        node.kind === SyntaxKind.ElementAccessExpression &&
        ['process', 'env'].includes(staticString(node.argumentExpression))
      )
        assert.fail(`${file}: TypeScript adversarial helpers must not read process.env`);
      if (node.kind === SyntaxKind.Identifier && node.text === 'process')
        assert.equal(
          node.parent?.kind === SyntaxKind.PropertyAccessExpression &&
            node.parent.expression === node &&
            ['execPath', 'platform'].includes(node.parent.name?.text) &&
            ['process.execPath', 'process.platform'].includes(node.parent.getText(source)),
          true,
          `${file}: TypeScript adversarial helpers must not read process.env`,
        );
      if (node.kind === SyntaxKind.Identifier && node.text === 'URL')
        assert.fail(`${file}: a URL must be a complete string literal or the imported ${TYPESAFE_ENDPOINT_IDENTIFIER}`);
      if (
        node.kind === SyntaxKind.Identifier &&
        ['fetch', 'http', 'https'].includes(node.text) &&
        !(node.text === 'fetch' && node.parent?.kind === SyntaxKind.CallExpression && node.parent.expression === node)
      )
        assert.fail(`${file}: a URL must be a complete string literal or the imported ${TYPESAFE_ENDPOINT_IDENTIFIER}`);
      if (
        (node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.PrivateIdentifier) &&
        (KNOWN_SECRET_MATERIAL.test(node.text) || KEY_LIKE_IDENTIFIER.test(node.text))
      )
        assertSyntheticPlainText({
          text: node.text,
          file: `${file}: TypeScript identifier ${node.text}`,
          declaredHashes,
          sourceCode: false,
          allowedKeyRuns: ALLOWED_HELPER_LITERAL_RUNS,
          scanNetwork: false,
        });
      if (
        node.kind === SyntaxKind.Identifier &&
        node.text === TYPESAFE_ENDPOINT_IDENTIFIER &&
        node !== endpointImportSpecifiers[0]?.name
      )
        assert.equal(
          approvedTypeSafeEndpointUse(node),
          true,
          `${file}: the production TypeSafe endpoint may be used only by the DNS-rebinding fixture shape (${node.parent?.getText(source)})`,
        );
      if (node.kind === SyntaxKind.TemplateExpression)
        assert.equal(
          allowedComputedTemplate(node, source),
          true,
          `${file}: computed fixture strings must use the closed computed-string allowlist`,
        );
      if (node.kind === SyntaxKind.AwaitExpression) {
        const type = project.checker.getTypeAtLocation(node);
        if (mayProduceString(type))
          assert.equal(
            allowedStringAwait(node),
            true,
            `${file}: computed fixture strings must use the closed computed-string allowlist`,
          );
      }
      if (node.kind === SyntaxKind.SpreadAssignment)
        assert.equal(
          allowedObjectSpread(node),
          true,
          `${file}: computed fixture strings must use the closed computed-string allowlist`,
        );
      if (node.kind === SyntaxKind.SpreadElement) {
        const compact = node.getText(source).replaceAll(/\s+/gu, '');
        assert.equal(
          ALLOWED_ARRAY_SPREADS.has(compact),
          true,
          `${file}: array spreads may carry a URL and must use the closed allowlist (${compact})`,
        );
      }
      if (node.kind === SyntaxKind.CallExpression) {
        if (
          node.expression?.kind === SyntaxKind.ImportKeyword &&
          ['node:process', 'process'].includes(staticString(node.arguments?.[0]))
        )
          assert.fail(`${file}: TypeScript adversarial helpers must not read process.env`);
        if (isFetchCallee(node.expression)) assertLiteralUrlSource(node.arguments?.[0]);
        if (isUrlConstructor(node.expression))
          assert.fail(
            `${file}: a URL must be a complete string literal or the imported ${TYPESAFE_ENDPOINT_IDENTIFIER}`,
          );
        assertReflectivePropertyWrite(node);
        const type = project.checker.getTypeAtLocation(node);
        if (mayProduceString(type)) {
          const callText = node.getText(source);
          const compact = callText.replaceAll(/\s+/gu, '');
          assert.equal(
            ALLOWED_STRING_CALLS.has(compact),
            true,
            `${file}: computed fixture strings must use the closed computed-string allowlist`,
          );
          if (compact.startsWith('join('))
            assert.equal(
              importedJoinSymbol !== undefined &&
                project.checker.getSymbolAtLocation(unwrapExpression(node.expression)) === importedJoinSymbol,
              true,
              `${file}: allowed path construction must use the imported node:path join`,
            );
          if (compact === 'exactTestName(mutation.testName)') {
            const symbol = project.checker.getSymbolAtLocation(unwrapExpression(node.expression));
            const declaration = source.statements.find(
              (statement) =>
                statement.kind === SyntaxKind.FunctionDeclaration && statement.name?.text === 'exactTestName',
            );
            const returns = declaration?.body?.statements?.filter(
              (statement) => statement.kind === SyntaxKind.ReturnStatement,
            );
            assert.equal(
              declaration?.kind === SyntaxKind.FunctionDeclaration &&
                project.checker.getSymbolAtLocation(declaration.name) === symbol &&
                returns?.length === 1 &&
                returns[0]?.expression?.kind === SyntaxKind.TemplateExpression,
              true,
              `${file}: allowed exact test-name construction must use the declared exactTestName helper`,
            );
          }
          if (compact.startsWith('JSON.') || compact.startsWith('String(')) {
            const symbol = project.checker.getSymbolAtLocation(node.expression);
            assert.equal(
              symbol?.declarations?.some((declaration) =>
                declaration.path.replaceAll('\\', '/').includes('/lib/lib.es'),
              ),
              true,
              `${file}: allowed global string calls resolve to the standard library instead of a shadow`,
            );
          }
        }
      }
      if (node.kind === SyntaxKind.NewExpression && isUrlConstructor(node.expression))
        assert.fail(`${file}: a URL must be a complete string literal or the imported ${TYPESAFE_ENDPOINT_IDENTIFIER}`);
      if (
        node.kind === SyntaxKind.NewExpression &&
        (resolvesToDefaultImport(node.expression) ||
          (unwrapExpression(node.expression)?.kind === SyntaxKind.Identifier &&
            defaultConstructorNames.has(unwrapExpression(node.expression).text)))
      )
        assert.fail(`${file}: default-imported constructors may carry a URL`);
      if (node.kind === SyntaxKind.TaggedTemplateExpression) {
        const type = project.checker.getTypeAtLocation(node);
        assert.equal(
          mayProduceString(type),
          false,
          `${file}: computed fixture strings must use the closed computed-string allowlist`,
        );
      }
      if (node.kind === SyntaxKind.BinaryExpression && node.operatorToken.kind === SyntaxKind.PlusToken) {
        const type = project.checker.getTypeAtLocation(node);
        assert.equal(
          mayProduceString(type),
          false,
          `${file}: computed fixture strings must use the closed computed-string allowlist`,
        );
      }
      if (node.kind === SyntaxKind.PropertyAssignment) {
        if (node.name?.kind === SyntaxKind.ComputedPropertyName && staticString(node.name.expression) === undefined)
          assert.fail(`${file}: fixture has no unresolved computed property name`);
        const name = propertyName(node.name);
        assertSafePropertyName(name, node);
        if (/^(?:endpoint|url)$/iu.test(name ?? '')) assertLiteralUrlSource(node.initializer);
      }
      if (node.kind === SyntaxKind.PropertyDeclaration) {
        if (node.name?.kind === SyntaxKind.ComputedPropertyName && staticString(node.name.expression) === undefined)
          assert.fail(`${file}: fixture has no unresolved computed property name`);
        const name = propertyName(node.name);
        assertSafePropertyName(name, node);
        if (/^(?:endpoint|url)$/iu.test(name ?? '')) assertLiteralUrlSource(node.initializer);
      }
      if (node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor) {
        if (node.name?.kind === SyntaxKind.ComputedPropertyName && staticString(node.name.expression) === undefined)
          assert.fail(`${file}: fixture has no unresolved computed property name`);
        const name = propertyName(node.name);
        assertSafePropertyName(name, node);
        if (/^(?:endpoint|url)$/iu.test(name ?? '')) assertLiteralUrlSource(undefined);
      }
      if (node.kind === SyntaxKind.MethodDeclaration) {
        if (node.name?.kind === SyntaxKind.ComputedPropertyName && staticString(node.name.expression) === undefined)
          assert.fail(`${file}: fixture has no unresolved computed property name`);
        const name = propertyName(node.name);
        assertSafePropertyName(name, node);
        if (/^(?:endpoint|url)$/iu.test(name ?? '')) assertLiteralUrlSource(undefined);
      }
      if (node.kind === SyntaxKind.EnumMember) {
        const name = propertyName(node.name);
        assertSafePropertyName(name, node);
        if (/^(?:endpoint|url)$/iu.test(name ?? '')) assertLiteralUrlSource(undefined);
      }
      if (node.kind === SyntaxKind.ShorthandPropertyAssignment) {
        const name = propertyName(node.name);
        assertSafePropertyName(name, node);
        if (/^(?:endpoint|url)$/iu.test(name ?? '')) assertLiteralUrlSource(undefined);
      }
      if (node.kind === SyntaxKind.BinaryExpression && ASSIGNMENT_OPERATORS.has(node.operatorToken.getText(source))) {
        const name = assignedPropertyName(node.left);
        assertSafePropertyName(name, node);
        if (/^(?:endpoint|url)$/iu.test(name ?? ''))
          assertLiteralUrlSource(node.operatorToken.kind === SyntaxKind.EqualsToken ? node.right : undefined);
      }
      if (node.kind === SyntaxKind.VariableDeclaration) {
        const name = node.name?.kind === SyntaxKind.Identifier ? node.name.text : undefined;
        assertSafePropertyName(name, node);
        if (/^(?:endpoint|url)$/iu.test(name ?? '')) assertLiteralUrlSource(node.initializer);
      }
      if (node.kind === SyntaxKind.Parameter) {
        const name = propertyName(node.name);
        assertSafePropertyName(name, node);
        if (/^(?:endpoint|url)$/iu.test(name ?? '')) assertLiteralUrlSource(undefined);
      }
      if (node.kind === SyntaxKind.BindingElement) {
        const property = propertyName(node.propertyName);
        const name = propertyName(node.name);
        if (['process', 'env'].includes(property) || ['process', 'env'].includes(name))
          assert.fail(`${file}: TypeScript adversarial helpers must not read process.env`);
        assertSafePropertyName(property, node);
        assertSafePropertyName(name, node);
        if (/^(?:endpoint|url)$/iu.test(property ?? '') || /^(?:endpoint|url)$/iu.test(name ?? ''))
          assertLiteralUrlSource(undefined);
      }
      node.forEachChild(visit);
    };
    visit(source);
    const unsafePropertyReads = [];
    const unsafeComputedReads = [];
    const visitUrlCarriers = (node) => {
      const assignmentLeft =
        node.parent?.kind === SyntaxKind.BinaryExpression &&
        ASSIGNMENT_OPERATORS.has(node.parent.operatorToken.getText(source)) &&
        unwrapExpression(node.parent.left) === node;
      const propertyText = node.getText(source).replaceAll(/\s+/gu, '');
      const normalizedPropertyText =
        node.kind === SyntaxKind.PropertyAccessExpression
          ? `${unwrapExpression(node.expression)?.getText(source).replaceAll(/\s+/gu, '')}.${node.name.text}`
          : propertyText;
      if (
        node.kind === SyntaxKind.PropertyAccessExpression &&
        !assignmentLeft &&
        !hasAncestorKind(node, SyntaxKind.SpreadAssignment) &&
        !/(?:\bprocess\b|\benv\b)/u.test(propertyText) &&
        mayProduceString(project.checker.getTypeAtLocation(node)) &&
        !ALLOWED_PROPERTY_STRING_READS.has(propertyText) &&
        !ALLOWED_PROPERTY_STRING_READS.has(normalizedPropertyText)
      )
        unsafePropertyReads.push(propertyText);
      if (
        node.kind === SyntaxKind.ElementAccessExpression &&
        !assignmentLeft &&
        !hasAncestorKind(node, SyntaxKind.SpreadAssignment) &&
        !/(?:\bprocess\b|\benv\b)/u.test(propertyText) &&
        mayProduceString(project.checker.getTypeAtLocation(node)) &&
        !ALLOWED_COMPUTED_STRING_READS.has(propertyText)
      )
        unsafeComputedReads.push(propertyText);
      node.forEachChild(visitUrlCarriers);
    };
    visitUrlCarriers(source);
    assert.deepEqual([...new Set(unsafePropertyReads)], [], `${file}: property access may carry a URL`);
    assert.deepEqual([...new Set(unsafeComputedReads)], [], `${file}: computed access may carry a URL`);
  } finally {
    snapshot?.dispose();
    api.close();
  }
}

function ipv4DocumentationAddress(hostname) {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return (
    (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) ||
    (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
    (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
  );
}

function ipv6DocumentationAddress(hostname) {
  return /^2001:0?db8(?::|$)/iu.test(hostname);
}

function allowedAddress(hostname, allowLoopback = false) {
  const normalised = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (normalised === '127.0.0.1') return allowLoopback;
  if (isIP(normalised) === 4) return ipv4DocumentationAddress(normalised);
  if (isIP(normalised) === 6) return ipv6DocumentationAddress(normalised);
  return false;
}

function allowedHostname(hostname, allowLoopback = false) {
  const normalised = hostname.replace(/\.$/u, '').toLowerCase();
  return (
    allowedAddress(normalised, allowLoopback) || SYNTHETIC_HOST_SUFFIXES.some((suffix) => normalised.endsWith(suffix))
  );
}

function assertAllowedHost(hostname, file, allowLoopback = false) {
  assert.equal(
    allowedHostname(hostname, allowLoopback),
    true,
    `${file}: host ${hostname} must end in .test, .invalid or .example, or be a documentation address`,
  );
}

function assertSyntheticPlainText({
  text,
  file,
  declaredHashes,
  sourceCode,
  completeValue = true,
  checkKeyRuns = true,
  allowedKeyRuns = new Set(),
  allowLoopback = false,
  scanNetwork = true,
  allowAnySourceFileName = false,
}) {
  if (!sourceCode) {
    assert.equal(KNOWN_SECRET_MATERIAL.test(text), false, `${file}: fixture has no recognised secret-looking material`);
    assert.equal(CREDENTIAL_ASSIGNMENT.test(text), false, `${file}: fixture has no credential assignment`);
  }
  for (const candidate of sourceCode || !checkKeyRuns ? [] : text.matchAll(KEY_LIKE_RUN)) {
    assert.equal(
      declaredHashes.has(candidate[0]) || allowedKeyRuns.has(candidate[0]),
      true,
      `${file}: no undeclared high-entropy token or key-shaped string; no undeclared token or key-shaped string of 24 characters`,
    );
  }
  if (!sourceCode)
    assert.equal(PROVIDER_CAPTURE_FIELD.test(text), false, `${file}: fixture has no captured provider-response shape`);

  if (scanNetwork && completeValue)
    for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`)]+/gu)) {
      const literal = match[0];
      let parsed;
      try {
        parsed = new URL(literal.replace(/[;,]$/u, ''));
      } catch {
        assert.fail(`${file}: URL literal must parse before its host can be allowlisted`);
      }
      assertAllowedHost(parsed.hostname, file, allowLoopback);
    }

  if (scanNetwork)
    for (const email of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/gu))
      assertAllowedHost(email[1] ?? '', file, allowLoopback);

  const domainHaystacks = sourceCode || !scanNetwork ? [] : [text];
  for (const haystack of domainHaystacks)
    for (const candidate of haystack.matchAll(
      /(?<![A-Za-z0-9.-])(?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,63})\.?(?![A-Za-z0-9.-])/gu,
    )) {
      const withoutTerminalDot = candidate[0].replace(/\.$/u, '');
      if (allowAnySourceFileName && /\.(?:json|jsonl|mjs|ts)$/u.test(withoutTerminalDot)) continue;
      if (ALLOWED_SOURCE_FILE_NAMES.has(withoutTerminalDot)) continue;
      if (SYNTHETIC_NON_HOST_IDENTIFIERS.has(candidate[0].toLowerCase())) continue;
      assertAllowedHost(candidate[0], file, allowLoopback);
    }

  for (const address of scanNetwork ? text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu) : [])
    assert.equal(
      allowedAddress(address[0], allowLoopback),
      true,
      `${file}: IPv4 address must be in RFC 5737 documentation space`,
    );

  for (const address of scanNetwork
    ? text.matchAll(/(?<![A-Fa-f0-9:])(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9]{0,4}(?![A-Fa-f0-9:])/gu)
    : []) {
    if (isIP(address[0]) !== 6) continue;
    assert.equal(
      allowedAddress(address[0], allowLoopback),
      true,
      `${file}: IPv6 address must be in RFC 3849 documentation space`,
    );
  }
}

function permitsJournalLoopback(file, path, value) {
  if (file !== 'packages/events-daemon/test/fixtures/judges/adversarial-v1.journal.json: decoded JSON value')
    return false;
  if (path.length === 1 && path[0] === 'destination') return value === '127.0.0.1:49152';
  return (
    path.length === 2 &&
    path[0] === 'goldens' &&
    /^POST \/v1\/systemone HTTP\/1\.1\r\nHost: 127\.0\.0\.1:49152\r\n/u.test(value) &&
    [...value.matchAll(/\b127\.0\.0\.1\b/gu)].length === 1
  );
}

function assertDecodedJson(value, file, declaredHashes, checkKeyRuns, path = []) {
  if (typeof value === 'string') {
    const semanticKey = [...path]
      .reverse()
      .find((part) => /^(?:host|hostname|destination|address|endpoint|url)$/iu.test(part));
    if (/^(?:host|hostname|destination|address)$/iu.test(semanticKey ?? '')) {
      let hostname = value;
      if (semanticKey === 'destination') {
        try {
          hostname = new URL(value.includes('://') ? value : `tcp://${value}`).hostname;
        } catch {
          assert.fail(`${file}: destination must parse before its host can be allowlisted`);
        }
      }
      if (semanticKey === 'address' && value.includes('@')) hostname = value.slice(value.lastIndexOf('@') + 1);
      assertAllowedHost(hostname, file, permitsJournalLoopback(file, path, value));
    }
    if (/^(?:endpoint|url)$/iu.test(semanticKey ?? '')) {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        assert.fail(`${file}: URL value must parse before its host can be allowlisted`);
      }
      assertAllowedHost(parsed.hostname, file);
    }
    assertSyntheticPlainText({
      text: value,
      file,
      declaredHashes,
      sourceCode: false,
      checkKeyRuns,
      allowedKeyRuns: ALLOWED_DATA_LITERAL_RUNS,
      allowLoopback: permitsJournalLoopback(file, path, value),
      allowAnySourceFileName: !checkKeyRuns,
    });
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries())
      assertDecodedJson(entry, file, declaredHashes, checkKeyRuns, [...path, String(index)]);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    assert.equal(CREDENTIAL_FIELD.test(key), false, `${file}: fixture has no credential assignment`);
    assert.equal(PROVIDER_CAPTURE_NAME.test(key), false, `${file}: fixture has no captured provider-response shape`);
    assertSyntheticPlainText({
      text: key,
      file,
      declaredHashes,
      sourceCode: false,
      checkKeyRuns,
      allowedKeyRuns: ALLOWED_DATA_LITERAL_RUNS,
      allowAnySourceFileName: !checkKeyRuns,
    });
    assertDecodedJson(entry, file, declaredHashes, checkKeyRuns, [...path, key]);
  }
}

/**
 * The Task 11 fixtures are executable test input, so their trust boundary is an allowlist rather than a short list
 * of provider domains somebody happened to remember. The literal loopback exceptions are the sealed injected
 * transport itself; every other address is from RFC 5737 or RFC 3849.
 */
export function assertSyntheticFixtureText({ text, file, declaredHashes, sourcePath, checkKeyRuns = true }) {
  const lowerFile = file.toLowerCase();
  if (lowerFile.endsWith('.ts'))
    assertClosedComputedStrings(
      text,
      file,
      declaredHashes,
      sourcePath ?? resolve(REPOSITORY_ROOT, 'packages/events-daemon/test/support/judge-adversarial-fixture.ts'),
    );
  const structuredData = lowerFile.endsWith('.json') || lowerFile.endsWith('.jsonl');
  assertSyntheticPlainText({
    text,
    file,
    declaredHashes,
    sourceCode: lowerFile.endsWith('.ts'),
    checkKeyRuns: checkKeyRuns && !structuredData,
    scanNetwork: !structuredData && !lowerFile.endsWith('.ts'),
  });
  if (lowerFile.endsWith('.json'))
    assertDecodedJson(JSON.parse(text), `${file}: decoded JSON value`, declaredHashes, checkKeyRuns);
  if (lowerFile.endsWith('.jsonl'))
    for (const [index, line] of text.trim().split('\n').entries())
      assertDecodedJson(JSON.parse(line), `${file}: decoded JSONL row ${index + 1}`, declaredHashes, checkKeyRuns);
}

async function fixtureFilesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) assert.fail(`${path}: symlinks are not permitted in the adversarial corpus tree`);
    if (entry.isDirectory()) files.push(...(await fixtureFilesUnder(path)));
    else if (entry.isFile() && entry.name.toLowerCase().startsWith('adversarial-')) files.push(path);
  }
  return files;
}

async function supportFilesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const matches = /^judge-adversarial-.*\.ts$/iu.test(entry.name);
    if (entry.isSymbolicLink()) {
      if (matches) assert.fail(`${path}: symlinks are not permitted in the adversarial corpus`);
      continue;
    }
    if (entry.isDirectory()) files.push(...(await supportFilesUnder(path)));
    else if (entry.isFile() && matches) files.push(path);
  }
  return files;
}

function staticModuleSpecifiers(text, file) {
  const imports = text.matchAll(/^\s*import\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gmu);
  const exports = text.matchAll(
    /^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gmu,
  );
  const importEquals = text.matchAll(/^\s*import\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gmu);
  if (/\bcreateRequire\b/u.test(text)) assert.fail(`${file}: adversarial helpers must not create CommonJS loaders`);
  const calledSpecifiers = [];
  for (const match of text.matchAll(/\b(?:import|require)\s*\(\s*([^\r\n)]*)\)/gmu)) {
    const argument = match[1]?.trim() ?? '';
    const literal = /^(['"])([^'"]+)\1$/u.exec(argument);
    if (literal === null) assert.fail(`${file}: adversarial helper module specifiers must be static string literals`);
    calledSpecifiers.push(literal[2]);
  }
  return [...imports, ...exports, ...importEquals].map((match) => match[1]).concat(calledSpecifiers);
}

function insideDirectory(directory, path) {
  const child = relative(directory, path);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..');
}

async function supportDependency(importer, specifier, supportRoot) {
  if (!specifier.startsWith('.')) return undefined;
  const requested = resolve(dirname(importer), specifier);
  if (!insideDirectory(supportRoot, requested)) return undefined;
  const candidates = [requested];
  if (!/\.[A-Za-z0-9]+$/u.test(requested))
    candidates.push(`${requested}.ts`, `${requested}.mts`, resolve(requested, 'index.ts'));
  for (const candidate of candidates) {
    try {
      const metadata = await lstat(candidate);
      assert.equal(
        metadata.isSymbolicLink(),
        false,
        `${candidate}: symlinks are not permitted in the adversarial corpus`,
      );
      if (metadata.isFile()) return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  assert.fail(`${repositoryRelative(REPOSITORY_ROOT, requested)}: imported adversarial helper does not exist`);
}

async function dependencyClosedSupportFiles(roots, supportRoot) {
  const discovered = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const importer = pending.pop();
    assert.ok(importer, 'the dependency-closure work item exists');
    const text = await readFile(importer, 'utf8');
    for (const specifier of staticModuleSpecifiers(text, repositoryRelative(REPOSITORY_ROOT, importer))) {
      const dependency = await supportDependency(importer, specifier, supportRoot);
      if (dependency === undefined || discovered.has(dependency)) continue;
      discovered.add(dependency);
      pending.push(dependency);
    }
  }
  return [...discovered];
}

function repositoryRelative(repositoryRoot, path) {
  return relative(repositoryRoot, path).split(sep).join('/');
}

/** Discovers the complete Task 11 corpus surface and proves the manifest names it exactly. */
export async function assertAdversarialCorpusFileInventory({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  const fixtureRoot = resolve(repositoryRoot, FIXTURE_DIRECTORY);
  const supportRoot = resolve(repositoryRoot, SUPPORT_DIRECTORY);
  const [fixtureFiles, supportRoots] = await Promise.all([
    fixtureFilesUnder(fixtureRoot),
    supportFilesUnder(supportRoot),
  ]);
  const supportFiles = await dependencyClosedSupportFiles(supportRoots, supportRoot);
  const discovered = [...fixtureFiles, ...supportFiles].map((path) => repositoryRelative(repositoryRoot, path)).sort();
  const manifests = fixtureFiles.filter((path) => /^adversarial-.*\.manifest\.json$/iu.test(basename(path)));
  assert.equal(manifests.length, 1, 'the discovered adversarial corpus has exactly one manifest');
  const manifestPath = manifests[0];
  assert.ok(manifestPath, 'the discovered adversarial corpus manifest exists');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(Array.isArray(manifest.files), true, 'the corpus manifest has a file inventory');
  const named = manifest.files;
  assert.equal(
    named.every((file) => typeof file === 'string'),
    true,
    'every corpus manifest file name is a string',
  );
  assert.equal(new Set(named).size, named.length, 'the corpus manifest file inventory has no duplicate');
  const namedSet = new Set(named);
  const discoveredSet = new Set(discovered);
  for (const file of discovered) assert.equal(namedSet.has(file), true, `${file} is missing from the corpus manifest`);
  for (const file of named) assert.equal(discoveredSet.has(file), true, `${file} does not exist`);
  return {
    repositoryRoot,
    manifestPath: repositoryRelative(repositoryRoot, manifestPath),
    files: discovered,
    manifest,
  };
}

/** The hashed journal must define one and only one scripted byte vector for every corpus response reference. */
export function assertScriptedResponseInventory({ responses, expectedKinds, file }) {
  assert.deepEqual(
    Object.keys(responses).sort(),
    [...expectedKinds].sort(),
    `${file}: scripted response inventory is exact`,
  );
}
