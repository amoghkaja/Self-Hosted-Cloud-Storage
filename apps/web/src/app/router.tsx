import { createBrowserRouter, isRouteErrorResponse, Navigate, useRouteError } from 'react-router';
import { ErrorState } from '../components/ui';
import { LoginPage } from '../features/auth/LoginPage';
import { AcceptInvitePage, SetupPage } from '../features/auth/SetupPage';
import { FilesPage } from '../features/files/FileBrowser';
import { SearchPage, SharedPage, TrashPage } from '../features/files/OtherViews';
import { AppShell } from './AppShell';
import { NotFound, RequireAdmin, RequireAuth } from './guards';

function RouteError() {
  const err = useRouteError();
  const chunkFailed =
    err instanceof Error &&
    /Failed to fetch dynamically imported module|Importing a module script failed/.test(
      err.message,
    );
  return (
    <ErrorState
      title={
        chunkFailed
          ? 'Family Cloud was updated'
          : isRouteErrorResponse(err)
            ? `${err.status} ${err.statusText}`
            : 'Something went wrong'
      }
      error={chunkFailed ? 'Reload to get the latest version.' : err}
      onRetry={() => window.location.reload()}
    />
  );
}

// Admin, settings and the public link page are split into their own chunks: most visits
// never need them, so the main bundle stays small.
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  { path: '/setup', element: <SetupPage />, errorElement: <RouteError /> },
  { path: '/invite/:token', element: <AcceptInvitePage />, errorElement: <RouteError /> },
  {
    path: '/s/:token',
    lazy: () =>
      import('../features/public/PublicLinkPage').then((m) => ({ Component: m.PublicLinkPage })),
    errorElement: <RouteError />,
  },
  {
    path: '/',
    element: <RequireAuth>{(me) => <AppShell me={me} />}</RequireAuth>,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/files" replace /> },
      { path: 'files', element: <FilesPage /> },
      { path: 'files/:folderId', element: <FilesPage /> },
      { path: 'shared', element: <SharedPage /> },
      {
        path: 'shared-by-me',
        lazy: () =>
          import('../features/sharing/SharedByMePage').then((m) => ({
            Component: m.SharedByMePage,
          })),
      },
      { path: 'trash', element: <TrashPage /> },
      {
        path: 'photos',
        lazy: () =>
          import('../features/photos/PhotosPage').then((m) => ({ Component: m.PhotosPage })),
      },
      {
        path: 'photos/:albumId',
        lazy: () =>
          import('../features/photos/AlbumPage').then((m) => ({ Component: m.AlbumPage })),
      },
      { path: 'search', element: <SearchPage /> },
      {
        path: 'settings',
        lazy: () =>
          import('../features/settings/SettingsPage').then((m) => ({ Component: m.SettingsPage })),
      },
      {
        path: 'admin',
        lazy: () =>
          import('../features/admin/AdminPage').then((m) => ({
            Component: () => (
              <RequireAdmin>
                <m.AdminPage />
              </RequireAdmin>
            ),
          })),
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
