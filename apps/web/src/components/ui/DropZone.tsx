import { CloudUpload } from 'lucide-react';
import { type ComponentProps, type DragEvent, type ReactNode, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

export interface DropZoneProps extends Omit<ComponentProps<'div'>, 'onDrop'> {
  /** Called with the raw DataTransfer so folders can be walked (see collectDroppedFiles). */
  onDrop: (data: DataTransfer) => void;
  disabled?: boolean;
  /** Text on the overlay, e.g. "Drop to upload to Photos". */
  label: string;
  children: ReactNode;
  className?: string;
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * Drag-and-drop target for files and folders. Mouse-only by nature, so it always sits next to
 * a keyboard-accessible Upload button; it never replaces one.
 */
export function DropZone({
  onDrop,
  disabled,
  label,
  children,
  className,
  ...props
}: DropZoneProps) {
  const [active, setActive] = useState(false);
  const depth = useRef(0); // dragenter/leave fire for every child element

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is a mouse enhancement; the Upload button is the accessible path
    <div
      {...props}
      className={cn('relative', className)}
      onDragEnter={(e) => {
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setActive(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        // Even when uploads aren't allowed here, take over the drag: otherwise the browser
        // "drops" by navigating away from the app to open the file.
        e.preventDefault();
        e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDragLeave={() => {
        if (disabled) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (disabled) return;
        depth.current = 0;
        setActive(false);
        onDrop(e.dataTransfer);
      }}
    >
      {children}
      {active && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-accent-soft/80 text-accent backdrop-blur-sm animate-fade-in"
        >
          <CloudUpload size={36} />
          <p className="text-sm font-semibold">{label}</p>
        </div>
      )}
    </div>
  );
}

export interface PickedFile {
  file: File;
  /** Folder path relative to the drop target ("Holiday/Day 1"), or '' for loose files. */
  relativeDir: string;
}

export interface DroppedItems {
  files: PickedFile[];
  /** Folders with nothing in them ("Holiday/Day 3"): the files' folders come with the files. */
  emptyFolders: string[];
}

/** Expands a drop (files and whole folders, recursively) into a flat list with relative paths. */
export async function collectDroppedFiles(data: DataTransfer): Promise<DroppedItems> {
  const entries = Array.from(data.items ?? [])
    .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) {
    return {
      files: Array.from(data.files).map((file) => ({ file, relativeDir: '' })),
      emptyFolders: [],
    };
  }
  const files: PickedFile[] = [];
  const emptyFolders: string[] = [];
  const walk = async (entry: FileSystemEntry, dir: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      );
      files.push({ file, relativeDir: dir });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const childDir = dir ? `${dir}/${entry.name}` : entry.name;
    let empty = true;
    // readEntries returns results in batches; keep reading until it returns nothing.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej),
      );
      if (batch.length === 0) break;
      empty = false;
      for (const child of batch) await walk(child, childDir);
    }
    if (empty) emptyFolders.push(childDir);
  };
  for (const e of entries) await walk(e, '');
  return { files, emptyFolders };
}

/** Files from an <input type="file" webkitdirectory> keep their folder in webkitRelativePath. */
export function filesFromInput(list: FileList): PickedFile[] {
  return Array.from(list).map((file) => {
    const rel = file.webkitRelativePath || '';
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    return { file, relativeDir: dir };
  });
}
