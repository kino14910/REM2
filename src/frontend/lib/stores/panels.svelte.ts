/**
 * 面板列表与激活项（Svelte 5 runes）。
 *
 * 文件名**必须**以 `.svelte.ts` 结尾：`$state` / `$derived` 是编译期识别的，
 * 放在普通 `.ts` 里不生效且不报错（docs/04 §10 R6）。
 */

import { ipc } from '../ipc-client';
import { channels } from '../channels';
import type { PanelDto } from '../bridge-types';

class PanelsStore {
  items = $state<PanelDto[]>([]);
  activeId = $state<string | undefined>(undefined);
  loading = $state<boolean>(false);
  error = $state<string | undefined>(undefined);

  /** 排序在派生里做一次，不在模板里排。 */
  ordered = $derived([...this.items].sort((a, b) => a.order - b.order));
  active = $derived(
    this.ordered.find((p) => p.panelId === this.activeId) ?? this.ordered[0],
  );

  set(list: PanelDto[]): void {
    this.items = list;
    this.loading = false;
    this.error = undefined;
  }

  setActive(id: string | undefined): void {
    this.activeId = id;
  }

  /** 首屏拉取；失败降级为空，不阻塞渲染。 */
  async load(): Promise<void> {
    this.loading = true;
    try {
      this.set(await ipc.request<PanelDto[]>(channels.panelList));
    } catch (e) {
      this.items = [];
      this.loading = false;
      this.error = (e as Error).message;
    }
  }
}

export const panels = new PanelsStore();
