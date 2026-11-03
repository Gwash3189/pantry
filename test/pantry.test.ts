import { describe, expect, it } from 'vitest'
import Pantry, {
  MemoryAdapter,
  pantry,
  resetPantry,
  type CacheRecord,
  type PantryAdapter,
} from '../src'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Pantry', () => {
  describe('.key', () => {
    describe('when fetching a value with the default in-process MemoryAdapter', () => {
      it('computes and caches the value on a cache miss', async () => {
        const result = await Pantry.key('miss-test')
          .ttl('1m')
          .work(async () => 'computed-value')

        expect(result).toBe('computed-value')
      })

      it('returns the cached value on subsequent calls without re-running work', async () => {
        const key = 'hit-test'
        let executions = 0

        await Pantry.key(key)
          .ttl(5000)
          .fetch(async () => {
            executions++
            return 'cached'
          })

        await Pantry.key(key)
          .ttl(5000)
          .fetch(async () => {
            executions++
            return 'recomputed'
          })

        expect(executions).toBe(1)
      })

      it('invokes miss, set, and hit lifecycle handlers appropriately', async () => {
        const key = 'lifecycle-events'
        const events: string[] = []

        const run = () =>
          Pantry.for(key)
            .ttl('1h')
            .on('miss', () => {
              events.push('miss')
            })
            .on('set', () => {
              events.push('set')
            })
            .on('hit', () => {
              events.push('hit')
            })
            .work(async () => 'data')

        await run()
        await run()

        expect(events).toEqual(['miss', 'set', 'hit'])
      })
    })

    describe('when a cached entry expires after its TTL', () => {
      it('evicts the expired entry and recomputes fresh work', async () => {
        const key = 'ttl-expiry'
        let count = 0

        await Pantry.key(key)
          .ttl('20ms')
          .work(async () => {
            count++
            return `val-${count}`
          })

        await delay(35)

        const second = await Pantry.key(key)
          .ttl('20ms')
          .work(async () => {
            count++
            return `val-${count}`
          })

        expect(second).toBe('val-2')
      })
    })

    describe('when staleWhileRevalidate is configured', () => {
      it('returns the stale value immediately and revalidates in the background', async () => {
        const key = 'swr-test'
        let version = 1
        const staleEvents: string[] = []

        await Pantry.key(key)
          .ttl(20)
          .staleWhileRevalidate(200)
          .work(async () => `v${version}`)

        await delay(30)
        version = 2

        const staleResult = await Pantry.key(key)
          .ttl(20)
          .swr(200)
          .on('stale', (val) => {
            staleEvents.push(String(val))
          })
          .work(async () => `v${version}`)

        await delay(15)

        const freshResult = await Pantry.key(key)
          .ttl(20)
          .swr(200)
          .work(async () => 'v3')

        expect([staleResult, staleEvents[0], freshResult]).toEqual(['v1', 'v1', 'v2'])
      })
    })

    describe('when performing direct cache operations (get, set, has, delete, clear)', () => {
      it('sets and gets a value directly via .set() and .get()', async () => {
        const key = 'direct-set-get'

        await Pantry.key(key).ttl('1d').set({ user: 'alice' })
        const val = await Pantry.key(key).get<{ user: string }>()

        expect(val).toEqual({ user: 'alice' })
      })

      it('supports passing key and value to Pantry.set(key, value) and Pantry.has(key)', async () => {
        const key = 'top-level-set'

        await Pantry.set(key, 42)
        const exists = await Pantry.has(key)

        expect(exists).toBe(true)
      })

      it('deletes an entry via .invalidate()', async () => {
        const key = 'invalidate-key'

        await Pantry.set(key, 'temp')
        await Pantry.key(key).invalidate()
        const afterDelete = await Pantry.get(key)

        expect(afterDelete).toBeUndefined()
      })

      it('clears all entries when .clear() is called', async () => {
        await Pantry.set('clear-1', 'a')
        await Pantry.clear()
        const exists = await Pantry.has('clear-1')

        expect(exists).toBe(false)
      })
    })
  })

  describe('.adapter and .use', () => {
    describe('when using a custom backend PantryAdapter', () => {
      it('delegates storage operations to the per-operation custom adapter', async () => {
        const backingMap = new Map<string, CacheRecord<unknown>>()
        const customAdapter: PantryAdapter = {
          get<T>(k: string) {
            return backingMap.get(k) as CacheRecord<T> | undefined
          },
          set<T>(k: string, record: CacheRecord<T>) {
            backingMap.set(k, record)
          },
          delete(k: string) {
            return backingMap.delete(k)
          },
          clear() {
            backingMap.clear()
          },
        }

        await Pantry.key('custom-adapter-key')
          .adapter(customAdapter)
          .ttl('1s')
          .work(async () => 'stored-in-custom')

        expect(backingMap.get('custom-adapter-key')?.value).toBe('stored-in-custom')
      })

      it('allows swapping the global default adapter via Pantry.use(adapter)', async () => {
        const customMemory = new MemoryAdapter({ maxSize: 10 })
        Pantry.use(customMemory)

        await Pantry.key('global-adapter-key').work(async () => 'in-custom-default')
        const size = customMemory.size
        resetPantry()

        expect(size).toBe(1)
      })
    })
  })

  describe('MemoryAdapter', () => {
    describe('when maxSize is configured', () => {
      it('evicts the least recently used entry when capacity is exceeded', async () => {
        const lruAdapter = new MemoryAdapter({ maxSize: 2 })

        await Pantry.adapter(lruAdapter).key('a').set(1)
        await Pantry.adapter(lruAdapter).key('b').set(2)
        // Access 'a' so 'b' becomes least recently used
        await Pantry.adapter(lruAdapter).key('a').get()
        await Pantry.adapter(lruAdapter).key('c').set(3)

        const [hasA, hasB, hasC] = await Promise.all([
          Pantry.adapter(lruAdapter).has('a'),
          Pantry.adapter(lruAdapter).has('b'),
          Pantry.adapter(lruAdapter).has('c'),
        ])

        expect([hasA, hasB, hasC]).toEqual([true, false, true])
      })

      it('throws a RangeError if maxSize is less than 1', () => {
        expect(() => new MemoryAdapter({ maxSize: 0 })).toThrow(RangeError)
      })
    })
  })

  describe('.pantry functional API', () => {
    describe('when called with key, options, and callback', () => {
      it('caches and returns the callback result', async () => {
        const val = await pantry(
          'fn-api-key',
          { ttl: '5s', swr: '10s' },
          async () => 'functional-ok'
        )

        expect(val).toBe('functional-ok')
      })

      it('supports calling pantry(key, workFn) without options', async () => {
        const val = await pantry('fn-no-opts', async () => 'simple-ok')

        expect(val).toBe('simple-ok')
      })
    })
  })

  describe('validation and promise chaining', () => {
    describe('when invalid arguments are passed', () => {
      it('throws a RangeError for an empty key', () => {
        expect(() => Pantry.key('   ')).toThrow(RangeError)
      })

      it('throws a RangeError for a negative numeric ttl', () => {
        expect(() => Pantry.key('bad-ttl').ttl(-5)).toThrow(RangeError)
      })

      it('throws a RangeError for an invalid duration string', () => {
        expect(() => Pantry.key('bad-duration').ttl('10weeks' as unknown as `${number}s`)).toThrow(
          RangeError
        )
      })
    })

    describe('when chaining .catch() and .finally()', () => {
      it('catches errors from work via .catch()', async () => {
        const res = await Pantry.key('catch-key')
          .work(async () => {
            throw new Error('work failed')
          })
          .catch(() => 'fallback-from-catch')

        expect(res).toBe('fallback-from-catch')
      })

      it('runs .finally() after work resolves', async () => {
        let finalized = false

        await Pantry.key('finally-key')
          .work(async () => 'done')
          .finally(() => {
            finalized = true
          })

        expect(finalized).toBe(true)
      })
    })
  })
})
