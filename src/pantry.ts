import { type CacheRecord, MemoryAdapter, type PantryAdapter } from './adapter'

export type DurationInput = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

export type PantryEvent = 'hit' | 'miss' | 'stale' | 'set'

export type HitHandler<T = unknown> = (value: T, key: string) => void | Promise<void>
export type MissHandler = (key: string) => void | Promise<void>
export type StaleHandler<T = unknown> = (value: T, key: string) => void | Promise<void>
export type SetHandler<T = unknown> = (value: T, key: string) => void | Promise<void>

export type WorkFn<T = unknown> = () => Promise<T> | T

export function parseDuration(input: DurationInput, label = 'duration'): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new RangeError(`${label} must be a non-negative number`)
    }
    return input
  }

  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(input)
  if (!match) {
    throw new RangeError(`Invalid ${label} format: "${String(input)}"`)
  }

  const amount = Number(match[1])
  const unit = match[2]

  switch (unit) {
    case 'ms':
      return amount
    case 's':
      return amount * 1_000
    case 'm':
      return amount * 60_000
    case 'h':
      return amount * 3_600_000
    case 'd':
      return amount * 86_400_000
    default:
      throw new RangeError(`Invalid ${label} unit: "${String(unit)}"`)
  }
}

let defaultAdapter: PantryAdapter = new MemoryAdapter()
const inFlightRevalidations = new Map<string, Promise<unknown>>()

interface PantryConfig<T = unknown> {
  key?: string
  adapter?: PantryAdapter
  ttlMs?: number
  swrMs?: number
  workFn?: WorkFn<T>
  hitHandlers: HitHandler<T>[]
  missHandlers: MissHandler[]
  staleHandlers: StaleHandler<T>[]
  setHandlers: SetHandler<T>[]
}

export class PantryBuilder<T = unknown> implements PromiseLike<T> {
  private readonly config: PantryConfig<T>
  private executionPromise?: Promise<T>

  constructor(config?: Partial<PantryConfig<T>>) {
    this.config = {
      key: config?.key,
      adapter: config?.adapter,
      ttlMs: config?.ttlMs,
      swrMs: config?.swrMs,
      workFn: config?.workFn,
      hitHandlers: [...(config?.hitHandlers ?? [])],
      missHandlers: [...(config?.missHandlers ?? [])],
      staleHandlers: [...(config?.staleHandlers ?? [])],
      setHandlers: [...(config?.setHandlers ?? [])],
    }
  }

  private get activeAdapter(): PantryAdapter {
    return this.config.adapter ?? defaultAdapter
  }

  use(adapter: PantryAdapter): this {
    defaultAdapter = adapter
    return this
  }

  adapter(adapter: PantryAdapter): PantryBuilder<T> {
    return new PantryBuilder<T>({ ...this.config, adapter })
  }

  key(key: string): PantryBuilder<T> {
    if (!key || key.trim().length === 0) {
      throw new RangeError('cache key must be a non-empty string')
    }
    return new PantryBuilder<T>({ ...this.config, key })
  }

  for(key: string): PantryBuilder<T> {
    return this.key(key)
  }

  ttl(duration: DurationInput): PantryBuilder<T> {
    const ttlMs = parseDuration(duration, 'ttl')
    return new PantryBuilder<T>({ ...this.config, ttlMs })
  }

  staleWhileRevalidate(duration: DurationInput): PantryBuilder<T> {
    const swrMs = parseDuration(duration, 'staleWhileRevalidate')
    return new PantryBuilder<T>({ ...this.config, swrMs })
  }

  swr(duration: DurationInput): PantryBuilder<T> {
    return this.staleWhileRevalidate(duration)
  }

  work<R>(fn: WorkFn<R>): PantryBuilder<R> {
    return new PantryBuilder<R>({
      ...(this.config as unknown as PantryConfig<R>),
      workFn: fn,
    })
  }

  fetch<R>(fn: WorkFn<R>): PantryBuilder<R> {
    return this.work(fn)
  }

  on(event: 'hit', handler: HitHandler<T>): PantryBuilder<T>
  on(event: 'miss', handler: MissHandler): PantryBuilder<T>
  on(event: 'stale', handler: StaleHandler<T>): PantryBuilder<T>
  on(event: 'set', handler: SetHandler<T>): PantryBuilder<T>
  on(
    event: PantryEvent,
    handler: HitHandler<T> | MissHandler | StaleHandler<T> | SetHandler<T>
  ): PantryBuilder<T> {
    switch (event) {
      case 'hit':
        return new PantryBuilder<T>({
          ...this.config,
          hitHandlers: [...this.config.hitHandlers, handler as HitHandler<T>],
        })
      case 'miss':
        return new PantryBuilder<T>({
          ...this.config,
          missHandlers: [...this.config.missHandlers, handler as MissHandler],
        })
      case 'stale':
        return new PantryBuilder<T>({
          ...this.config,
          staleHandlers: [...this.config.staleHandlers, handler as StaleHandler<T>],
        })
      case 'set':
        return new PantryBuilder<T>({
          ...this.config,
          setHandlers: [...this.config.setHandlers, handler as SetHandler<T>],
        })
    }
  }

  async get<R = T>(key?: string): Promise<R | undefined> {
    const targetKey = key ?? this.config.key
    if (!targetKey || targetKey.trim().length === 0) {
      throw new RangeError('cache key must be a non-empty string')
    }

    const record = await this.activeAdapter.get<R>(targetKey)
    if (!record) {
      return undefined
    }

    const now = Date.now()
    const hardExpiry = record.staleUntil ?? record.expiresAt
    if (hardExpiry !== undefined && now > hardExpiry) {
      await this.activeAdapter.delete(targetKey)
      return undefined
    }

    return record.value
  }

  async set<R = T>(keyOrValue: string | R, maybeValue?: R): Promise<void> {
    let targetKey: string
    let value: R

    if (arguments.length >= 2) {
      targetKey = keyOrValue as string
      value = maybeValue as R
    } else {
      if (!this.config.key) {
        throw new RangeError('cache key must be configured before calling .set(value)')
      }
      targetKey = this.config.key
      value = keyOrValue as R
    }

    if (!targetKey || targetKey.trim().length === 0) {
      throw new RangeError('cache key must be a non-empty string')
    }

    const record = this.buildRecord(value)
    await this.activeAdapter.set(targetKey, record)

    for (const handler of this.config.setHandlers) {
      await handler(value as unknown as T, targetKey)
    }
  }

  async delete(key?: string): Promise<boolean> {
    const targetKey = key ?? this.config.key
    if (!targetKey || targetKey.trim().length === 0) {
      throw new RangeError('cache key must be a non-empty string')
    }
    return await this.activeAdapter.delete(targetKey)
  }

  async invalidate(key?: string): Promise<boolean> {
    return this.delete(key)
  }

  async has(key?: string): Promise<boolean> {
    const targetKey = key ?? this.config.key
    if (!targetKey || targetKey.trim().length === 0) {
      throw new RangeError('cache key must be a non-empty string')
    }
    if (this.activeAdapter.has) {
      return await this.activeAdapter.has(targetKey)
    }
    const val = await this.get(targetKey)
    return val !== undefined
  }

  async clear(): Promise<void> {
    inFlightRevalidations.clear()
    await this.activeAdapter.clear()
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): Promise<TResult1 | TResult2> {
    if (!this.executionPromise) {
      this.executionPromise = this.execute()
    }
    return this.executionPromise.then(onfulfilled, onrejected)
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined
  ): Promise<T | TResult> {
    return this.then(undefined, onrejected)
  }

  finally(onfinally?: (() => void) | null | undefined): Promise<T> {
    return this.then(
      (value) => {
        onfinally?.()
        return value
      },
      (reason) => {
        onfinally?.()
        throw reason
      }
    )
  }

  private buildRecord<R>(value: R): CacheRecord<R> {
    const now = Date.now()
    const expiresAt = this.config.ttlMs !== undefined ? now + this.config.ttlMs : undefined
    const staleUntil =
      expiresAt !== undefined && this.config.swrMs !== undefined
        ? expiresAt + this.config.swrMs
        : undefined

    return {
      value,
      createdAt: now,
      expiresAt,
      staleUntil,
    }
  }

  private async execute(): Promise<T> {
    const { key, workFn, hitHandlers, missHandlers, staleHandlers, setHandlers } = this.config

    if (!key || key.trim().length === 0) {
      throw new RangeError('cache key must be configured before awaiting')
    }
    if (!workFn) {
      throw new Error('No work function provided. Call .work(fn) or .fetch(fn) before awaiting.')
    }

    const adapter = this.activeAdapter
    const existing = await adapter.get<T>(key)
    const now = Date.now()

    if (existing !== undefined) {
      const isFresh = existing.expiresAt === undefined || now <= existing.expiresAt
      if (isFresh) {
        for (const handler of hitHandlers) {
          await handler(existing.value, key)
        }
        return existing.value
      }

      const isWithinSwr = existing.staleUntil !== undefined && now <= existing.staleUntil
      if (isWithinSwr) {
        for (const handler of staleHandlers) {
          await handler(existing.value, key)
        }

        if (!inFlightRevalidations.has(key)) {
          const revalidatePromise = Promise.resolve()
            .then(() => workFn())
            .then(async (freshValue) => {
              const record = this.buildRecord(freshValue)
              await adapter.set(key, record)
              for (const handler of setHandlers) {
                await handler(freshValue, key)
              }
            })
            .catch(() => {
              // Background revalidation errors should not crash unhandled rejection
            })
            .finally(() => {
              inFlightRevalidations.delete(key)
            })

          inFlightRevalidations.set(key, revalidatePromise)
        }

        return existing.value
      }

      await adapter.delete(key)
    }

    for (const handler of missHandlers) {
      await handler(key)
    }

    const freshValue = await workFn()
    const record = this.buildRecord(freshValue)
    await adapter.set(key, record)

    for (const handler of setHandlers) {
      await handler(freshValue, key)
    }

    return freshValue
  }
}

export interface PantryOptions {
  ttl?: DurationInput
  staleWhileRevalidate?: DurationInput
  swr?: DurationInput
  adapter?: PantryAdapter
}

export function pantry<T>(key: string, workFn: WorkFn<T>): Promise<T>
export function pantry<T>(key: string, options: PantryOptions, workFn: WorkFn<T>): Promise<T>
export function pantry<T>(
  key: string,
  optionsOrWork: PantryOptions | WorkFn<T>,
  maybeWork?: WorkFn<T>
): Promise<T> {
  let builder = new PantryBuilder<T>().key(key)

  if (typeof optionsOrWork === 'function') {
    return Promise.resolve(builder.work(optionsOrWork))
  }

  if (optionsOrWork.adapter) {
    builder = builder.adapter(optionsOrWork.adapter)
  }
  if (optionsOrWork.ttl !== undefined) {
    builder = builder.ttl(optionsOrWork.ttl)
  }
  const swr = optionsOrWork.staleWhileRevalidate ?? optionsOrWork.swr
  if (swr !== undefined) {
    builder = builder.staleWhileRevalidate(swr)
  }

  if (!maybeWork) {
    throw new Error('No work function provided to pantry()')
  }

  return Promise.resolve(builder.work(maybeWork))
}

export const Pantry: PantryBuilder = new PantryBuilder()

export function resetPantry(): void {
  inFlightRevalidations.clear()
  defaultAdapter = new MemoryAdapter()
}

export default Pantry
