/** 命令执行结果（Svelte 5 runes）。 */

import { ipc } from '../ipc-client';
import { channels } from '../channels';
import type { CommandResultDto } from '../bridge-types';

class CommandStore {
  last = $state<CommandResultDto | undefined>(undefined);
  history = $state<CommandResultDto[]>([]);
  running = $state<boolean>(false);
  error = $state<string | undefined>(undefined);

  set(result: CommandResultDto): void {
    this.last = result;
    this.history = [result, ...this.history].slice(0, 20);
    this.running = false;
  }

  /** 执行一条白名单命令。 */
  async execute(command: string, args?: unknown): Promise<void> {
    this.running = true;
    this.error = undefined;
    try {
      const res = await ipc.request<CommandResultDto>(channels.commandExecute, {
        command,
        args,
      });
      // preload 已解出 payload.result，因此 res 就是插件返回的对象本身
      // （形如 {ok, output} / {ok:false, error}），不要再取 res.result。
      this.set({ ...res, command });
    } catch (e) {
      this.running = false;
      this.error = (e as Error).message;
    }
  }
}

export const command = new CommandStore();
