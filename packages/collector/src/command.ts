import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

export type CommandRunnerOptions = {
  timeoutMs?: number
}

export type CommandRunner = (command: string, args: string[], options?: CommandRunnerOptions) => Promise<unknown>

export const runJsonCommand: CommandRunner = async (command, args, options = {}) => {
  const { stdout } = await execFileAsync(command, args, {
    shell: false,
    maxBuffer: 128 * 1024 * 1024,
    timeout: options.timeoutMs ?? readCommandTimeoutMs()
  })

  return JSON.parse(stdout)
}

function readCommandTimeoutMs() {
  const value = Number.parseInt(process.env.TOKENBOARD_COMMAND_TIMEOUT_MS || '', 10)
  if (Number.isFinite(value) && value > 0) {
    return value
  }
  return DEFAULT_COMMAND_TIMEOUT_MS
}
