export const MAX_LAUNCH_IMAGE_BYTES = 96 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const READ_ERROR = 'Unable to read this image. Choose a PNG, JPEG or WebP image.';

function readDataUrl(blob, FileReader) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reader.onabort = () => reject(Error(READ_ERROR));
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(file, {document, createImageBitmap, readBlob, setTimeout, clearTimeout}) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch { /* Some mobile webviews cannot decode through ImageBitmap. */ }
  }
  // The fallback decodes a data: URL: the site's CSP (img-src 'self' data:) blocks blob: URLs.
  const image = document.createElement('img');
  try {
    const src = await readBlob(file);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(Error(READ_ERROR)), 15000);
      const done = error => { clearTimeout(timer); image.onload = image.onerror = null; error ? reject(error) : resolve(); };
      image.onload = () => done(); image.onerror = () => done(Error(READ_ERROR)); image.src = src;
    });
    return {source:image, width:image.naturalWidth, height:image.naturalHeight, close(){image.removeAttribute('src');}};
  } catch (error) { image.removeAttribute('src'); throw error; }
}

// Only a decoded, bounded raster can bypass canvas encoding. The upload endpoint
// independently verifies actual file signatures, dimensions and the 96 KB limit;
// declared MIME types and browser decoding are never its trust boundary.
function rasterDataUrl(data, declaredType) {
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match) return null;
  let header; try { header = atob(match[2].slice(0, 44)); } catch { return null; }
  const actual = header.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
    : header.startsWith('\xff\xd8\xff') ? 'image/jpeg'
    : header.slice(0, 4) === 'RIFF' && header.slice(8, 12) === 'WEBP' ? 'image/webp' : null;
  if (!actual || TYPES.includes(declaredType) && actual !== declaredType) return null;
  return `data:${actual};base64,${match[2]}`;
}

async function originalImage(file, bitmap, readBlob) {
  if (file.size > MAX_LAUNCH_IMAGE_BYTES || bitmap.width > 4096 || bitmap.height > 4096) return null;
  return rasterDataUrl(await readBlob(file), file.type);
}

export async function optimizeLaunchImage(file, {
  document = globalThis.document, createImageBitmap = globalThis.createImageBitmap,
  FileReader = globalThis.FileReader,
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
  readBlob = blob => readDataUrl(blob, FileReader),
  maxEdge = 768,
} = {}) {
  if (!file || ![...TYPES, '', 'application/octet-stream'].includes(file.type) || !Number.isFinite(file.size) || file.size <= 0 || file.size > 10 * 1024 * 1024)
    throw Error('Choose a PNG, JPEG or WebP image under 10 MB.');
  if (!TYPES.includes(file.type) && !rasterDataUrl(await readBlob(file), file.type)) throw Error(READ_ERROR);
  if (!Number.isInteger(maxEdge) || maxEdge < 1 || maxEdge > 4096) throw Error('Invalid image output size.');
  const bitmap = await decodeImage(file, {document, createImageBitmap, readBlob, setTimeout, clearTimeout});
  try {
    if (!Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height) || bitmap.width <= 0 || bitmap.height <= 0) throw Error(READ_ERROR);
    if (bitmap.width * bitmap.height > 16777216) throw Error('Choose an image no larger than 16 megapixels.');
    let size = Math.min(maxEdge, Math.max(bitmap.width, bitmap.height));
    try {
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      if (!ctx) throw Error('Canvas is unavailable.');
      for (let pass = 0; pass < 7; pass++) {
        const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        for (const type of ['image/webp', 'image/png', 'image/jpeg']) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
          ctx.drawImage(bitmap.source || bitmap, 0, 0, canvas.width, canvas.height);
          let blob;
          try { blob = await new Promise(resolve => canvas.toBlob(resolve, type, Math.max(.5, .88 - pass * .055))); }
          catch { continue; }
          if (blob && blob.size > 0 && blob.size <= MAX_LAUNCH_IMAGE_BYTES && (!blob.type || TYPES.includes(blob.type))) {
            const data = await readBlob(blob);
            if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) return data;
          }
        }
        size *= .8;
      }
    } catch { /* Keep an already-small, verified raster usable when mobile canvas export fails. */ }
    const original = await originalImage(file, bitmap, readBlob);
    if (original) return original;
    throw Error('This browser could not prepare the image. Try saving it as PNG or JPEG and selecting it again.');
  } finally { bitmap.close?.(); }
}
