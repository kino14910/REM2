import { ipc } from '../ipc-client'
import { channels } from '../../../shared/ipc-contract'
import type { HealthDto } from '../bridge-types'

class HealthStore {
  report = $state<HealthDto | undefined>(undefined)
  error = $state<string | undefined>(undefined)

  status = $derived(this.report?.status ?? 'unknown')
  unhealthy = $derived(
    (this.report?.plugins ?? []).filter(p => p.status === 'unhealthy'),
  )

  set(report: HealthDto): void {
    this.report = report
    this.error = undefined
  }

  async load(): Promise<void> {
    try {
      this.set(await ipc.request<HealthDto>(channels.healthReport))
    } catch (e) {
      this.report = undefined
      this.error = (e as Error).message
    }
  }
}

export const health = new HealthStore()
