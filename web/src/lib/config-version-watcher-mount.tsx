/**
 * Runs the page's settings version watcher (`lib/config-versions.ts`) for as
 * long as the application is mounted, with the React Query cache the pages
 * read as the place a changed group is refetched into.
 *
 * The client is handed in rather than read from context: the entry module
 * owns it anyway, and a number of suites mock `@tanstack/react-query` down to
 * the few runtime exports the shell uses.
 */
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";

import { getConfigVersions } from "@/lib/api-client/config-versions";
import { configVersionWatcher, refetchConfigGroup } from "@/lib/config-versions";

export function ConfigVersionWatcherMount({ queryClient }: { readonly queryClient: QueryClient }): null {
  useEffect(() => {
    configVersionWatcher.start({
      fetchVersions: getConfigVersions,
      refetchGroup: (group) => refetchConfigGroup(queryClient, group),
    });
    return () => {
      configVersionWatcher.stop();
    };
  }, [queryClient]);
  return null;
}
