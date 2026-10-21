import { ipc } from '../ipc-client'
import { channels } from '../../../shared/ipc-contract'
import type { CommandResultDto } from '../bridge-types'

class CommandStore {
  last = $state<CommandResultDto | undefined>(undefined)
  history = $state<CommandResultDto[]>([])
  running = $state<boolean>(false)
  error = $state<string | undefined>(undefined)

  set(result: CommandResultDto): void {
    this.last = result
    this.history = [result, ...this.history].slice(0, 20)
    this.running = false
  }

  async execute(command: string, args?: unknown): Promise<void> {
    this.running = true
    this.error = undefined
    try {
      const res = await ipc.request<CommandResultDto>(channels.commandExecute, {
        command,
        args,
      })
      // preload has already unwrapped payload.result, so `res` is the object
      // returned by the plugin itself ({ok, output} / {ok:false, error});
      // do not read res.result again.
      this.set({ ...res, command })
    } catch (e) {
      this.running = false
      this.error = (e as Error).message
    }
  }
}

export const command = new CommandStore()
