import type { ReleaseNotes } from '@familycloud/shared/all';

/**
 * Reads CHANGELOG.md's `## version (date)` / `### group` / `- item` structure. Items may wrap
 * over several lines; links are reduced to their text, and sections with no items are left out.
 */
export function parseChangelog(text: string): ReleaseNotes[] {
  const releases: ReleaseNotes[] = [];
  let release: ReleaseNotes | undefined;
  let items: string[] | undefined;
  for (const line of text.split('\n')) {
    const heading = /^## (\S+)(?: \((\d{4}-\d{2}-\d{2})\))?\s*$/.exec(line);
    if (heading) {
      release = { version: heading[1]!, date: heading[2] ?? null, groups: [] };
      releases.push(release);
      items = undefined;
    } else if (line.startsWith('### ') && release) {
      items = [];
      release.groups.push({ title: line.slice(4).trim(), items });
    } else if (line.startsWith('- ') && items) {
      items.push(line.slice(2).trim());
    } else if (/^\s+\S/.test(line) && items?.length) {
      items[items.length - 1] += ` ${line.trim()}`;
    }
  }
  for (const r of releases) {
    for (const g of r.groups)
      g.items = g.items.map((i) => i.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'));
    r.groups = r.groups.filter((g) => g.items.length > 0);
  }
  return releases.filter((r) => r.groups.length > 0);
}
