import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!specifier.startsWith('.')) throw error;
    for (const extension of ['.ts', '.tsx']) {
      try {
        return await next(`${specifier}${extension}`, context);
      } catch {}
    }
    throw error;
  }
}
export async function load(url, context, next) {
  if (!url.includes('/apps/desktop/') || !/\.tsx?$/u.test(url)) return next(url, context);
  const source = await readFile(new URL(url), 'utf8');
  const compiled = await transformWithEsbuild(source, new URL(url).pathname, {
    loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
    target: 'es2022',
    jsx: 'automatic',
  });
  return { format: 'module', shortCircuit: true, source: compiled.code };
}
