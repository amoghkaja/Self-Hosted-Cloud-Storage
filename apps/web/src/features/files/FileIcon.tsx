import { type FileKind, fileKind } from '@familycloud/shared';
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Presentation,
} from 'lucide-react';
import { memo, useState } from 'react';
import { cn } from '../../lib/cn';

const ICONS: Record<FileKind, typeof File> = {
  folder: Folder,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  text: FileText,
  code: FileCode,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  archive: FileArchive,
  other: File,
};

const TINTS: Partial<Record<FileKind, string>> = {
  folder: 'text-accent',
  image: 'text-kind-image',
  video: 'text-kind-video',
  audio: 'text-kind-audio',
  pdf: 'text-danger',
  spreadsheet: 'text-success',
  presentation: 'text-warning',
};

export interface NodeVisual {
  type: 'folder' | 'file';
  name: string;
  mimeType: string | null;
  thumb: 'none' | 'pending' | 'ready' | 'failed' | 'unsupported';
}

export function kindOf(n: Pick<NodeVisual, 'type' | 'mimeType' | 'name'>): FileKind {
  return n.type === 'folder' ? 'folder' : fileKind(n.mimeType, n.name);
}

/**
 * Thumbnail when the worker has made one, otherwise a type icon. Images are lazy-loaded and
 * decoded off the main thread; a failed load falls back to the icon without layout shift.
 */
export const FileIcon = memo(function FileIcon({
  node,
  thumbSrc,
  size = 'sm',
  className,
}: {
  node: NodeVisual;
  thumbSrc?: string;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const kind = kindOf(node);
  const Icon = ICONS[kind];
  if (thumbSrc && node.thumb === 'ready' && !broken) {
    return (
      <img
        src={thumbSrc}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setBroken(true)}
        className={cn('object-cover', size === 'sm' ? 'size-9 rounded-md' : 'size-full', className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center',
        size === 'sm' ? 'size-9 rounded-md bg-surface-2' : 'size-full bg-surface-2',
        TINTS[kind],
        className,
      )}
    >
      <Icon size={size === 'sm' ? 20 : 44} strokeWidth={1.75} />
    </span>
  );
});
