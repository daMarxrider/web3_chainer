/**
 * Route sources that need a third-party SDK. The SDKs are optional dependencies: the app
 * installs and runs without them, and a source whose SDK is missing is simply not offered.
 * Nothing in the core imports an SDK at the top of a file; it goes through loadSdk below.
 */
export interface OptionalSdk {
  /** Provider name the SDK enables. */
  provider: string
  /** What the user gains by installing it. */
  gives: string
  /** npm package name. */
  pkg: string
}

export const OPTIONAL_SDKS: OptionalSdk[] = [{ provider: 'atomiq', gives: 'Atomiq trustless swaps between Bitcoin / Lightning and Solana', pkg: '@atomiqlabs/sdk' }]

type Importer = (pkg: string) => Promise<unknown>
// The package name is a variable on purpose: nothing is resolved until this runs.
const nodeImport: Importer = (pkg) => import(pkg)

const isMissing = (err: unknown, pkg: string) => {
  const e = err as { code?: string; message?: string }
  return (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND') && (e.message ?? '').includes(pkg)
}

/**
 * The SDK's module, or undefined when it is not installed. Any other failure (a broken
 * install, a crash inside the package) is thrown, so it is not mistaken for "not installed".
 */
export async function loadSdk<T = unknown>(pkg: string, importer: Importer = nodeImport): Promise<T | undefined> {
  try {
    return (await importer(pkg)) as T
  } catch (err) {
    if (isMissing(err, pkg)) return undefined
    throw new Error(`The optional package ${pkg} is installed but could not be loaded: ${(err as Error).message}`)
  }
}

export interface SdkStatus extends OptionalSdk {
  installed: boolean
  /** Why it could not be loaded, when it is installed but broken. */
  error?: string
}

export async function sdkStatus(importer: Importer = nodeImport): Promise<SdkStatus[]> {
  return Promise.all(
    OPTIONAL_SDKS.map(async (sdk): Promise<SdkStatus> => {
      try {
        return { ...sdk, installed: (await loadSdk(sdk.pkg, importer)) !== undefined }
      } catch (err) {
        return { ...sdk, installed: false, error: (err as Error).message }
      }
    }),
  )
}
