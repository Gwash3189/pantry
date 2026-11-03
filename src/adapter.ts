export interface CacheRecord<T = unknown> {
  value: T
  createdAt: number
  expiresAt?: number
  staleUntil?: number
}

export interface PantryAdapter {
  get<T = unknown>(key: string): Promise<CacheRecord<T> | undefined> | CacheRecord<T> | undefined
  set<T = unknown>(key: string, record: CacheRecord<T>): Promise<void> | void
  delete(key: string): Promise<boolean> | boolean
  has?(key: string): Promise<boolean> | boolean
  clear(): Promise<void> | void
}

export interface MemoryAdapterOptions {
  /**
   * Maximum number of entries to keep in memory before evicting the least recently used entry.
   */
  maxSize?: number
}

export class MemoryAdapter implements PantryAdapter {
  private readonly store = new Map<string, CacheRecord<unknown>>()
  private readonly maxSize?: number

  constructor(options?: MemoryAdapterOptions) {
    if (options?.maxSize !== undefined) {
      if (!Number.isInteger(options.maxSize) || options.maxSize < 1) {
        throw new RangeError('maxSize must be an integer of at least 1')
      }
      this.maxSize = options.maxSize
    }
  }

  get size(): number {
    return this.store.size
  }

  get<T = unknown>(key: string): CacheRecord<T> | undefined {
    const record = this.store.get(key)
    if (!record) {
      return undefined
    }

    const now = Date.now()
    const hardExpiry = record.staleUntil ?? record.expiresAt
    if (hardExpiry !== undefined && now > hardExpiry) {
      this.store.delete(key)
      return undefined
    }

    // Refresh insertion order for LRU
    this.store.delete(key)
    this.store.set(key, record)

    return record as CacheRecord<T>
  }

  set<T = unknown>(key: string, record: CacheRecord<T>): void {
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.maxSize !== undefined && this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey)
      }
    }

    this.store.set(key, record)
  }

  delete(key: string): boolean {
    return this.store.delete(key)
  }

  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  clear(): void {
    this.store.clear()
  }
}
