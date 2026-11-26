import sharp from 'sharp';

// Every uploaded picture is decoded and re-encoded: this strips metadata (GPS, camera data),
// neutralises polyglot files and keeps pages fast on mobile networks.
sharp.cache(false);
sharp.concurrency(1);

const SIZES = {
  logo: { width: 400, height: 400, fit: 'cover', quality: 85 },
  cover: { width: 1600, height: 900, fit: 'cover', quality: 78 },
  banner: { width: 1200, height: 600, fit: 'cover', quality: 80 },
  item: { width: 900, height: 900, fit: 'cover', quality: 78 },
  menu_image: { width: 1800, height: 4000, fit: 'inside', quality: 82 },
};

export const IMAGE_KINDS = Object.keys(SIZES);

/** Returns { bytes, mime, width, height } or throws { code: 'BAD_IMAGE' }. */
export async function processImage(buf, kind) {
  const s = SIZES[kind];
  if (!s) throw new Error(`unknown image kind ${kind}`);
  try {
    const { data, info } = await sharp(buf, { limitInputPixels: 40_000_000, failOn: 'error', animated: false })
      .rotate()                                    // honour EXIF orientation, then drop EXIF
      .resize({ width: s.width, height: s.height, fit: s.fit, withoutEnlargement: true, position: 'attention' })
      .webp({ quality: s.quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, mime: 'image/webp', width: info.width, height: info.height };
  } catch {
    throw Object.assign(new Error('BAD_IMAGE'), { code: 'BAD_IMAGE' });
  }
}
