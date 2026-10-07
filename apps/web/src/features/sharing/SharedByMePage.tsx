import type { SharedByMeItem } from '@familycloud/shared';
import { Share2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage, thumbUrl } from '../../api/client';
import { useLinkMutations, useSharedByMe } from '../../api/queries';
import { SHARED_SECTIONS } from '../../app/sections';
import {
  Avatar,
  Button,
  EmptyState,
  QueryState,
  SectionLinks,
  Skeleton,
  toast,
} from '../../components/ui';
import { usePageTitle } from '../../lib/usePageTitle';
import { FileIcon } from '../files/FileIcon';
import { LinkRow, ShareDialog } from './ShareDialog';

function SharedItem({ item }: { item: SharedByMeItem }) {
  const { node, people, links } = item;
  const [managing, setManaging] = useState(false);
  const m = useLinkMutations(node.id);
  const where = node.type === 'folder' ? `/files/${node.id}` : `/files/${node.parentId}`;
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-3">
        <FileIcon node={node} thumbSrc={thumbUrl(node.id, 256, node.updatedAt)} />
        <Link to={where} className="min-w-0 flex-1 truncate font-medium hover:underline">
          {node.name}
        </Link>
        <Button size="sm" onClick={() => setManaging(true)}>
          Manage
        </Button>
      </div>
      {people.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Family members with access">
          {people.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-2 rounded-full bg-surface-2 py-1 pr-3 pl-1 text-sm"
            >
              <Avatar name={p.grantee.displayName} size={24} />
              {p.grantee.displayName}
              <span className="text-muted">
                · {p.permission === 'edit' ? 'can edit' : 'can view'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {links.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Public links">
          {links.map((l) => (
            <LinkRow
              key={l.id}
              link={l}
              title={node.name}
              deleting={m.revoke.isPending && m.revoke.variables === l.id}
              onDelete={() =>
                m.revoke.mutate(l.id, {
                  onSuccess: () => toast.success('Link deleted. It stopped working right away.'),
                  onError: (err) => toast.error(errorMessage(err)),
                })
              }
            />
          ))}
        </ul>
      )}
      {managing && <ShareDialog node={node} onClose={() => setManaging(false)} />}
    </li>
  );
}

/** Everything the user has shared: who can see it, and which links are live and until when. */
export function SharedByMePage() {
  usePageTitle('Shared by me');
  const shared = useSharedByMe();
  return (
    <>
      <SectionLinks label="Shared" items={SHARED_SECTIONS} />
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Shared by me</h1>
        <p className="mt-1 text-sm text-muted">
          Files and folders family members or public links can reach. Deleting an item ends its
          links for good.
        </p>
      </div>
      <QueryState
        query={shared}
        loading={<Skeleton className="h-32" />}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            icon={<Share2 />}
            title="You're not sharing anything"
            description="Use Share on a file or folder to give family access or make a link. It shows up here."
          />
        }
      >
        {(d) => (
          <ul className="flex flex-col gap-3">
            {d.items.map((i) => (
              <SharedItem key={i.node.id} item={i} />
            ))}
          </ul>
        )}
      </QueryState>
    </>
  );
}
