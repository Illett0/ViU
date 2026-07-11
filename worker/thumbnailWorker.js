'use strict';

// Decodes HEIC files to raw bitmap pixels for main.js's
// photos:get-thumbnail handler. Chromium can't decode HEIC at all
// (nativeImage.createFromPath returns empty), so this uses libheif compiled
// to wasm (heic-decode); a 12MP iPhone photo takes on the order of a second
// of pure CPU to decode, which is why it runs here in a worker thread
// instead of on the main process — decoding in main would freeze every
// window and IPC handler for the duration.
//
// Long-lived: main.js spawns one worker lazily on the first HEIC request
// and keeps it around, sending one {id, filePath} message per decode (the
// wasm module init is not free, so a worker-per-request would pay it every
// time). Decodes are effectively serialized inside the worker — the wasm
// decode is synchronous CPU work — which doubles as a natural cap when a
// gallery popup requests a dozen HEIC thumbnails at once.
//
// The reply's pixel buffer is BGRA, matching what Electron's
// nativeImage.createFromBitmap expects on Windows (Chromium's native
// little-endian ARGB32 layout; photos are opaque so premultiplied alpha is
// a non-issue). If the app ever ships on macOS (issue #16), re-verify the
// expected channel order there.

const { parentPort } = require('worker_threads');
const fs = require('fs');
const decode = require('heic-decode');

parentPort.on('message', async ({ id, filePath }) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const { width, height, data } = await decode({ buffer }); // data: Uint8ClampedArray, RGBA
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      data[i] = data[i + 2];
      data[i + 2] = r;
    }
    // Transfer (not copy) the pixel buffer — it's width*height*4 bytes,
    // ~48MB for a 12MP photo.
    parentPort.postMessage({ id, ok: true, width, height, pixels: data.buffer }, [data.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, message: err && err.message ? err.message : String(err) });
  }
});
