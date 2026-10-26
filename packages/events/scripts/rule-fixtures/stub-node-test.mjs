/** A stand-in for `node:test` while the harvester evaluates a test module: it registers nothing and runs no test body. */
const noop = () => undefined;

function registrar() {
  const register = () => undefined;
  for (const variant of ['skip', 'todo', 'only']) register[variant] = noop;
  return register;
}

export const test = registrar();
export const it = registrar();
export const describe = registrar();
export const suite = registrar();
export const before = noop;
export const after = noop;
export const beforeEach = noop;
export const afterEach = noop;
export const mock = new Proxy({}, { get: () => () => ({ mock: { calls: [] }, restore: noop }) });
export default test;
