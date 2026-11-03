# pantry

A fluent, zero-dependency TypeScript caching library with pluggable storage adapters, TTL expiration, LRU memory eviction, and first-class `stale-while-revalidate` (SWR) support.

Defaults to a fast in-process `MemoryAdapter`, with a clean `PantryAdapter` interface so Redis, SQLite, Valkey, or DynamoDB adapters can be plugged in seamlessly.

## Installation

```bash
npm install pantry
```

## Usage

### Fluent API

```ts
import Pantry from 'pantry'

const stats = await Pantry.key('dashboard:stats')
  .ttl('1m')
  .staleWhileRevalidate('5m')
  .fetch(async () => {
    return await computeHeavyStats()
  })
  .on('hit', (val, key) => {})
  .on('miss', (key) => {})
  .on('stale', (val, key) => {})
```

### Direct Functional API

```ts
import { pantry } from 'pantry'

const user = await pantry(`user:${id}`, { ttl: '30s', swr: '2m' }, async () => {
  return await db.users.find(id)
})
```

### Direct Cache Manipulation

```ts
await Pantry.key('session:1').ttl('1h').set({ userId: 123 })
const session = await Pantry.key('session:1').get()
const exists = await Pantry.has('session:1')
await Pantry.key('session:1').invalidate()
await Pantry.clear()
```

### Pluggable Adapters

By default, `pantry` uses an in-process `MemoryAdapter`. You can configure an LRU `maxSize` or build custom backend adapters implementing `PantryAdapter`:

```ts
import Pantry, { MemoryAdapter, type PantryAdapter, type CacheRecord } from 'pantry'

// Configure default in-memory adapter with LRU eviction at 1,000 items
Pantry.use(new MemoryAdapter({ maxSize: 1_000 }))

// Or implement a custom adapter (e.g. Redis / Valkey / SQLite)
class CustomRedisAdapter implements PantryAdapter {
  async get<T>(key: string): Promise<CacheRecord<T> | undefined> {
    const raw = await redis.get(key)
    return raw ? (JSON.parse(raw) as CacheRecord<T>) : undefined
  }

  async set<T>(key: string, record: CacheRecord<T>): Promise<void> {
    await redis.set(key, JSON.stringify(record))
  }

  async delete(key: string): Promise<boolean> {
    return (await redis.del(key)) > 0
  }

  async clear(): Promise<void> {
    await redis.flushdb()
  }
}

// Use globally:
Pantry.use(new CustomRedisAdapter())

// Or per operation:
const data = await Pantry.key('item:1')
  .adapter(new CustomRedisAdapter())
  .ttl('10m')
  .fetch(async () => loadItem(1))
```

## Development

```bash
npm test           # Run tests with Vitest
npm run lint       # Run linter with Oxlint
npm run type-check # Run TypeScript type checker
npm run build      # Build ESM + CJS bundles with tsdown
```

## License

MIT
