import type {
  AdminInvite,
  AdminOverview,
  AdminUser,
  AppPassword,
  AuditPage,
  CreateAppPasswordResponse,
  DirectoryUser,
  FileNode,
  LoginResponse,
  Me,
  NodeDetail,
  NodePage,
  SessionInfo,
  Settings,
  Share,
  SharedWithMeItem,
  ShareLink,
  SharePermission,
  SortDir,
  SortKey,
  TrashList,
  UserRole,
  Volume,
  VolumeCandidate,
} from '@familycloud/shared';
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from './client';

/**
 * Query keys in one place so invalidation stays correct as features grow. Children are keyed
 * by folder so a change in one folder never refetches others.
 */
export const qk = {
  me: ['me'] as const,
  setup: ['setup-status'] as const,
  node: (id: string) => ['node', id] as const,
  children: (id: string) => ['children', id] as const,
  childrenSorted: (id: string, sort: SortKey, dir: SortDir) => ['children', id, sort, dir] as const,
  trash: ['trash'] as const,
  shared: ['shared-with-me'] as const,
  search: (q: string) => ['search', q] as const,
  shares: (id: string) => ['shares', id] as const,
  links: (id: string) => ['links', id] as const,
  directory: ['directory'] as const,
  sessions: ['sessions'] as const,
  appPasswords: ['app-passwords'] as const,
  admin: ['admin'] as const,
  adminOverview: ['admin', 'overview'] as const,
  adminInvites: ['admin', 'invites'] as const,
  adminCandidates: ['admin', 'candidates'] as const,
  adminAudit: ['admin', 'audit'] as const,
};

// ── session ─────────────────────────────────────────────────────────────────

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: () => api<Me>('/auth/me', { quiet401: true }),
    retry: false,
    staleTime: 30_000,
  });
}

export function useSetupStatus() {
  return useQuery({
    queryKey: qk.setup,
    queryFn: () => api<{ needsSetup: boolean; appName: string }>('/auth/setup-status'),
    staleTime: 5 * 60_000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      api<LoginResponse>('/auth/login', { json: body }),
    onSuccess: (res) => {
      if (res.status === 'ok') qc.setQueryData(qk.me, res.user);
    },
  });
}

export function useLoginTotp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { mfaToken: string; code: string }) =>
      api<LoginResponse>('/auth/login/totp', { json: body }),
    onSuccess: (res) => {
      if (res.status === 'ok') qc.setQueryData(qk.me, res.user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST', json: {} }),
    onSettled: () => {
      qc.clear();
    },
  });
}

// ── files ───────────────────────────────────────────────────────────────────

export function useNode(id: string | undefined) {
  return useQuery({
    queryKey: qk.node(id ?? ''),
    queryFn: () => api<NodeDetail>(`/nodes/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useChildren(id: string | undefined, sort: SortKey, dir: SortDir) {
  return useInfiniteQuery({
    queryKey: qk.childrenSorted(id ?? '', sort, dir),
    queryFn: ({ pageParam, signal }) =>
      api<NodePage>(`/nodes/${id}/children`, {
        query: { cursor: pageParam, sort, dir, limit: 200 },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!id,
    staleTime: 30_000,
  });
}

/** Applies `fn` to every cached page of a folder listing (optimistic updates). */
export function patchChildren(
  qc: QueryClient,
  folderId: string,
  fn: (items: FileNode[]) => FileNode[],
) {
  qc.setQueriesData<InfiniteData<NodePage>>({ queryKey: qk.children(folderId) }, (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, items: fn(p.items) })) } : data,
  );
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { parentId: string; name: string }) =>
      api<FileNode>('/folders', { json: body }),
    onSuccess: (_n, vars) => qc.invalidateQueries({ queryKey: qk.children(vars.parentId) }),
  });
}

export function useUpdateNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      parentId?: string;
      fromParentId: string;
    }) =>
      api<FileNode>(`/nodes/${id}`, {
        method: 'PATCH',
        json: { name: body.name, parentId: body.parentId },
      }),
    onMutate: ({ id, name, parentId, fromParentId }) => {
      // Optimistic: rename in place, or drop from the list when moved away.
      patchChildren(qc, fromParentId, (items) =>
        parentId && parentId !== fromParentId
          ? items.filter((n) => n.id !== id)
          : items.map((n) => (n.id === id && name ? { ...n, name } : n)),
      );
    },
    onSettled: (_d, _e, vars) => {
      void qc.invalidateQueries({ queryKey: qk.children(vars.fromParentId) });
      if (vars.parentId) void qc.invalidateQueries({ queryKey: qk.children(vars.parentId) });
      void qc.invalidateQueries({ queryKey: qk.node(vars.id) });
    },
  });
}

export function useTrashNodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids }: { ids: string[]; parentId: string }) => {
      for (const id of ids) await api(`/nodes/${id}`, { method: 'DELETE' });
    },
    onMutate: ({ ids, parentId }) => {
      const gone = new Set(ids);
      patchChildren(qc, parentId, (items) => items.filter((n) => !gone.has(n.id)));
    },
    onSettled: (_d, _e, vars) => {
      void qc.invalidateQueries({ queryKey: qk.children(vars.parentId) });
      void qc.invalidateQueries({ queryKey: qk.trash });
    },
  });
}

export function useSearch(q: string) {
  return useQuery({
    queryKey: qk.search(q),
    queryFn: ({ signal }) => api<{ items: FileNode[] }>('/search', { query: { q }, signal }),
    enabled: q.trim().length > 0,
    staleTime: 10_000,
  });
}

// ── trash ───────────────────────────────────────────────────────────────────

export function useTrash() {
  return useQuery({ queryKey: qk.trash, queryFn: () => api<TrashList>('/trash') });
}

export function useRestore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ node: FileNode }>(`/trash/${id}/restore`, { method: 'POST', json: {} }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.trash });
      if (res.node.parentId)
        void qc.invalidateQueries({ queryKey: qk.children(res.node.parentId) });
    },
  });
}

export function usePurge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string | 'all') =>
      api(id === 'all' ? '/trash' : `/trash/${id}`, { method: 'DELETE' }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.trash });
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

// ── sharing ─────────────────────────────────────────────────────────────────

export function useSharedWithMe() {
  return useQuery({
    queryKey: qk.shared,
    queryFn: () => api<{ items: SharedWithMeItem[] }>('/shared-with-me'),
  });
}

export function useDirectory() {
  return useQuery({
    queryKey: qk.directory,
    queryFn: () => api<{ items: DirectoryUser[] }>('/users/directory'),
    staleTime: 5 * 60_000,
  });
}

export function useShares(nodeId: string) {
  return useQuery({
    queryKey: qk.shares(nodeId),
    queryFn: () => api<{ items: Share[] }>(`/nodes/${nodeId}/shares`),
  });
}

export function useShareMutations(nodeId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.shares(nodeId) });
  return {
    add: useMutation({
      mutationFn: (body: { userId: string; permission: SharePermission }) =>
        api<Share>(`/nodes/${nodeId}/shares`, { json: body }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, permission }: { id: string; permission: SharePermission }) =>
        api<Share>(`/shares/${id}`, { method: 'PATCH', json: { permission } }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/shares/${id}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
  };
}

export function useLinks(nodeId: string) {
  return useQuery({
    queryKey: qk.links(nodeId),
    queryFn: () => api<{ items: ShareLink[] }>(`/nodes/${nodeId}/links`),
  });
}

export function useLinkMutations(nodeId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.links(nodeId) });
  return {
    create: useMutation({
      mutationFn: (body: {
        password?: string;
        expiresAt?: string | null;
        allowDownload: boolean;
      }) => api<ShareLink>(`/nodes/${nodeId}/links`, { json: body }),
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: (id: string) => api(`/links/${id}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
  };
}

// ── account settings ────────────────────────────────────────────────────────

export function useSessions() {
  return useQuery({
    queryKey: qk.sessions,
    queryFn: () => api<{ items: SessionInfo[] }>('/auth/sessions'),
  });
}

export function useAppPasswords() {
  return useQuery({
    queryKey: qk.appPasswords,
    queryFn: () => api<{ items: AppPassword[] }>('/auth/app-passwords'),
  });
}

export function useAppPasswordMutations() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.appPasswords });
  return {
    create: useMutation({
      mutationFn: (name: string) =>
        api<CreateAppPasswordResponse>('/auth/app-passwords', { json: { name } }),
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: (id: string) => api(`/auth/app-passwords/${id}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
  };
}

// ── admin ───────────────────────────────────────────────────────────────────

export function useAdminOverview() {
  return useQuery({
    queryKey: qk.adminOverview,
    queryFn: () => api<AdminOverview>('/admin/overview'),
    // Drains and uploads change numbers in the background; keep the dashboard fresh.
    refetchInterval: (q) =>
      q.state.data?.volumes.some((v) => v.status === 'draining') ? 5_000 : 60_000,
  });
}

export function useAdminInvites() {
  return useQuery({
    queryKey: qk.adminInvites,
    queryFn: () => api<{ items: AdminInvite[] }>('/admin/invites'),
  });
}

export function useVolumeCandidates(enabled: boolean) {
  return useQuery({
    queryKey: qk.adminCandidates,
    queryFn: () => api<{ root: string; items: VolumeCandidate[] }>('/admin/volumes/candidates'),
    enabled,
  });
}

export function useAudit() {
  return useInfiniteQuery({
    queryKey: qk.adminAudit,
    queryFn: ({ pageParam }) =>
      api<AuditPage>('/admin/audit', { query: { before: pageParam, limit: 50 } }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useAdminMutations() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.admin });
  return {
    updateUser: useMutation({
      mutationFn: ({
        id,
        ...body
      }: {
        id: string;
        quotaBytes?: number | null;
        role?: UserRole;
        disabled?: boolean;
      }) => api<AdminUser>(`/admin/users/${id}`, { method: 'PATCH', json: body }),
      onSuccess: refresh,
    }),
    resetTotp: useMutation({
      mutationFn: (id: string) =>
        api(`/admin/users/${id}/reset-totp`, { method: 'POST', json: {} }),
      onSuccess: refresh,
    }),
    signOut: useMutation({
      mutationFn: (id: string) => api(`/admin/users/${id}/sign-out`, { method: 'POST', json: {} }),
    }),
    createInvite: useMutation({
      mutationFn: (body: {
        email?: string | null;
        role: UserRole;
        quotaBytes?: number | null;
        expiresInDays: number;
      }) => api<{ invite: AdminInvite; url: string }>('/admin/invites', { json: body }),
      onSuccess: refresh,
    }),
    revokeInvite: useMutation({
      mutationFn: (id: string) => api(`/admin/invites/${id}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
    addVolume: useMutation({
      mutationFn: (body: {
        name: string;
        path: string;
        capacityLimitBytes?: number | null;
        reserveBytes?: number;
      }) => api<Volume>('/admin/volumes', { json: body }),
      onSuccess: refresh,
    }),
    updateVolume: useMutation({
      mutationFn: ({
        id,
        ...body
      }: {
        id: string;
        name?: string;
        status?: 'active' | 'readonly';
        capacityLimitBytes?: number | null;
        reserveBytes?: number;
      }) => api<Volume>(`/admin/volumes/${id}`, { method: 'PATCH', json: body }),
      onSuccess: refresh,
    }),
    drain: useMutation({
      mutationFn: (id: string) =>
        api<Volume>(`/admin/volumes/${id}/drain`, { method: 'POST', json: {} }),
      onSuccess: refresh,
    }),
    cancelDrain: useMutation({
      mutationFn: (id: string) =>
        api<Volume>(`/admin/volumes/${id}/cancel-drain`, { method: 'POST', json: {} }),
      onSuccess: refresh,
    }),
    updateSettings: useMutation({
      mutationFn: (body: Partial<Settings>) =>
        api<Settings>('/admin/settings', { method: 'PATCH', json: body }),
      onSuccess: refresh,
    }),
  };
}
