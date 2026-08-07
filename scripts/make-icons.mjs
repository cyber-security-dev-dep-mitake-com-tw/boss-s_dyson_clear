/**
 * Icon pipeline: design/icon/app-icon-src.jpg (405x720) →
 *   build/icon.png (1024x1024, square-padded), build/icon.icns, build/icon.ico
 * Run: node scripts/make-icons.mjs
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import png2icons from 'png2icons';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'design', 'icon', 'app-icon-src.jpg');
const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });

const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
// Sample the corner pixel to use as the pad background so the square canvas blends in.
const bg = { r: data[0], g: data[1], b: data[2], alpha: 1 };

const png1024 = await sharp(src)
  .resize(1024, 1024, { fit: 'contain', background: bg })
  .png()
  .toBuffer();

fs.writeFileSync(path.join(buildDir, 'icon.png'), png1024);
for (const size of [512, 256]) {
  fs.writeFileSync(
    path.join(buildDir, `icon_${size}.png`),
    await sharp(png1024).resize(size, size).png().toBuffer()
  );
}

const icns = png2icons.createICNS(png1024, png2icons.BILINEAR, 0);
if (!icns) throw new Error('ICNS generation failed');
fs.writeFileSync(path.join(buildDir, 'icon.icns'), icns);

const ico = png2icons.createICO(png1024, png2icons.BILINEAR, 0, false, true);
if (!ico) throw new Error('ICO generation failed');
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);

console.log('Icons written to build/: icon.png, icon_512.png, icon_256.png, icon.icns, icon.ico');
