/** 当前主题 + 主题列表（Svelte 5 runes）。 */

import { ipc } from '../ipc-client';
import { channels } from '../channels';
import { applyTheme } from '../theme/vars';
import type { ThemeDto } from '../bridge-types';

class ThemeStore {
  list = $state<ThemeDto[]>([]);
  activeId = $state<string | undefined>(undefined);
  error = $state<string | undefined>(undefined);

  active = $derived(this.list.find((t) => t.id === this.activeId));

  setList(list: ThemeDto[]): void {
    this.list = list;
    this.error = undefined;
  }

  /** 主题切换：先本地应用（避免等 IPC 往返），再通知主进程。 */
  setActive(theme: ThemeDto): void {
    this.activeId = theme.id;
    applyTheme(theme);
    void ipc.request<{ ok: boolean }>(channels.themeSet, { themeId: theme.id });
  }

  async load(): Promise<void> {
    try {
      this.setList(await ipc.request<ThemeDto[]>(channels.themeList));
    } catch (e) {
      this.list = [];
      this.error = (e as Error).message;
    }
  }
}

export const theme = new ThemeStore();
