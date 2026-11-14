const assert = require('node:assert/strict');
const cp = require('child_process'), fs = require('fs');

if (process.argv[2] !== 'worker') {
  const { test } = require('node:test');
  for (const mode of ['clear', 'widevine', 'rgba', 'retry', 'retry-partial']) {
    test('video pipeline: ' + mode, () => {
      const result = cp.spawnSync(process.execPath, [__filename, 'worker', mode], { encoding: 'utf8', timeout: 12000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
} else {
  (async () => {
    const mode = process.argv[3], count = 8, w = 16, h = 16, frameSize = w * h * 3 / 2;
    process.env.VACUUMFLIX_HWACCEL = 'off';
    if (mode === 'rgba') process.env.VACUUMFLIX_GPU_VIDEO = '0';
    const encoded = cp.spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=16x16:r=24',
      '-frames:v', String(count), '-c:v', 'libx264', '-bf', '0', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1']);
    assert.equal(encoded.status, 0, String(encoded.stderr));
    const mp4 = encoded.stdout;
    let boundary = 0;
    while (mp4.toString('ascii', boundary + 4, boundary + 8) !== 'moof') boundary += mp4.readUInt32BE(boundary);
    const init = Buffer.from(mp4.subarray(0, boundary)), frag = mp4.subarray(boundary);
    let attempts = 0;
    if (mode.startsWith('retry')) {
      const gpu = require('../runtime/gpu');
      gpu.videoAcceleration = () => ({ enabled: true, env: process.env, input: ['-hwaccel', 'vaapi'] });
      const spawn = cp.spawn;
      cp.spawn = (bin, args, opts) => {
        if (args.includes('-hwaccel')) {
          attempts++;
          // Reproduce both initialization failure and failure after one frame.
          return spawn(process.execPath, ['-e', mode === 'retry-partial' ? `process.stdout.write(Buffer.alloc(${frameSize})); process.exitCode=1` : 'process.exit(1)'], opts);
        }
        return spawn(bin, args, opts);
      };
    }
    if (mode === 'widevine') {
      init.write('encv', init.indexOf('avc1'));
      const bridge = require('../runtime/cdmbridge');
      const plane = Buffer.concat([Buffer.alloc(w*h,81), Buffer.alloc(w*h/4,90), Buffer.alloc(w*h/4,240)]);
      bridge.call = async op => {
        if (op === bridge.OP.SET_INIT) return { status: 0, rets: [init, Buffer.alloc(16), Buffer.from('16x16')] };
        assert.equal(op, bridge.OP.VDEC_SEG);
        const header = Buffer.alloc(8); header.writeUInt32BE(w); header.writeUInt32BE(h,4);
        return { status: 0, rets: [Buffer.concat(Array.from({ length: count }, () => Buffer.concat([header, plane]))), Buffer.from('8,8')] };
      };
    }
    const media = require('../runtime/media')({ mlog() {}, mono: Date.now, logProxy(_, obj) { obj.emit = () => {}; obj.addListener = () => {}; return obj; } });
    const player = await new Promise(resolve => media.factory.createPlayer(process.pid, r => resolve(r.player)));
    const sid = media.base.createMediaSource(null, player.path).sourceid;
    const bid = media.base.createSourceBuffers(sid, [1]).bufferids[0];
    media.base.attachDataToSourceBuffer(init, sid, bid);
    media.base.attachDataToSourceBuffer(frag, sid, bid); media.base.endOfStream(bid);
    player.open({ videoAttributes: { frameRateValue: 24 } }); player.play();
    const file = '/dev/shm/gibbon_video_' + process.pid + '.rgba';
    try {
      const start = Date.now(); let frame;
      while (Date.now() - start < 7000) {
        try { frame = fs.readFileSync(file); if (frame.readUInt32LE(8) === count) break; } catch {}
        await new Promise(r => setTimeout(r, 20));
      }
      assert(frame, 'a frame was presented'); assert.equal(frame.readUInt32LE(8), count, 'all frames presented once');
      assert.equal(frame.readUInt32LE(0), mode === 'rgba' ? w : (0x80000000 + w));
      assert.equal(frame.length, 12 + (mode === 'rgba' ? w*h*4 : frameSize));
      if (mode === 'widevine') assert.equal(frame[12], 81, 'Widevine planar pixels pass through unchanged');
      if (mode.startsWith('retry')) assert.equal(attempts, 1);
      console.log(mode + ' passed');
    } finally {
      media.closeAll(); for (const suffix of ['', '.last', '.tmp']) { try { fs.unlinkSync(file + suffix); } catch {} }
    }
  })().catch(e => { console.error(e); process.exitCode = 1; });
}
