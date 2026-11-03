import { describe, expect, it } from 'vitest'
import { timeoutFor } from '@/host/ipc/bridge.js'
import { channels } from '@/shared/ipc-contract.js'

describe('unit · IPC timeout policy', () => {
  it('does not time out operations that wait for native confirmation or user-controlled work', () => {
    for (const method of [
      channels.pluginInstallFromDirectory,
      channels.pluginInstallFromRemote,
      channels.pluginRemoteInspect,
      channels.pluginUpdateCheck,
      channels.pluginUpdateInstall,
      channels.pluginEnable,
      channels.pluginPermissionGrant,
      channels.pluginDisable,
      channels.pluginUninstall,
      channels.pluginRestart,
      channels.settingsProxySet,
    ]) {
      expect(timeoutFor(method), method).toBe(0)
    }
  })

  it('keeps bounded timeouts for reads', () => {
    expect(timeoutFor(channels.settingsProxyGet)).toBe(15_000)
    expect(timeoutFor(channels.pluginList)).toBe(15_000)
  })
})
