// Site display only. Stored creator images and immutable onchain metadata remain unchanged.
import { PLATFORM_TOKEN_MINT } from './platform-token.mjs';
// The platform token (public/platform-token.mjs) shows the platform's own mark; '' when the host has none.
export const OFFICIAL_TOKEN_MINT = PLATFORM_TOKEN_MINT;
export function coinImage(mint, storedImage) {
  if (OFFICIAL_TOKEN_MINT && mint === OFFICIAL_TOKEN_MINT) return '/brand-icon.png?v=54';
  return typeof storedImage === 'string' && /^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(storedImage) ? storedImage : null;
}
