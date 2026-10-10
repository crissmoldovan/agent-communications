import { createServer } from 'node:http';
import { assertLoopbackSeal } from '../../../../test/helpers/loopback-seal-preload.mjs';

export async function startLoopbackTrap() {
  assertLoopbackSeal();
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
