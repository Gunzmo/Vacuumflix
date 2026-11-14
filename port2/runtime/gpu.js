const fs = require('fs'), path = require('path'), cp = require('child_process');

// Keep the user's libva overrides. Packaged drivers are a fallback for hosts
// without i965; Flatpak's runtime/extension drivers take precedence.
function driverEnvironment(env = process.env) {
  const result = { ...env };
  if (!result.LIBVA_DRIVERS_PATH) {
    const dirs = ['/usr/lib/x86_64-linux-gnu/dri', '/usr/lib64/dri', '/usr/lib/dri',
      '/usr/lib/x86_64-linux-gnu/GL/lib/dri', '/usr/lib/dri/intel-vaapi-driver',
      '/usr/lib/x86_64-linux-gnu/dri/intel-vaapi-driver'];
    if (env.PKG_ROOT) dirs.push(path.join(env.PKG_ROOT, 'sys', 'lib', 'dri'));
    const existing = dirs.filter(d => fs.existsSync(d));
    if (existing.length) result.LIBVA_DRIVERS_PATH = existing.join(':');
  }
  return result;
}

let selected;
function videoAcceleration() {
  if (selected) return selected;
  selected = { input: [], env: driverEnvironment(), enabled: false };
  const mode = process.env.VACUUMFLIX_HWACCEL || 'auto';
  if (mode === 'off') return selected;
  if (!['auto', 'vaapi'].includes(mode)) {
    console.warn('[gpu] Unknown VACUUMFLIX_HWACCEL; using software decoding');
    return selected;
  }
  let devices = [];
  try { devices = fs.readdirSync('/dev/dri').filter(n => /^renderD\d+$/.test(n)).sort().map(n => '/dev/dri/' + n); } catch {}
  if (process.env.VACUUMFLIX_VAAPI_DEVICE) devices = [process.env.VACUUMFLIX_VAAPI_DEVICE];
  for (const device of devices) {
    const drivers = selected.env.LIBVA_DRIVER_NAME ? [selected.env.LIBVA_DRIVER_NAME] : [undefined, 'i965'];
    for (const driver of drivers) {
      const env = { ...selected.env };
      if (driver) env.LIBVA_DRIVER_NAME = driver;
      const probe = cp.spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-init_hw_device', 'vaapi=gpu:' + device,
        '-f', 'lavfi', '-i', 'nullsrc=s=16x16', '-frames:v', '1', '-f', 'null', '-'], { env, timeout: 3000, stdio: 'ignore' });
      if (probe.status !== 0) continue;
      console.log('[gpu] VA-API device=' + device + ' driver=' + (driver || 'auto'));
      selected = { enabled: true, env, input: ['-hwaccel', 'vaapi', '-hwaccel_device', device, '-hwaccel_output_format', 'vaapi'] };
      return selected;
    }
  }
  console.warn('[gpu] VA-API unavailable; using software decoding with GPU video presentation');
  return selected;
}

module.exports = { driverEnvironment, videoAcceleration };
