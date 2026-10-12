/** 导航项（Svelte 5 runes）。 */

import { ipc } from '../ipc-client';
import { channels } from '../channels';
import type { RouteDto } from '../bridge-types';

class RoutesStore {
  items = $state<RouteDto[]>([]);
  activePath = $state<string | undefined>(undefined);
  error = $state<string | undefined>(undefined);

  ordered = $derived([...this.items].sort((a, b) => a.order - b.order));
  active = $derived(this.ordered.find((r) => r.path === this.activePath));

  set(list: RouteDto[]): void {
    this.items = list;
    this.activePath ??= list[0]?.path;
    this.error = undefined;
  }

  navigate(path: string): void {
    this.activePath = path;
  }

  async load(): Promise<void> {
    try {
      this.set(await ipc.request<RouteDto[]>(channels.routeList));
    } catch (e) {
      this.items = [];
      this.error = (e as Error).message;
    }
  }
}

export const routes = new RoutesStore();
