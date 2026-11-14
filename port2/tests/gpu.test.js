const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), cp = require('child_process');
const modulePath = require.resolve('../runtime/gpu');

function run(env, devices, probe) {
  const savedEnv = process.env, exists = fs.existsSync, readdir = fs.readdirSync, spawn = cp.spawnSync;
  const calls = [];
  try {
    process.env = env;
    fs.existsSync = p => p === '/usr/lib/dri' || p === '/package/sys/lib/dri';
    fs.readdirSync = () => devices;
    cp.spawnSync = (bin, args, opts) => { calls.push({ bin, args, opts }); return { status: probe(opts.env, args) }; };
    delete require.cache[modulePath];
    const gpu = require(modulePath), result = gpu.videoAcceleration();
    assert.equal(gpu.videoAcceleration(), result, 'probe result is cached');
    return { result, calls, gpu };
  } finally { process.env = savedEnv; fs.existsSync = exists; fs.readdirSync = readdir; cp.spawnSync = spawn; }
}

test('off skips probes; no render nodes falls back', () => {
  assert.equal(run({ VACUUMFLIX_HWACCEL: 'off' }, ['renderD128'], () => 0).calls.length, 0);
  assert.equal(run({}, [], () => 0).result.enabled, false);
});
test('tries i965 after libva auto fails, preserving other environment', () => {
  const { result, calls } = run({ PKG_ROOT: '/package', CUSTOM: 'preserved' }, ['card0', 'renderD128'], e => e.LIBVA_DRIVER_NAME === 'i965' ? 0 : 1);
  assert.equal(calls.length, 2); assert.equal(result.enabled, true);
  assert.equal(result.env.LIBVA_DRIVER_NAME, 'i965'); assert.equal(result.env.CUSTOM, 'preserved');
  assert.equal(result.env.LIBVA_DRIVERS_PATH, '/usr/lib/dri:/package/sys/lib/dri');
  assert.deepEqual(result.input, ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi']);
});
test('explicit device and libva overrides are respected', () => {
  const { result, calls } = run({ VACUUMFLIX_VAAPI_DEVICE: '/dev/dri/renderD129', LIBVA_DRIVER_NAME: 'iHD', LIBVA_DRIVERS_PATH: '/custom' }, ['renderD128'], () => 0);
  assert.equal(calls.length, 1); assert.equal(result.env.LIBVA_DRIVERS_PATH, '/custom');
  assert.equal(result.env.LIBVA_DRIVER_NAME, 'iHD'); assert(result.input.includes('/dev/dri/renderD129'));
});
test('failed devices fall back; later render nodes are tried', () => {
  assert.equal(run({}, ['renderD128'], () => 1).result.enabled, false);
  const { result, calls } = run({}, ['renderD128', 'renderD129'], (_, a) => a.includes('vaapi=gpu:/dev/dri/renderD129') ? 0 : 1);
  assert.equal(result.enabled, true); assert.equal(calls.length, 3);
});
