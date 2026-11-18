import { createServer } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createProxyServer } from 'httpxy';

const HOST = '127.0.0.1';
const CORE_PORT = 8012;
const PROXY_PORT = 8013;
const MAX_DELAY_MS = 5000;

function isDecimal(value) {
  return (
    value.length > 0 &&
    [...value].every((digit) => digit >= '0' && digit <= '9')
  );
}

function isRedemption(req) {
  if (req.method !== 'POST') {
    return false;
  }

  const [pathname] = req.url.split('?');
  const segments = pathname.slice(1).split('/');
  if (segments.at(-1) === '') {
    segments.pop();
  }
  if (segments.length !== 5) {
    return false;
  }

  const [videogames, gameId, players, playerId, action] = segments;
  return (
    videogames === 'videogames' &&
    isDecimal(gameId) &&
    players === 'players' &&
    isDecimal(playerId) &&
    action === 'redeem'
  );
}

async function delayRedemption(res, delayMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  try {
    await wait(delayMs, undefined, { signal: controller.signal });
  } finally {
    res.off('close', cancel);
  }
}

export function createProxy({
  corePort = CORE_PORT,
  delayMs = 0,
  log = console.log,
} = {}) {
  const proxy = createProxyServer({
    target: `http://${HOST}:${corePort}`,
    changeOrigin: true,
    followRedirects: false,
    proxyTimeout: 7000,
  });

  return createServer(async (req, res) => {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400).end();
      return;
    }

    try {
      if (delayMs > 0 && isRedemption(req)) {
        const startedAt = performance.now();
        await delayRedemption(res, delayMs);
        if (res.destroyed) {
          return;
        }
        log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            event: 'redeem_forwarded',
            delayMs,
            elapsedMs: Math.round(performance.now() - startedAt),
          }),
        );
      }
      await proxy.web(req, res);
    } catch {
      if (res.destroyed) {
        return;
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res
        .writeHead(502, { 'content-type': 'application/json' })
        .end('{"error":"CORE_UNAVAILABLE"}');
    }
  });
}

function parseDelay(value) {
  if (!isDecimal(value)) {
    return null;
  }
  const delayMs = Number(value);
  return delayMs <= MAX_DELAY_MS ? delayMs : null;
}

function main(args = process.argv.slice(2)) {
  const delayMs = parseDelay(args[0] ?? '0');
  if (args.length > 1 || delayMs === null) {
    throw new Error(`Uso: npm start [demora en ms, 0 a ${MAX_DELAY_MS}]`);
  }
  const server = createProxy({ delayMs });
  server.once('error', (error) => {
    console.error(
      `No se pudo iniciar el proxy en ${HOST}:${PROXY_PORT} (${error.code}).`,
    );
    process.exitCode = 1;
  });
  server.listen(PROXY_PORT, HOST, () => {
    console.log(
      `Proxy: ${HOST}:${PROXY_PORT} -> ${HOST}:${CORE_PORT} (demora de canje: ${delayMs} ms)`,
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
