import { splitExtension } from './names';

const EXT_TO_MIME: Record<string, string> = {
  // images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  // video
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp',
  // audio
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  // documents
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',
  // archives
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
};

const CODE_EXTS = new Set([
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.sh',
  '.yml',
  '.yaml',
  '.toml',
  '.css',
  '.sql',
]);

/**
 * Best-effort MIME type. Browsers often send an empty or generic type (HEIC in Chrome, for
 * example), so the extension wins whenever the client-supplied type is missing or generic.
 */
export function guessMimeType(name: string, clientType?: string | null): string {
  const ext = splitExtension(name)[1].toLowerCase();
  const fromExt = EXT_TO_MIME[ext];
  const client = clientType?.trim().toLowerCase();
  if (client && client !== 'application/octet-stream' && /^[\w.+-]+\/[\w.+-]+$/.test(client)) {
    return client;
  }
  if (fromExt) return fromExt;
  if (CODE_EXTS.has(ext)) return 'text/plain';
  return 'application/octet-stream';
}

export type FileKind =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'text'
  | 'code'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'other';

/** Coarse category used for icons and for picking a preview renderer. */
export function fileKind(mimeType: string | null | undefined, name = ''): FileKind {
  const mime = (mimeType ?? '').toLowerCase();
  const ext = splitExtension(name)[1].toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (CODE_EXTS.has(ext)) return 'code';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return 'text';
  }
  if (mime.includes('spreadsheet') || mime.includes('excel') || ext === '.csv')
    return 'spreadsheet';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'presentation';
  if (mime.includes('word') || mime.includes('opendocument.text') || mime === 'application/rtf')
    return 'document';
  if (/(zip|gzip|tar|7z|rar|compressed)/.test(mime)) return 'archive';
  return 'other';
}

/** Word, Excel and PowerPoint style files: shown as a PDF made by the server (LibreOffice). */
export function isOfficeDocument(mimeType: string | null | undefined, name = ''): boolean {
  const kind = fileKind(mimeType, name);
  return kind === 'document' || kind === 'spreadsheet' || kind === 'presentation';
}
