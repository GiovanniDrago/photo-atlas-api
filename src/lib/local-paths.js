import fs from 'node:fs';
import { config } from '../config.js';

export function isAllowedLocalPath(filePath) {
  if (!filePath) return false;
  let real;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    return false;
  }
  if (config.localMediaRoots.length === 0) return true;
  return config.localMediaRoots.some((root) => {
    try {
      return real.startsWith(fs.realpathSync(root));
    } catch {
      return false;
    }
  });
}
