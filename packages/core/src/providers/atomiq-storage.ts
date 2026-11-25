import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * File storage for the Atomiq SDK, replacing @atomiqlabs/storage-sqlite so no native module
 * has to be built. Same contract as the SDK's IUnifiedStorage and IStorageManager: the whole
 * set is kept in memory and rewritten (write, then rename) after every change. A user's swaps
 * number in the dozens, so this is plenty.
 */

async function readJson<T>(file: string, empty: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty
    throw err
  }
}
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}

type Stored = { id: string; [key: string]: unknown }
type Query = { key: string; value: unknown }[][]

export class FileUnifiedStorage {
  private items = new Map<string, Stored>()
  private indexed = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private file: string
  constructor(file: string) {
    this.file = file
  }

  async init(indexes: readonly { key: string }[]): Promise<void> {
    for (const i of indexes) this.indexed.add(i.key)
    const saved = await readJson<Stored[]>(this.file, [])
    this.items = new Map(saved.map((v) => [v.id, v]))
  }

  /** Same meaning as the SQL the SDK's own storage runs: OR of ANDs, an array value is IN, an empty outer list matches everything. */
  async query(params: Query): Promise<Stored[]> {
    if (params.some((and) => and.length === 0) || params.length === 0) return [...this.items.values()]
    for (const and of params) for (const p of and) if (p.key !== 'id' && !this.indexed.has(p.key)) throw new Error(`Tried to query based on non-indexed column: ${p.key}!`)
    const matches = (item: Stored, p: { key: string; value: unknown }) => {
      const have = item[p.key]
      if (have === undefined || have === null) return false
      return Array.isArray(p.value) ? p.value.includes(have) : have === p.value
    }
    return [...this.items.values()].filter((item) => params.some((and) => and.every((p) => matches(item, p))))
  }

  private persist(): Promise<void> {
    // One write at a time, in order, so a slow disk cannot interleave two files.
    return (this.queue = this.queue.then(() => writeJson(this.file, [...this.items.values()])))
  }
  async save(value: Stored): Promise<void> {
    this.items.set(value.id, JSON.parse(JSON.stringify(value)))
    await this.persist()
  }
  async saveAll(values: Stored[]): Promise<void> {
    for (const v of values) this.items.set(v.id, JSON.parse(JSON.stringify(v)))
    await this.persist()
  }
  async remove(value: Stored): Promise<void> {
    this.items.delete(value.id)
    await this.persist()
  }
  async removeAll(values: Stored[]): Promise<void> {
    for (const v of values) this.items.delete(v.id)
    await this.persist()
  }
}

interface Serializable {
  serialize(): unknown
}

export class FileStorageManager {
  data: Record<string, Serializable> = {}
  private file: string
  private queue: Promise<void> = Promise.resolve()
  constructor(file: string) {
    this.file = file
  }
  async init(): Promise<void> {}

  async loadData(type: new (data: unknown) => Serializable): Promise<Serializable[]> {
    const saved = await readJson<Record<string, unknown>>(this.file, {})
    this.data = {}
    for (const [id, value] of Object.entries(saved)) this.data[id] = new type(value)
    return Object.values(this.data)
  }
  private persist(): Promise<void> {
    const plain = Object.fromEntries(Object.entries(this.data).map(([id, o]) => [id, o.serialize()]))
    return (this.queue = this.queue.then(() => writeJson(this.file, plain)))
  }
  async saveData(id: string, object: Serializable): Promise<void> {
    this.data[id] = object
    await this.persist()
  }
  async saveDataArr(values: { id: string; object: Serializable }[]): Promise<void> {
    for (const v of values) this.data[v.id] = v.object
    await this.persist()
  }
  async removeData(id: string): Promise<void> {
    delete this.data[id]
    await this.persist()
  }
  async removeDataArr(ids: string[]): Promise<void> {
    for (const id of ids) delete this.data[id]
    await this.persist()
  }
}
