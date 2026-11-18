import { type AvatarDesign, renderAvatarSvg } from '@app/shared/demo-seed';
import sharp from 'sharp';

import { processAvatar, type ProcessedAvatar } from '../../shared/uploads/process-image.js';

/*
 * The avatar designs themselves (palette, compositions, `pickAvatarDesign`, `renderAvatarSvg`) live in
 * `@app/shared/demo-seed`, so the GitHub Pages demo draws the same avatars (ADR-0020). This file only rasterises them.
 */

/**
 * Rasterises the design to PNG (the upload pipeline refuses SVG input on purpose, ADR-0010) and stores it the way an
 * upload is stored: `processAvatar` crops to 512 × 512 and re-encodes as WebP.
 */
export async function renderAvatar(design: AvatarDesign): Promise<ProcessedAvatar> {
  const png = await sharp(Buffer.from(renderAvatarSvg(design)))
    .png()
    .toBuffer();
  return processAvatar(png);
}
