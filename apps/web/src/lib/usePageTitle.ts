import { useEffect } from 'react';
import { useSetupStatus } from '../api/queries';

/** Sets the browser tab title as "<page> · <family's app name>". */
export function usePageTitle(title: string | null | undefined) {
  const appName = useSetupStatus().data?.appName ?? 'Family Cloud';
  useEffect(() => {
    document.title = title ? `${title} · ${appName}` : appName;
  }, [title, appName]);
}
