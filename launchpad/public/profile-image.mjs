import {optimizeLaunchImage} from './launch-image.mjs';

export const MAX_PROFILE_FILE_BYTES = 5 * 1024 * 1024;

export function validateProfilePicture(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw Error('Choose a PNG, JPG or WebP profile picture.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) throw Error('Choose a non-empty profile picture.');
  if (file.size > MAX_PROFILE_FILE_BYTES) throw Error('Profile pictures must be 5 MB or smaller.');
  return file;
}

export async function optimizeProfileImage(file, options={}){
  validateProfilePicture(file);
  return optimizeLaunchImage(file,{...options,maxEdge:512});
}
