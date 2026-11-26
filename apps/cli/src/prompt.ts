import { createInterface } from 'node:readline/promises'

/**
 * Piped input is read through one reader for the whole run: a reader buffers ahead, so a new one
 * per question would lose the lines the previous one had already taken.
 */
let pipedLines: AsyncIterator<string> | undefined

export async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stderr.write(question)
    pipedLines ??= createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]()
    const next = await pipedLines.next()
    // Without this, a question asked after the input ended would leave the program to exit quietly with success.
    if (next.done) throw new Error(`The input ended before this was answered: ${question.trim()}`)
    return next.value.trim()
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/** Reads a line without echoing it. Falls back to a plain read when input is piped. */
export async function askHidden(question: string): Promise<string> {
  const { stdin, stderr } = process
  if (!stdin.isTTY) return ask(question)
  stderr.write(question)
  stdin.setRawMode(true)
  stdin.resume()
  let value = ''
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString('utf8')) {
          if (ch === '\r' || ch === '\n') {
            stdin.off('data', onData)
            return resolve(value)
          }
          if (ch === '\u0003') {
            stdin.off('data', onData)
            return reject(new Error('Cancelled'))
          }
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
          else if (ch >= ' ') value += ch
        }
      }
      stdin.on('data', onData)
    })
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
    stderr.write('\n')
  }
}

let remembered: string | undefined
/** The wallet password, asked once per run of the program (a sweep unlocks the wallet for every transfer). Kept in memory only. */
export async function askPassword(question = 'Wallet password: '): Promise<string> {
  return process.env.CHAINER_PASSWORD ?? (remembered ??= await askHidden(question))
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `))
}
