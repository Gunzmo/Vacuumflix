const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const cp = require('node:child_process');
const { Mp4Cache, MAX_BYTES } = require('../runtime/mp4-cache');
const delay = ms => new Promise(r => setTimeout(r, ms));
const fakeMp4 = n => {
  const free = Buffer.alloc(n - 20, 42); free.writeUInt32BE(free.length); free.write('free', 4);
  return Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from('ftypisom'), Buffer.from([0, 0, 0, 8, 109, 111, 111, 118]), free]);
};
async function fixture(t, handler, maxBytes = 1024) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuumflix-mp4-'));
  const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  const cache = new Mp4Cache({ directory, maxBytes });
  t.after(async () => { await cache.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); });
  return { cache, url, directory };
}
const files = d => fs.readdirSync(d).filter(f => /\.(mp4|part)$/.test(f));

test('buffers complete MP4 before serving ranges, coalesces downloads and removes clear media on exit', async t => {
  const data = fakeMp4(200); let calls = 0, finish;
  const { cache, url, directory } = await fixture(t, (req, res) => {
    calls++; assert.equal(req.headers.range, undefined);
    res.writeHead(200, { 'Content-Length': data.length }); res.write(data.subarray(0, 100)); finish = () => res.end(data.subarray(100));
  });
  let ready = false;
  const first = cache.acquire(url + '/video').then(x => { ready = true; return x; });
  const second = cache.acquire(url + '/video');
  while (!finish) await delay(5);
  await delay(20); assert.equal(ready, false); assert.equal(calls, 1); assert(files(directory)[0].endsWith('.part'));
  finish(); const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.read(50, 99), data.subarray(50, 100)); assert.deepEqual(b.read(170, -1), data.subarray(170));
  assert.throws(() => a.read(200), /range/); a.release(); b.release();
  assert.equal(fs.statSync(path.join(directory, files(directory)[0])).mode & 0o777, 0o600);
  const c = await cache.acquire(url + '/video'); assert.deepEqual(c.read(), data); assert.equal(calls, 1); c.release();
  await cache.close(); assert.deepEqual(files(directory), []);
});

test('10 GB hard maximum; cap covers completed MP4s and reservations for concurrent downloads', async t => {
  assert.equal(MAX_BYTES, 10_000_000_000); assert.throws(() => new Mp4Cache({ maxBytes: MAX_BYTES + 1 }), /at most 10 GB/);
  const { cache, url, directory } = await fixture(t, (req, res) => {
    const data = fakeMp4(req.url === '/oversized' ? 101 : 60);
    res.writeHead(200, { 'Content-Length': data.length }); res.end(data);
  }, 100);
  const first = await cache.acquire(url + '/a');
  await assert.rejects(cache.acquire(url + '/b'), /10 GB/); // active file cannot be evicted
  await assert.rejects(cache.acquire(url + '/oversized'), /10 GB/);
  assert.equal(cache.bytes, 60); assert.deepEqual(first.read(), fakeMp4(60));
  first.release(); const second = await cache.acquire(url + '/b');
  assert.equal(cache.bytes, 60); assert.equal(files(directory).length, 1); second.release();
});

test('unknown content length cannot exceed the shared cap and removes its partial file', async t => {
  const { cache, url, directory } = await fixture(t, (_, res) => { res.write(fakeMp4(60)); res.end(Buffer.alloc(60)); }, 100);
  await assert.rejects(cache.acquire(url), /10 GB/); assert.equal(cache.bytes, 0); assert.deepEqual(files(directory), []);
});

test('in-flight reservations prevent two downloads from overflowing the limit', async t => {
  let finish;
  const { cache, url } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': 60 });
    if (req.url === '/a') { res.write(fakeMp4(60).subarray(0, 30)); finish = () => res.end(fakeMp4(60).subarray(30)); } else res.end(fakeMp4(60));
  }, 100);
  const first = cache.acquire(url + '/a'); while (!finish) await delay(5);
  await assert.rejects(cache.acquire(url + '/b'), /10 GB/); assert.equal(cache.bytes, 60);
  finish(); (await first).release();
});

test('aborting one reader preserves a shared download; cancelling all readers cleans up', async t => {
  let finish;
  const { cache, url, directory } = await fixture(t, (_, res) => { res.writeHead(200, { 'Content-Length': 100 }); res.write(fakeMp4(100).subarray(0, 50)); finish = () => res.end(fakeMp4(100).subarray(50)); });
  const c = new AbortController();
  const a = cache.acquire(url, { signal: c.signal }), b = cache.acquire(url);
  while (!finish) await delay(5); c.abort(); await assert.rejects(a, { name: 'AbortError' }); finish(); (await b).release();
  finish = null;
  const d = new AbortController(), abandoned = cache.acquire(url + '/cancel', { signal: d.signal });
  while (!finish) await delay(5); d.abort(); await assert.rejects(abandoned, { name: 'AbortError' });
  await cache.close(); assert.equal(files(directory).length, 0); assert.equal(cache.bytes, 0); assert(!fs.existsSync(path.join(directory, '.lock')));
});

test('rejects non-MP4, HTTP errors, partial responses and interrupted downloads; follows redirects', async t => {
  const { cache, url, directory } = await fixture(t, (req, res) => {
    if (req.url === '/bad') return res.end('<html>login page</html>');
    if (req.url === '/error') { res.writeHead(403); return res.end(); }
    if (req.url === '/partial') { res.writeHead(206); return res.end(fakeMp4(60)); }
    if (req.url === '/truncated') { res.writeHead(200, { 'Content-Length': 200 }); res.write(fakeMp4(100)); setImmediate(() => res.destroy()); return; }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/good' }); return res.end(); }
    res.end(fakeMp4(60));
  });
  for (const route of ['/bad', '/error', '/partial', '/truncated']) { await assert.rejects(cache.acquire(url + route)); assert.equal(cache.bytes, 0); assert.deepEqual(files(directory), []); }
  const lease = await cache.acquire(url + '/redirect'); assert.deepEqual(lease.read(), fakeMp4(60)); lease.release();
});

test('recovers abandoned partials and enforces one owner for the combined directory', async t => {
  const { cache, directory } = await fixture(t, (_, res) => res.end());
  assert.throws(() => new Mp4Cache({ directory }), /in use/); await cache.close();
  const partial = 'a'.repeat(64) + '.part'; fs.writeFileSync(path.join(directory, partial), 'incomplete');
  const restarted = new Mp4Cache({ directory });
  assert(!fs.existsSync(path.join(directory, partial))); await restarted.close();
});

test('cached real fragmented MP4 decodes identically to its source', async t => {
  const encoded = cp.spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=16x16:r=24', '-frames:v', '8', '-c:v', 'libx264', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1']);
  assert.equal(encoded.status, 0, String(encoded.stderr));
  const { cache, url, directory } = await fixture(t, (_, res) => res.end(encoded.stdout), 100000);
  const lease = await cache.acquire(url);
  assert.deepEqual(lease.read(), encoded.stdout);
  const decoded = cp.spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(directory, files(directory)[0]), '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1']);
  assert.equal(decoded.status, 0, String(decoded.stderr)); assert.equal(decoded.stdout.length, 8 * 16 * 16 * 1.5); lease.release();
});

test('retries interrupted HTTP downloads from a fresh header without leaking quota or partial data', async t => {
  const data = fakeMp4(200); let calls = 0;
  const { cache, url, directory } = await fixture(t, (_, res) => {
    calls++; res.writeHead(200, { 'Content-Length': data.length });
    if (calls === 1) { res.write(data.subarray(0, 100)); setTimeout(() => res.destroy(), 10); }
    else res.end(data);
  }, 200);
  const logs = []; cache.log = msg => logs.push(msg);
  const lease = await cache.acquire(url);
  assert.equal(calls, 2); assert.deepEqual(lease.read(), data); assert.equal(cache.bytes, 200);
  assert.deepEqual(files(directory).map(f => f.slice(-4)), ['.mp4']);
  assert(logs.some(msg => /interrupted at 100\/200 bytes.*ECONNRESET.*restarting/.test(msg)));
  lease.release();
});

test('replacement reader waits for cancelled download cleanup before starting the same URL', async t => {
  const data = fakeMp4(100); let calls = 0, started;
  const ready = new Promise(r => { started = r; });
  const { cache, url } = await fixture(t, (_, res) => {
    calls++; res.writeHead(200, { 'Content-Length': data.length });
    if (calls === 1) { res.write(data.subarray(0, 50)); started(); } else res.end(data);
  }, 100);
  const controller = new AbortController();
  const first = cache.acquire(url, { signal: controller.signal });
  await ready; controller.abort(); await assert.rejects(first, { name: 'AbortError' });
  const replacement = await cache.acquire(url);
  assert.deepEqual(replacement.read(), data); assert.equal(calls, 2); assert.equal(cache.bytes, 100); replacement.release();
});

test('paused HTTP reads do not time out during slow downstream preparation', async t => {
  const data = fakeMp4(100); let finish;
  const { cache, url } = await fixture(t, (_, res) => {
    res.writeHead(200, { 'Content-Length': data.length }); res.write(data.subarray(0, 50));
    finish = () => res.end(data.subarray(50));
  });
  cache.requestTimeoutMs = 30;
  const res = await cache.response(url, new AbortController().signal);
  let error; res.on('error', e => { error = e; });
  res.pause(); await delay(100); assert.equal(error, undefined); assert.equal(res.destroyed, false);
  finish(); const chunks = []; for await (const chunk of res) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), data);
});

test('network retry limit is bounded and cancellation during retry backoff stops new downloads', async t => {
  let calls = 0;
  const { cache, url, directory } = await fixture(t, (_, res) => {
    calls++; res.writeHead(200, { 'Content-Length': 100 }); res.write(fakeMp4(100).subarray(0, 50)); setTimeout(() => res.destroy(), 5);
  });
  await assert.rejects(cache.acquire(url), /interrupted.*ECONNRESET/); assert.equal(calls, 3);
  assert.equal(cache.bytes, 0); assert.deepEqual(files(directory), []);
  const controller = new AbortController();
  cache.log = msg => { if (msg.includes('restarting')) controller.abort(); };
  await assert.rejects(cache.acquire(url, { signal: controller.signal }), { name: 'AbortError' });
  await delay(300); assert.equal(calls, 4); assert.equal(cache.bytes, 0); assert.deepEqual(files(directory), []);
});

test('unpaused network stalls still time out and exhaust only the bounded retries', async t => {
  let calls = 0;
  const { cache, url, directory } = await fixture(t, (_, res) => {
    calls++; res.writeHead(200, { 'Content-Length': 100 }); res.flushHeaders();
  });
  cache.requestTimeoutMs = 30;
  await assert.rejects(cache.acquire(url), /interrupted.*ETIMEDOUT.*stalled/);
  assert.equal(calls, 3); assert.equal(cache.bytes, 0); assert.deepEqual(files(directory), []);
});
