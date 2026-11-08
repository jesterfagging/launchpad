import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizeLaunchImage, MAX_LAUNCH_IMAGE_BYTES} from '../public/launch-image.mjs';
import {inspectLaunchImage} from '../src/launchpad-media.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=';
const dataUrl = (data = PNG, type = 'image/png') => `data:${type};base64,${data}`;
const file = (extra = {}) => ({type:'image/png', size:Buffer.from(PNG, 'base64').length, ...extra});
function fixture({bitmapFailure = false, noBitmap = false, canvasMissing = false, exportMode = 'png', width = 512, height = 512} = {}) {
  const state = {closed:0, revoked:[], exported:[], draws:[], images:0, decodeCalls:0};
  const ctx = {clearRect(){}, fillRect(){}, drawImage(...args){state.draws.push(args);}};
  const canvas = {getContext:() => canvasMissing ? null : ctx, toBlob(callback, type) {
    state.exported.push(type);
    if (exportMode === 'throw') throw Error('webview encoder unavailable');
    if (exportMode === 'null') return callback(null);
    if (exportMode === 'jpeg-only' && type !== 'image/jpeg') return callback({size:MAX_LAUNCH_IMAGE_BYTES + 1, type:'image/png'});
    callback({size:68, type:exportMode === 'jpeg-only' ? 'image/jpeg' : 'image/png', encoded:dataUrl()});
  }};
  const image = {naturalWidth:width, naturalHeight:height, removeAttribute(){state.closed++;}, set src(value){this.source=value;queueMicrotask(() => this.onload?.());}};
  const document = {createElement(type){if (type === 'canvas') return canvas;if (type === 'img') {state.images++;return image;}throw Error(type);}};
  const deps = {document, URL:{createObjectURL:() => 'blob:local-image', revokeObjectURL:value => state.revoked.push(value)}, createImageBitmap:noBitmap ? null : async () => {state.decodeCalls++;if (bitmapFailure) throw Error('ImageBitmap is unavailable for this photo');return {width,height,close(){state.closed++;}};}, readBlob:async blob => blob.encoded || dataUrl(PNG, blob.type || 'application/octet-stream')};
  return {state, deps, canvas, image};
}

test('mobile decode failures and missing ImageBitmap fall back to HTML image and accept PNG canvas fallback', async () => {
  for (const flags of [{bitmapFailure:true}, {noBitmap:true}]) {
    const f = fixture(flags), result = await optimizeLaunchImage(file(), f.deps);
    assert.equal(result, dataUrl());assert.equal(f.state.images, 1);assert.equal(f.state.closed, 1);
    assert.equal(f.state.draws[0][0], f.image);
    assert.equal(inspectLaunchImage(result.split(',')[1]).type, 'image/png');
  }
});

test('the fallback decoder reads a data: URL, never a blob: URL the page CSP (img-src self data:) would block', async () => {
  for (const flags of [{bitmapFailure:true}, {noBitmap:true}]) {
    const f = fixture(flags);let created = 0;f.deps.URL = {createObjectURL:() => { created++;return 'blob:local-image'; }, revokeObjectURL:value => f.state.revoked.push(value)};
    await optimizeLaunchImage(file(), f.deps);
    assert.match(f.image.source, /^data:image\/png;base64,/);assert.equal(created, 0);assert.deepEqual(f.state.revoked, []);
  }
});

test('missing object URL support decodes an image from a local data URL', async () => {
  const f = fixture({noBitmap:true});f.deps.URL = {};
  await optimizeLaunchImage(file(), f.deps);assert.equal(f.image.source, dataUrl());assert.deepEqual(f.state.revoked, []);
});

test('JPEG encoder is attempted when WebP becomes an oversized PNG', async () => {
  const f = fixture({exportMode:'jpeg-only'});await optimizeLaunchImage(file({size:200000}), f.deps);
  assert.deepEqual(f.state.exported, ['image/webp', 'image/png', 'image/jpeg']);assert.equal(f.state.closed, 1);
});

test('small decoded original survives null/throwing canvas exports and unavailable canvas', async () => {
  for (const flags of [{exportMode:'null'}, {exportMode:'throw'}, {canvasMissing:true}]) {
    const f = fixture(flags), result = await optimizeLaunchImage(file(), f.deps);
    assert.equal(result, dataUrl());assert.equal(inspectLaunchImage(result.split(',')[1]).type, 'image/png');assert.equal(f.state.closed, 1);
  }
});

test('empty and generic MIME are recovered from known raster signatures, never SVG or an arbitrary file', async () => {
  for (const type of ['', 'application/octet-stream']) {
    const f = fixture({canvasMissing:true}), result = await optimizeLaunchImage(file({type}), f.deps);
    assert.equal(result, dataUrl());assert.equal(inspectLaunchImage(result.split(',')[1]).type, 'image/png');
    const bad = fixture({canvasMissing:true});bad.deps.readBlob = async () => dataUrl(Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64'), type);
    await assert.rejects(optimizeLaunchImage(file({type}), bad.deps), /Unable to read/);assert.equal(bad.state.decodeCalls, 0);
  }
});

test('fallback cannot bypass MIME, byte, or pixel limits and always closes the bitmap', async () => {
  for (const type of ['image/svg+xml', 'image/gif', 'image/heic']) await assert.rejects(optimizeLaunchImage(file({type}), fixture().deps), /PNG, JPEG or WebP/);
  for (const size of [0, -1, NaN, 10 * 1024 * 1024 + 1]) await assert.rejects(optimizeLaunchImage(file({size}), fixture().deps), /under 10 MB/);
  for (const options of [{width:5000,height:5000}, {width:5000,height:1}, {width:0,height:1}]) {
    const f = fixture({...options,canvasMissing:true});await assert.rejects(optimizeLaunchImage(file(), f.deps));assert.equal(f.state.closed, 1);
  }
  const large = fixture({canvasMissing:true});await assert.rejects(optimizeLaunchImage(file({size:MAX_LAUNCH_IMAGE_BYTES + 1}), large.deps), /browser could not prepare/);
  const spoof = fixture({canvasMissing:true});spoof.deps.readBlob = async () => dataUrl(Buffer.from('<svg>not PNG</svg>').toString('base64'));
  await assert.rejects(optimizeLaunchImage(file(), spoof.deps), /browser could not prepare/);
});

test('upload endpoint continues to reject spoofed raster bytes and dimensions for original passthrough', () => {
  assert.throws(() => inspectLaunchImage(Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64')));
  assert.throws(() => inspectLaunchImage(Buffer.alloc(MAX_LAUNCH_IMAGE_BYTES + 1).toString('base64')));
  const tooWide = Buffer.from(PNG, 'base64');tooWide.writeUInt32BE(4097, 16);assert.throws(() => inspectLaunchImage(tooWide.toString('base64')), /4096/);
  const incomplete = Buffer.from(PNG, 'base64').subarray(0, 40);assert.throws(() => inspectLaunchImage(incomplete.toString('base64')), /Invalid PNG/);
});
