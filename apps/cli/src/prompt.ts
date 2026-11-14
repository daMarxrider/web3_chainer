import { createInterface } from 'node:readline/promises'

export async function ask(question: string): Promise<string> {
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

export async function askPassword(question = 'Wallet password: '): Promise<string> {
  return process.env.CHAINER_PASSWORD ?? askHidden(question)
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `))
}
