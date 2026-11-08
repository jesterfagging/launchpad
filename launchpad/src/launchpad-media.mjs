import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { requireValue as ok } from '../public/launchpad-model.mjs';
import { platformBrand, platformLogoFile } from './launchpad-branding.mjs';
import { publicOrigin } from './brand.mjs';

export const MAX_LAUNCH_IMAGE = 96 * 1024;
// A coin without a website of its own links to its page on this launchpad (LAUNCHPAD_PUBLIC_URL).
export function launchCoinWebsite(mint, publicUrl = '') {
  let origin;
  try { origin = new URL(publicUrl || publicOrigin()); } catch {}
  ok(origin?.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'LAUNCHPAD_PUBLIC_URL must be an HTTPS origin for the coin website.');
  let address;
  try { address = typeof mint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) && new PublicKey(mint).toBase58(); } catch {}
  ok(address && address === mint, 'The coin website requires the prepared token mint.');
  const url = new URL('/coin', origin.origin); url.searchParams.set('mint', address);
  return url.href;
}
function storageDocumentId(value) {
  if (typeof value !== 'string') return false;
  // Current Irys data items encode their 32-byte digest in base58. Older
  // uploaders use base64url. Keep the ID exactly as signed by the SDK.
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    const bytes = bs58.decode(value);
    if (bytes.length === 32 && bs58.encode(bytes) === value) return true;
  }
  return /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value,'base64url').toString('base64url') === value;
}
function storageSigner(input, keys) {
  const wallet = input?.walletMode === 'external' ? keys.platform : keys.payer || keys.wallet;
  ok(wallet?.secret, 'The image-storage signing wallet is missing. Create a new launch review.');
  return wallet.secret;
}
export function inspectLaunchImage(encoded) {
  ok(typeof encoded === 'string' && encoded.length <= Math.ceil(MAX_LAUNCH_IMAGE/3)*4 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), 'Choose a PNG, JPEG or WebP image.');
  const bytes = Buffer.from(encoded,'base64');
  ok(bytes.toString('base64') === encoded && bytes.length >= 24 && bytes.length <= MAX_LAUNCH_IMAGE, 'The image could not be optimized. Choose a smaller image.');
  let ext, width, height;
  if (bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) {
    ok(bytes.length >= 57 && bytes.toString('ascii',12,16) === 'IHDR' && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii',bytes.length-8,bytes.length-4) === 'IEND', 'Invalid PNG image.');
    [ext,width,height] = ['png',bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    ext = 'jpg'; let at = 2;
    while (at+4 <= bytes.length) {
      ok(bytes[at++] === 255, 'Invalid JPEG image.'); while (bytes[at] === 255) at++;
      const marker = bytes[at++]; if (marker === 218 || marker === 217) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      const size = bytes.readUInt16BE(at); ok(size >= 2 && at+size <= bytes.length, 'Invalid JPEG image.');
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { ok(size >= 8, 'Invalid JPEG image.'); height = bytes.readUInt16BE(at+3); width = bytes.readUInt16BE(at+5); break; }
      at += size;
    }
  } else if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') {
    ok(bytes.readUInt32LE(4)+8 === bytes.length, 'Invalid WebP image.'); ext = 'webp';
    const kind = bytes.toString('ascii',12,16);
    if (kind === 'VP8X' && bytes.length >= 30) { width = bytes.readUIntLE(24,3)+1; height = bytes.readUIntLE(27,3)+1; }
    else if (kind === 'VP8 ' && bytes.length >= 30 && bytes.toString('hex',23,26) === '9d012a') { width = bytes.readUInt16LE(26)&16383; height = bytes.readUInt16LE(28)&16383; }
    else if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 47) { const value = bytes.readUInt32LE(21); width = (value&16383)+1; height = ((value>>>14)&16383)+1; }
  }
  ok(ext && width > 0 && height > 0 && width <= 4096 && height <= 4096 && width*height <= 16777216, 'Choose a valid PNG, JPEG or WebP image up to 4096 × 4096.');
  return {bytes,width,height,type:ext === 'jpg' ? 'image/jpeg' : 'image/'+ext,id:createHash('sha256').update(bytes).digest('hex')+'.'+ext};
}

// Signed storage items are prepared once and retained with the launch journal.
// Retrying an upload uses the same ID. The SDK's fund()/sendTx() is never used:
// any SOL storage payment follows Launchpad's normal confirmed-receipt pipeline.
export class LaunchMetadataStorage {
  constructor({clientFactory} = {}) { this.clientFactory = clientFactory; }
  async client(secret) {
    if (this.clientFactory) return this.clientFactory(secret);
    const [{Uploader},{Solana}] = await Promise.all([import('@irys/upload'),import('@irys/upload-solana')]);
    return Uploader(Solana).withWallet(secret).mainnet().timeout(10000);
  }
  async prepare(input, keys, image, {publicUrl = ''} = {}) {
    // Derive this only for fresh signed metadata. Keep creator input untouched:
    // reusing a failed draft must get its new mint's page, not the old mint's.
    const links = {...input.links};
    if (!String(links.website || '').trim()) links.website = launchCoinWebsite(keys.mint?.address, publicUrl);
    const client = await this.client(storageSigner(input, keys)), items = [];
    const item = async (data,type) => {
      const tx = client.createTransaction(data,{tags:[{name:'Content-Type',value:type},{name:'App-Name',value:platformBrand().name}]}); await tx.sign();
      ok(storageDocumentId(tx.id), 'Image storage returned an invalid document ID.');
      const price = BigInt((await tx.getPrice()).toFixed(0)); ok(price >= 0n, 'Invalid storage estimate.');
      items.push({id:tx.id,raw:tx.getRaw().toString('base64'),price:price.toString(),state:'prepared'});
      return 'https://gateway.irys.xyz/'+tx.id;
    };
    const imageUrl = await item(image.bytes,image.type);
    const metadata = {name:input.name,symbol:input.symbol,description:input.description,image:imageUrl,...links,external_url:links.website,extensions:{...links},
      properties:{files:[{uri:imageUrl,type:image.type}],category:'image',launchpad:{name:platformBrand().name,url:platformBrand().web}}};
    const uri = await item(Buffer.from(JSON.stringify(metadata)),'application/json');
    // Platform branding is a separate public asset; the creator's coin image
    // must not become Launchpad's logo. Persist it with the same upload journal so
    // a localhost install never produces an inaccessible platform image URL.
    // A white-label launchpad uploads its own logo (src/launchpad-branding.mjs platformLogoFile); without one the platform
    // image is the launchpad's own address for its mark.
    const logoFile = platformLogoFile();
    const platformLogo = logoFile ? await readFile(logoFile) : null;
    const platformLogoSha256 = platformLogo ? createHash('sha256').update(platformLogo).digest('hex') : '';
    const platformImage = platformLogo ? await item(platformLogo,'image/png') : '';
    const price = items.reduce((n,x)=>n+BigInt(x.price),0n), budget = price ? (price*125n+99n)/100n : 0n;
    ok(budget <= 5000000n, 'Image storage is unusually expensive right now. Try again later.');
    const recipient = budget ? new PublicKey(await client.utils.getBundlerAddress('solana')).toBase58() : '';
    if (recipient) ok(PublicKey.isOnCurve(new PublicKey(recipient).toBytes()), 'Invalid image-storage payment address.');
    return {uri,imageUrl,metadata,storage:{provider:'irys',recipient,budget:budget.toString(),platformImage,platformLogoSha256,items}};
  }
  async upload(launch, persist, stopped = () => false) {
    const s = launch.storage; ok(s?.provider === 'irys', 'Image storage preparation is missing.');
    const client = await this.client(storageSigner(launch.input, launch.keys));
    if (BigInt(s.budget) > 0n && !s.credited) {
      const op = launch.operations.find(x=>x.kind === 'storage-fund' && x.state === 'confirmed');
      ok(op, 'Waiting for the image-storage payment to confirm.');
      if (stopped()) return false;
      await client.funder.submitFundTransaction(op.signature); s.credited = true; await persist();
    }
    for (const item of s.items) {
      if (item.state === 'uploaded') continue;
      const tx = client.transaction.fromRaw(Buffer.from(item.raw,'base64'));
      ok(storageDocumentId(item.id) && tx.id === item.id && await tx.isValid(), 'Saved image-storage signature failed validation.');
      if (stopped()) return false;
      const result = await tx.upload({getReceiptSignature:true});
      ok(result?.id === item.id && await client.verifyReceipt(result), 'Image storage did not return a valid signed receipt.');
      item.state = 'uploaded'; item.receipt = result; delete item.raw; await persist();
    }
    return true;
  }
}
