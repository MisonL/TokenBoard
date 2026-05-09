import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type CommandOptions = {
  env?: NodeJS.ProcessEnv
}

export type CommandRunner = (command: string, args: string[], options?: CommandOptions) => Promise<unknown>

export const runJsonCommand: CommandRunner = async (command, args, options = {}) => {
  const { stdout } = await execFileAsync(command, args, {
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
    env: options.env
  })

  return JSON.parse(stdout)
}
