import { readFile } from 'node:fs/promises'
import type { ConfigProvider } from 'rem2-kernel'
import type { ConfigService } from '../../src/kernel/config/config-service.js'

export class TestJsonProvider implements ConfigProvider {
  readonly name = 'json'
  readonly priority = 10
  constructor(private readonly file: string) {}

  async load(): Promise<Record<string, unknown>> {
    try {
      const text = await readFile(this.file, 'utf8')
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      return {}
    }
  }
}

export async function tryInjectJsonProvider(
  svc: ConfigService,
  file: string,
): Promise<void> {
  svc.registerProvider(new TestJsonProvider(file))
}
