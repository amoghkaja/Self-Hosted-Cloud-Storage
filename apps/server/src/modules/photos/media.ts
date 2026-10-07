import { sql } from 'drizzle-orm';
import { nodes } from '../../db/schema';

/**
 * What an album shows: photos and videos only. Anything else dropped into a trip folder stays out,
 * and so do the "._" files macOS writes beside every file it copies to the network drive (named
 * like the photo, but holding Finder's metadata).
 */
export const MEDIA = sql`((${nodes.mimeType} LIKE 'image/%' OR ${nodes.mimeType} LIKE 'video/%')
  AND NOT starts_with(${nodes.name}::text, '._'))`;
