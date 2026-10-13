import type { ArticleDocument } from '../types/article-document';

export interface ArchivedMedia {
  id: string;
  source_url: string;
  r2_key: string;
  width: number | null;
  height: number | null;
}

/** Rebuilding prose must retain media already owned by the archive. */
export function restoreArchivedMedia(document: ArticleDocument, media: ArchivedMedia[]): void {
  const bySource = new Map(media.map((row) => [row.source_url, row]));
  for (const image of document.images) {
    if (image.status === 'video') continue;
    const row = bySource.get(image.sourceUrl);
    if (!row) continue;
    // /media resolves the stored row id. Source URL is the stable identity across
    // parser versions; the parser's freshly generated id need not be the stored id.
    const oldId = image.imageId;
    image.imageId = row.id;
    for (const block of document.blocks) {
      if (block.type === 'image' && block.imageId === oldId) block.imageId = row.id;
    }
    image.r2Key = row.r2_key;
    image.status = 'ready';
    if (row.width !== null) image.width = row.width;
    if (row.height !== null) image.height = row.height;
  }
}
