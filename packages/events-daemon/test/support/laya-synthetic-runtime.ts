import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A synthetic Laya runtime tree with the recorded layout (`node_modules/@receptron/laya/dist/laya.js`, the tokenizer
 * package and its `package.json` entry) and a model directory with the reviewed context limits. It is never the real
 * package: its `Laya.load` records its options and answers what a test hands it, and its downloader throws if imported.
 */
export interface SyntheticRuntimeTree {
  readonly root: string;
  readonly payload: { readonly runtimeRoot: string; readonly modelDir: string };
}

/** A synthetic runtime tree with the recorded layout — never the real package — whose load records its options. */
export async function syntheticRuntimeTree(
  options: { readonly config?: unknown; readonly tokenizersManifest?: unknown; readonly layaModule?: string } = {},
): Promise<SyntheticRuntimeTree> {
  const root = await mkdtemp(join(tmpdir(), 'laya-wr-'));
  const runtimeRoot = join(root, 'runtime');
  const modelDir = join(root, 'model');
  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const laya = join(runtimeRoot, 'node_modules', '@receptron', 'laya');
  await write(join(laya, 'package.json'), '{"name":"@receptron/laya","type":"module"}\n');
  await write(
    join(laya, 'dist', 'laya.js'),
    options.layaModule ??
      `export class Laya {
  static async load(options) {
    globalThis.__layaSyntheticLoads.push(options);
    return new Laya();
  }
  async systemOne(state, questions) {
    globalThis.__layaSyntheticAsks.push({ state, questions });
    return { answers: { decision: { type: 'noul', noul: 0.625 } }, model: 'synthetic', usage: { input_tokens: 0, output_tokens: 0 } };
  }
  async close() {
    globalThis.__layaSyntheticClosed += 1;
  }
}
`,
  );
  await write(join(laya, 'dist', 'download.js'), "throw new Error('the package downloader must never be imported');\n");
  const tokenizers = join(runtimeRoot, 'node_modules', '@huggingface', 'tokenizers');
  await write(
    join(tokenizers, 'package.json'),
    `${JSON.stringify(
      options.tokenizersManifest ?? {
        name: '@huggingface/tokenizers',
        exports: { '.': { import: './dist/tokenizers.mjs', require: './dist/tokenizers.cjs' } },
      },
    )}\n`,
  );
  await write(
    join(tokenizers, 'dist', 'tokenizers.mjs'),
    `export class Tokenizer {
  constructor(json, config) {
    (globalThis.__layaSyntheticTokenizers ??= []).push({ json, config });
  }
  encode(text, options) {
    if (options?.add_special_tokens !== false) throw new Error('special tokens must not be added');
    return { ids: text.split(/\\s+/u).filter(Boolean).map((_, index) => index), tokens: [] };
  }
}
`,
  );
  await write(join(root, 'escape.mjs'), 'export class Tokenizer {}\n');
  await write(
    join(modelDir, 'laya_config.json'),
    `${JSON.stringify(options.config ?? { max_len: 512, head_max_len: 192 })}\n`,
  );
  await write(join(modelDir, 'tokenizer', 'tokenizer.json'), '{"synthetic":"tokenizer"}\n');
  await write(join(modelDir, 'tokenizer', 'tokenizer_config.json'), '{"synthetic":"config"}\n');
  return { root, payload: { runtimeRoot, modelDir } };
}

/** A runtime whose `systemOne` answers from `answer.json` beside it, so a child worker can be told what to say. */
export const ANSWERING_LAYA: string = `import { readFileSync } from 'node:fs';
export class Laya {
  static async load(options) {
    if (options.modelDir === undefined || options.executionProviders?.[0] !== 'cpu') throw new Error('not a CPU load');
    return new Laya();
  }
  async systemOne(state, questions) {
    const reply = JSON.parse(readFileSync(new URL('./answer.json', import.meta.url), 'utf8'));
    return { answers: { decision: { type: 'noul', noul: reply.noul } }, model: 'synthetic', usage: { input_tokens: reply.inputTokens, output_tokens: 0 } };
  }
  async close() {}
}
`;
