import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isValidPluginId } from '../../kernel/discovery/manifest-validator.js'
import { PluginManagementError } from './errors.js'

interface PersistedState {
  version: 1
  disabled: string[]
}

export class PluginStateStore {
  private readonly disabled = new Set<string>()
  private loaded = false

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.loaded = true
      return
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new PluginManagementError(
        'E_STATE_INVALID',
        'plugin state is not valid JSON',
        {
          cause: error,
        },
      )
    }
    if (!isState(raw)) {
      throw new PluginManagementError(
        'E_STATE_INVALID',
        'plugin state must be { version: 1, disabled: validPluginId[] }',
      )
    }
    for (const id of raw.disabled) this.disabled.add(id)
    this.loaded = true
  }

  isDisabled(pluginId: string): boolean {
    return this.disabled.has(pluginId)
  }

  ids(): string[] {
    return [...this.disabled].toSorted()
  }

  async setDisabled(pluginId: string, disabled: boolean): Promise<boolean> {
    if (!isValidPluginId(pluginId)) {
      throw new PluginManagementError(
        'E_INVALID_ID',
        `invalid plugin id: ${pluginId}`,
      )
    }
    if (this.disabled.has(pluginId) === disabled) return false

    if (disabled) this.disabled.add(pluginId)
    else this.disabled.delete(pluginId)
    try {
      await this.persist()
    } catch (error) {
      if (disabled) this.disabled.delete(pluginId)
      else this.disabled.add(pluginId)
      throw error
    }
    return true
  }

  private async persist(): Promise<void> {
    const state: PersistedState = { version: 1, disabled: this.ids() }
    const dir = path.dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const temp = path.join(
      dir,
      `.plugin-state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    )
    try {
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      await rename(temp, this.filePath)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw new PluginManagementError(
        'E_STATE_WRITE',
        'failed to persist plugin state',
        {
          cause: error,
        },
      )
    }
  }
}

function isState(value: unknown): value is PersistedState {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const state = value as Record<string, unknown>
  return (
    state.version === 1 &&
    Array.isArray(state.disabled) &&
    state.disabled.every(isValidPluginId) &&
    new Set(state.disabled).size === state.disabled.length
  )
}
