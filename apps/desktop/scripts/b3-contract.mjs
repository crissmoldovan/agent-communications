import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { OWNER_CONTROL_WIRE_OPERATIONS } from '../../../packages/events-daemon/src/runtime/control-operation-registry.ts';

const root = new URL('../../../', import.meta.url);
const require = createRequire(new URL('packages/events-daemon/package.json', root));
const Ajv = require('ajv/dist/2020.js').default;
const read = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const literal = (value) => `r###"${JSON.stringify(value)}"###`;
const name = (value) => value.replace(/(^|[-_])([a-z])/g, (_, _prefix, character) => character.toUpperCase());

/** Build-time only. The bundle contains generated Rust DTOs, never this Node program or a schema interpreter. */
export async function generateContract(options = {}) {
  const schema = await read('packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json');
  const doctor = await read('packages/events-daemon/src/operations/contracts/doctor-v1.schema.json');
  assert.equal(schema.$id, 'https://agentcomms.local/b3-control-v1.schema.json');
  assert.equal(doctor.$id, 'https://agentcomms.local/events-doctor-v1.schema.json');
  const folder = new URL('packages/events-daemon/test/fixtures/b3-control-contract-v1/', root);
  const vectors = (
    await Promise.all(
      (
        await readdir(folder)
      )
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map(async (file) => JSON.parse(await readFile(new URL(file, folder), 'utf8'))),
    )
  ).flat();
  options.mutateSchema?.(schema);
  options.mutateVectors?.(vectors);
  const branches = schema.$defs.request.oneOf;
  const operationNames = branches.flatMap(
    (branch) => branch.properties.operation.enum ?? [branch.properties.operation.const],
  );
  const registry = OWNER_CONTROL_WIRE_OPERATIONS.filter((entry) => entry.desktopCallable)
    .map((entry) => entry.wireOperation)
    .sort();
  assert.deepEqual(
    [...operationNames].sort(),
    registry,
    'schema operation set must equal the production owner registry',
  );
  assert.deepEqual(Object.keys(schema.$defs.resultsByOperation.$defs).sort(), registry);
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(doctor);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/vector`);
  for (const vector of vectors) assert.ok(validate(vector), `${vector.name}: ${JSON.stringify(validate.errors)}`);
  const resultOperations = new Set(
    vectors.filter((vector) => 'result' in vector).map((vector) => vector.request.operation),
  );
  assert.deepEqual([...resultOperations].sort(), registry, 'every wire needs a success vector');
  const secret = registry.filter(
    (operation) => schema.$defs.resultsByOperation.$defs[operation].$ref === '#/$defs/secretCapabilityUnavailable',
  );
  assert.equal(secret.length, 8, 'the complete D2 list has eight secret operations');
  const operations = registry.filter((operation) => !secret.includes(operation));
  const generated = [];
  const validators = new Map();
  const types = new Map();
  const resolve = (node, document) => {
    if (!node.$ref) return [node, document];
    if (node.$ref === doctor.$id) return [doctor, doctor];
    assert.ok(node.$ref.startsWith('#/'), 'no remote schema loading');
    return [
      node.$ref
        .slice(2)
        .split('/')
        .reduce((value, key) => value[key], document),
      document,
    ];
  };
  function validator(node, document = schema) {
    if (node.$ref) {
      if (node.$ref === '#/$defs/json' && document === schema) return 'opaque_json';
      return validator(...resolve(node, document));
    }
    if (validators.has(node)) return validators.get(node);
    const id = `schema_${validators.size}`;
    validators.set(node, id);
    const checks = [];
    const supported = new Set([
      '$id',
      '$schema',
      '$defs',
      'title',
      'description',
      'type',
      'const',
      'enum',
      'required',
      'properties',
      'additionalProperties',
      'items',
      'minItems',
      'maxItems',
      'minLength',
      'maxLength',
      'minProperties',
      'maxProperties',
      'minimum',
      'maximum',
      'pattern',
      'oneOf',
      'anyOf',
      'allOf',
      'not',
    ]);
    for (const key of Object.keys(node)) assert.ok(supported.has(key), `unsupported schema keyword ${key}`);
    if ('const' in node) checks.push(`v == &serde_json::from_str::<Value>(${literal(node.const)}).unwrap()`);
    if (node.enum) checks.push(`serde_json::from_str::<Vec<Value>>(${literal(node.enum)}).unwrap().contains(v)`);
    if (node.type) {
      const predicate = {
        object: 'is_object',
        array: 'is_array',
        string: 'is_string',
        boolean: 'is_boolean',
        number: 'is_number',
        null: 'is_null',
      }[node.type];
      checks.push(node.type === 'integer' ? '(v.is_i64() || v.is_u64())' : `v.${predicate}()`);
    }
    for (const [keyword, comparison] of [
      ['minimum', '>='],
      ['maximum', '<='],
    ])
      if (keyword in node) checks.push(`v.as_f64().is_some_and(|n| n ${comparison} ${node[keyword]}.0)`);
    for (const [keyword, getter, measure, comparison] of [
      ['minLength', 'as_str', 'chars().count()', '>='],
      ['maxLength', 'as_str', 'chars().count()', '<='],
      ['minItems', 'as_array', 'len()', '>='],
      ['maxItems', 'as_array', 'len()', '<='],
      ['minProperties', 'as_object', 'len()', '>='],
      ['maxProperties', 'as_object', 'len()', '<='],
    ])
      if (keyword in node) checks.push(`v.${getter}().is_some_and(|x| x.${measure} ${comparison} ${node[keyword]})`);
    if (node.pattern) {
      assert.equal(node.pattern, '^[a-f0-9]{64}$', 'unrecognised pattern requires a reviewed generator change');
      checks.push(
        "v.as_str().is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))",
      );
    }
    if (node.required) checks.push(...node.required.map((key) => `v.get(${JSON.stringify(key)}).is_some()`));
    if (node.properties)
      for (const [key, child] of Object.entries(node.properties))
        checks.push(`v.get(${JSON.stringify(key)}).is_none_or(${validator(child, document)})`);
    if (node.additionalProperties === false)
      checks.push(
        `v.as_object().is_some_and(|o| o.keys().all(|k| [${Object.keys(node.properties ?? {})
          .map((key) => JSON.stringify(key))
          .join(',')}].contains(&k.as_str())))`,
      );
    if (node.items) checks.push(`v.as_array().is_some_and(|a| a.iter().all(${validator(node.items, document)}))`);
    for (const union of ['oneOf', 'anyOf', 'allOf'])
      if (node[union]) {
        const expressions = node[union].map((child) => `${validator(child, document)}(v)`);
        checks.push(
          union === 'oneOf'
            ? `[${expressions}].into_iter().filter(|x| *x).count() == 1`
            : `(${expressions.join(union === 'allOf' ? ' && ' : ' || ')})`,
        );
      }
    if (node.not) checks.push(`!${validator(node.not, document)}(v)`);
    generated.push(`fn ${id}(v: &Value) -> bool { ${checks.join(' && ') || 'true'} }`);
    return id;
  }
  function rustType(node, document = schema) {
    if (node.$ref) {
      if (node.$ref === '#/$defs/json' && document === schema) return 'Value';
      return rustType(...resolve(node, document));
    }
    if (types.has(node)) return types.get(node);
    const type =
      node.type ??
      (node.const !== undefined
        ? Number.isInteger(node.const)
          ? 'integer'
          : typeof node.const
        : node.enum
          ? typeof node.enum[0]
          : undefined);
    const primitive = { string: 'String', boolean: 'bool', number: 'f64', integer: 'i64', null: '()' }[type];
    if (primitive) return primitive;
    if (type === 'array') return `Vec<${node.items ? rustType(node.items, document) : 'Value'}>`;
    const id = `Dto${types.size}`;
    types.set(node, id);
    if (type === 'object' && node.properties) {
      const fields = Object.entries(node.properties).map(([key, child], index) => {
        const value = rustType(child, document);
        return `#[serde(rename=${JSON.stringify(key)}${node.required?.includes(key) ? '' : ',default,skip_serializing_if="Option::is_none"'})] pub field_${index}: ${node.required?.includes(key) ? value : `Option<${value}>`}`;
      });
      generated.push(
        `#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(deny_unknown_fields)] pub struct ${id} { ${fields.join(',')} }`,
      );
    } else if (node.oneOf || node.anyOf) {
      const variants = (node.oneOf ?? node.anyOf).map((child, index) => `V${index}(${rustType(child, document)})`);
      generated.push(
        `#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(untagged)] pub enum ${id} { ${variants.join(',')} }`,
      );
    } else {
      // Schema fragments with only constraints are checked by their generated validator; no field is interpreted.
      generated.push(`pub type ${id} = Value;`);
    }
    return id;
  }
  const argsFor = (operation) =>
    branches.find((branch) =>
      (branch.properties.operation.enum ?? [branch.properties.operation.const]).includes(operation),
    ).properties.args;
  const entries = operations.map((operation) => ({
    operation,
    variant: name(operation),
    args: rustType(argsFor(operation)),
    checkArgs: validator(argsFor(operation)),
    result: rustType(schema.$defs.resultsByOperation.$defs[operation]),
    checkResult: validator(schema.$defs.resultsByOperation.$defs[operation]),
    scope: (() => {
      let shape = schema.$defs.resultsByOperation.$defs[operation];
      while (shape.$ref) [shape] = resolve(shape, schema);
      const identity = new Set([
        'id',
        'objectId',
        'type',
        'version',
        'source',
        'accountId',
        'ruleId',
        'ruleVersion',
        'targetId',
        'targetVersion',
        'subscriberId',
        'deliveryId',
        'eventId',
      ]);
      return Object.keys(shape.properties ?? {}).filter((field) => identity.has(field));
    })(),
  }));
  const digest = createHash('sha256')
    .update(JSON.stringify([schema, doctor, vectors]))
    .digest('hex');
  return `// Generated from the B3 v1 schemas and validated vectors. Do not hand-edit.\n
use serde::{Deserialize,Serialize}; use serde_json::Value;
pub const B3_SCHEMA_DIGEST: &str = "${digest}";
pub const NON_SECRET_OPERATIONS: &[&str] = &[${operations.map((op) => JSON.stringify(op)).join(',')}];
pub const SECRET_OPERATIONS: &[&str] = &[${secret.map((op) => JSON.stringify(op)).join(',')}];
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)] pub enum NonSecretOperation { ${entries.map((e) => `#[serde(rename="${e.operation}")] ${e.variant}`).join(',')} }
impl NonSecretOperation { pub fn wire(self) -> &'static str { match self { ${entries.map((e) => `Self::${e.variant} => "${e.operation}"`).join(',')} } } }
#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(tag="operation",content="args",deny_unknown_fields)] pub enum RequestDto { ${entries.map((e) => `#[serde(rename="${e.operation}")] ${e.variant}(${e.args})`).join(',')} }
#[derive(Clone, Debug, Serialize)] #[serde(untagged)] pub enum ResultDto { ${entries.map((e) => `${e.variant}(${e.result})`).join(',')} }
impl RequestDto {
pub fn scope_fields(&self) -> &'static [&'static str] { match self { ${entries.map((e) => `Self::${e.variant}(..) => &[${e.scope.map((field) => JSON.stringify(field)).join(',')}]`).join(',')} } }
pub fn operation(&self) -> NonSecretOperation { match self { ${entries.map((e) => `Self::${e.variant}(..) => NonSecretOperation::${e.variant}`).join(',')} } }
pub fn valid_args(&self, args: &Value) -> bool { match self { ${entries.map((e) => `Self::${e.variant}(..) => ${e.checkArgs}(args)`).join(',')} } }
pub fn parse_result(&self, value: Value) -> Result<ResultDto, String> { match self { ${entries.map((e) => `Self::${e.variant}(..) => { if !${e.checkResult}(&value) { return Err("B3_RESULT_SCHEMA".into()); } serde_json::from_value(value).map(ResultDto::${e.variant}).map_err(|_| "B3_RESULT_SCHEMA".into()) }`).join(',')} } }
}
fn opaque_json(_: &Value) -> bool { true }
${generated.join('\n')}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(await generateContract());
