import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useSyncExternalStore } from 'react';
import { ApiError } from '../api/client';
import { qk } from '../api/queries';
import { httpTransport, UploadManager } from '../api/upload-manager';
import { Announcer, Toaster, TooltipProvider } from '../components/ui';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Retry flaky network/server errors, never 4xx (they won't fix themselves).
      retry: (count, err) =>
        count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});

export const uploadManager = new UploadManager(httpTransport);

// Refresh a folder's listing and the usage meter once uploads into it settle, not per file.
const pendingFolders = new Set<string>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
uploadManager.onFolderChanged = (folderId) => {
  pendingFolders.add(folderId);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const id of pendingFolders)
      void queryClient.invalidateQueries({ queryKey: qk.children(id) });
    pendingFolders.clear();
    void queryClient.invalidateQueries({ queryKey: qk.me });
  }, 400);
};

export function useUploads() {
  return useSyncExternalStore(uploadManager.subscribe, uploadManager.getSnapshot);
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={400}>
        {children}
        <Toaster />
        <Announcer />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
