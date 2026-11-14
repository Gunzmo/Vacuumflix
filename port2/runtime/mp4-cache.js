'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http'), https = require('node:https');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const MAX_BYTES = 10_000_000_000; // Combined video, audio and incomplete downloads: 10 GB.
const ACTIVE = new Set();
process.on('exit', () => { for (const cache of ACTIVE) cache.close(); });
const abortError = () => Object.assign(new Error('MP4 cache request cancelled'), { name: 'AbortError' });

class Mp4Cache {
  constructor({ directory = process.env.VACUUMFLIX_CACHE_DIR || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'vacuumflix', 'decrypted-mp4'), maxBytes = MAX_BYTES, log = () => {} } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES) throw new Error('MP4 cache limit must be at most 10 GB');
    this.directory = directory; this.maxBytes = maxBytes; this.log = log;
    this.entries = new Map(); this.jobs = new Map(); this.bytes = 0; this.closed = false;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // One owner per directory keeps the combined limit valid across app instances.
    this.lock = path.join(directory, '.lock');
    const recovery = path.join(directory, '.recovery');
    if (fs.existsSync(recovery)) throw new Error('MP4 cache recovery in progress; try again');
    try { fs.mkdirSync(this.lock, { mode: 0o700 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      fs.mkdirSync(recovery, { mode: 0o700 });
      try {
        let owner;
        try { owner = Number(fs.readFileSync(path.join(this.lock, 'pid'), 'utf8')); } catch {}
        if (owner > 0) {
          try { process.kill(owner, 0); throw new Error('MP4 cache is in use by another app instance'); }
          catch (err) { if (err.code !== 'ESRCH') throw err; }
        } else if (Date.now() - fs.statSync(this.lock).mtimeMs < 60000) throw new Error('MP4 cache is being opened by another app instance');
        fs.rmSync(this.lock, { recursive: true }); fs.mkdirSync(this.lock, { mode: 0o700 });
      } finally { fs.rmdirSync(recovery); }
    }
    try {
      fs.writeFileSync(path.join(this.lock, 'pid'), String(process.pid), { mode: 0o600 });
      for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.(mp4|part)$/.test(name)) continue;
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        if (!stat.isFile()) continue;
        // Clear media is session-only, including after a crash.
        fs.unlinkSync(file);
      }
      this.reserve(0); ACTIVE.add(this);
    } catch (e) { fs.rmSync(this.lock, { recursive: true, force: true }); throw e; }
  }

  reserve(bytes, job) {
    if (bytes > this.maxBytes) throw new Error('MP4 file exceeds the 10 GB cache limit');
    while (this.bytes + bytes > this.maxBytes) {
      const oldest = [...this.entries.entries()].filter(([, e]) => !e.refs).sort((a, b) => a[1].used - b[1].used)[0];
      if (!oldest) throw new Error('MP4 cache exceeds the 10 GB limit; stop playback or select a smaller rendition');
      fs.unlinkSync(oldest[1].file); this.bytes -= oldest[1].size; this.entries.delete(oldest[0]);
    }
    // Reserve before writing, so simultaneous and unknown-length downloads share the cap.
    this.bytes += bytes; if (job) job.reserved += bytes;
  }

  async acquire(url, { signal, onProgress = () => {} } = {}) {
    if (this.closed) throw new Error('MP4 cache is closed');
    if (signal?.aborted) throw abortError();
    const key = crypto.createHash('sha256').update(url).digest('hex');
    let job = this.jobs.get(key), entry = this.entries.get(key);
    if (!entry) {
      if (!job) {
        job = { controller: new AbortController(), waiters: new Set(), reserved: 0 };
        this.jobs.set(key, job);
        job.promise = this.download(url, key, job).finally(() => this.jobs.delete(key));
      }
      let rejectAbort;
      const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
      const waiter = { progress: onProgress };
      const abort = () => rejectAbort(abortError());
      job.waiters.add(waiter); signal?.addEventListener('abort', abort, { once: true });
      try {
        entry = await Promise.race([job.promise, cancelled]);
        // Pin before the waiter yields: another download must not evict it.
        if (signal?.aborted || this.closed) throw abortError();
        entry.refs++;
      } finally {
        signal?.removeEventListener('abort', abort); job.waiters.delete(waiter);
        if (!job.waiters.size) { if (job.entry) job.entry.refs--; else job.controller.abort(); }
      }
    } else entry.refs++;
    entry.used = Date.now(); fs.utimesSync(entry.file, new Date(), new Date());
    let released = false;
    return {
      size: entry.size,
      read(start = 0, end = entry.size - 1) {
        if (released) throw new Error('MP4 cache lease was released');
        if (end < 0) end = entry.size - 1; else end = Math.min(end, entry.size - 1);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) throw new Error('Invalid cached MP4 byte range');
        const data = Buffer.allocUnsafe(end - start + 1), fd = fs.openSync(entry.file, 'r');
        try {
          let offset = 0;
          while (offset < data.length) { const n = fs.readSync(fd, data, offset, data.length - offset, start + offset); if (!n) throw new Error('Incomplete cached MP4'); offset += n; }
        } finally { fs.closeSync(fd); }
        return data;
      },
      release() { if (!released) { released = true; entry.refs--; } },
    };
  }

  async response(url, signal, redirects = 0) {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Unsupported MP4 URL protocol');
    const res = await new Promise((resolve, reject) => {
      const req = (u.protocol === 'https:' ? https : http).get(u, { signal, headers: { 'Accept-Encoding': 'identity' } }, resolve);
      req.setTimeout(30000, () => req.destroy(new Error('MP4 cache download stalled')));
      req.on('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      res.resume();
      if (!res.headers.location || redirects >= 5) throw new Error('MP4 cache redirect limit exceeded');
      return this.response(new URL(res.headers.location, url).href, signal, redirects + 1);
    }
    if (res.statusCode !== 200) { res.resume(); throw new Error('MP4 cache requires a complete HTTP 200 response (received ' + res.statusCode + ')'); }
    return res;
  }

  async download(url, key, job) {
    const partial = path.join(this.directory, key + '.part'), file = path.join(this.directory, key + '.mp4');
    let res;
    try {
      res = await this.response(url, job.controller.signal);
      const declared = res.headers['content-length'];
      const total = declared === undefined ? null : Number(declared);
      if (total !== null && (!Number.isSafeInteger(total) || total < 12)) throw new Error('Invalid MP4 content length');
      if (total !== null) this.reserve(total, job);
      let size = 0, prefix = Buffer.alloc(0), lastLog = 0;
      const meter = new Transform({ transform: (chunk, _, callback) => {
        try {
          if (this.closed) throw abortError();
          if (size + chunk.length > job.reserved) this.reserve(size + chunk.length - job.reserved, job);
          size += chunk.length;
          if (prefix.length < 12) prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)]);
          if (prefix.length >= 12 && prefix.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Download is not an MP4 file');
          for (const w of job.waiters) { try { w.progress(size, total); } catch {} }
          if (Date.now() - lastLog > 5000) { lastLog = Date.now(); this.log('Buffering MP4: ' + Math.round(size / 1e6) + ' MB' + (total === null ? '' : ' / ' + Math.round(total / 1e6) + ' MB')); }
          callback(null, chunk);
        } catch (e) { callback(e); }
      } });
      await pipeline(res, meter, new (require('./decrypt-mp4').DecryptMp4)(), fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: job.controller.signal });
      if (size < 12 || (total !== null && size !== total)) throw new Error('Incomplete MP4 download');
      if (this.closed || job.controller.signal.aborted) throw abortError();
      fs.renameSync(partial, file);
      const entry = { file, size, refs: 1, used: Date.now() }; job.entry = entry;
      this.entries.set(key, entry); this.bytes -= job.reserved - size; job.reserved = 0;
      this.log('Decrypted MP4 ready: ' + Math.round(size / 1e6) + ' MB'); return entry;
    } catch (e) {
      res?.destroy(); fs.rmSync(partial, { force: true }); this.bytes -= job.reserved; job.reserved = 0; throw e;
    }
  }

  close() {
    if (this.closed) return this.closing;
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    // Remove completed clear files synchronously, including during process exit.
    for (const entry of this.entries.values()) { fs.rmSync(entry.file, { force: true }); this.bytes -= entry.size; }
    this.entries.clear();
    // Do not release ownership until asynchronous writers have closed.
    const release = () => {
      for (const entry of this.entries.values()) fs.rmSync(entry.file, { force: true });
      this.entries.clear(); this.bytes = 0;
      fs.rmSync(this.lock, { recursive: true, force: true }); ACTIVE.delete(this); };
    if (this.jobs.size) this.closing = Promise.allSettled([...this.jobs.values()].map(j => j.promise)).then(release);
    else { release(); this.closing = Promise.resolve(); }
    return this.closing;
  }
}
module.exports = { Mp4Cache, MAX_BYTES };
