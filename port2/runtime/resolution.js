'use strict';

// The NRDJS player creates this manifest for the streamer at open and when
// adding another viewable. Preserve track indices used by the rest of NRDJS.
const ANCHOR = '_makePlayerManifest:function(e){var t={movieId:e.movieId,duration:e.duration,locations:e.locations,servers:e.servers,video_tracks:e.video_tracks,audio_tracks:e.audio_tracks};';

function patchPlayer(code) {
  const start = code.indexOf(ANCHOR);
  if (start < 0 || code.indexOf(ANCHOR, start + ANCHOR.length) >= 0) {
    throw new Error('720p limit unavailable: unsupported Netflix player version');
  }
  return code.slice(0, start) + ANCHOR + 'globalThis.__limitVideoResolution(t);' + code.slice(start + ANCHOR.length);
}

function limitManifest(manifest) {
  if (!Array.isArray(manifest.video_tracks) || !manifest.video_tracks.length) {
    throw new Error('720p limit: manifest has no video tracks');
  }
  const tracks = manifest.video_tracks.map(track => {
    if (!track || !Array.isArray(track.streams)) throw new Error('720p limit: video track has no stream list');
    const streams = track.streams.filter(stream => {
      const w = Number(stream && (stream.res_w ?? stream.resW));
      const h = Number(stream && (stream.res_h ?? stream.resH));
      return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= 1280 && h <= 720;
    });
    if (!streams.length) throw new Error('720p limit: a video track has no stream at or below 1280x720');
    return { ...track, streams };
  });
  manifest.video_tracks = tracks;
  return manifest;
}

module.exports = { patchPlayer, limitManifest };
