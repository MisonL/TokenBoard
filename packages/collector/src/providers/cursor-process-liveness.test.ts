import { describe, expect, test } from 'vitest'
import {
  cursorTasklistCommand,
  probeCursorProcessLiveness,
  probeCursorProcessStartIdentity,
  supportsReliableCursorSignalZero,
  tasklistContainsCursorPid
} from './cursor-process-liveness'

describe('cursor process liveness', () => {
  test('identifies Windows Node versions with reliable signal zero', () => {
    expect(supportsReliableCursorSignalZero('darwin', '22.12.0')).toBe(true)
    expect(supportsReliableCursorSignalZero('win32', '22.12.0')).toBe(false)
    expect(supportsReliableCursorSignalZero('win32', '22.16.0')).toBe(true)
    expect(supportsReliableCursorSignalZero('win32', '23.11.0')).toBe(false)
    expect(supportsReliableCursorSignalZero('win32', '24.0.0')).toBe(true)
  })

  test('parses tasklist CSV without localized no-match text', () => {
    expect(tasklistContainsCursorPid('"node.exe","123","Console","1","10,000 K"\r\n', 123)).toBe(true)
    expect(tasklistContainsCursorPid('INFO: No tasks match.', 123)).toBe(false)
    expect(tasklistContainsCursorPid('信息: 没有运行的任务匹配。', 123)).toBe(false)
  })

  test('uses the System32 tasklist executable for legacy Windows checks', () => {
    let command = ''

    expect(cursorTasklistCommand({ SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\tasklist.exe')
    expect(cursorTasklistCommand({ SystemRoot: 'C:relative' })).toBe('C:\\Windows\\System32\\tasklist.exe')
    expect(
      probeCursorProcessLiveness(123, {
        platform: 'win32',
        nodeVersion: '22.12.0',
        env: { SystemRoot: 'D:\\Windows' },
        runTasklist: (candidate) => {
          command = candidate
          return { status: 0, stdout: 'INFO: no match' }
        }
      })
    ).toBe('dead')
    expect(command).toBe('D:\\Windows\\System32\\tasklist.exe')
  })

  test('keeps unknown old-Windows owners and distinguishes alive from dead', () => {
    const base = { platform: 'win32', nodeVersion: '22.12.0' }
    expect(
      probeCursorProcessLiveness(123, {
        ...base,
        runTasklist: () => ({ status: 0, stdout: '"node.exe","123","Console","1","1 K"' })
      })
    ).toBe('alive')
    expect(
      probeCursorProcessLiveness(123, {
        ...base,
        runTasklist: () => ({ status: 0, stdout: 'INFO: no match' })
      })
    ).toBe('dead')
    expect(
      probeCursorProcessLiveness(123, {
        ...base,
        runTasklist: () => ({ status: null, stdout: '', error: new Error('timed out') })
      })
    ).toBe('unknown')
  })

  test('treats EPERM as alive and ESRCH as dead', () => {
    expect(
      probeCursorProcessLiveness(123, {
        platform: 'darwin',
        nodeVersion: '24.0.0',
        kill: () => {
          throw Object.assign(new Error('denied'), { code: 'EPERM' })
        }
      })
    ).toBe('alive')
    expect(
      probeCursorProcessLiveness(123, {
        platform: 'darwin',
        nodeVersion: '24.0.0',
        kill: () => {
          throw Object.assign(new Error('missing'), { code: 'ESRCH' })
        }
      })
    ).toBe('dead')
  })

  test('reads Linux process start identity from boot id and start ticks', () => {
    const values = new Map([
      ['/proc/123/stat', `123 (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 456`],
      ['/proc/sys/kernel/random/boot_id', 'boot-a\n']
    ])

    expect(
      probeCursorProcessStartIdentity(123, {
        platform: 'linux',
        readFile: (path) =>
          values.get(path) ??
          (() => {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' })
          })()
      })
    ).toEqual({ status: 'known', value: 'linux:boot-a:456' })
  })

  test('treats an unavailable Linux process identity as unknown instead of stale', () => {
    expect(
      probeCursorProcessStartIdentity(123, {
        platform: 'linux',
        readFile: () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
      })
    ).toEqual({ status: 'unknown' })
  })

  test('reads Windows process start identity without relying on signal zero', () => {
    let command = ''
    expect(
      probeCursorProcessStartIdentity(123, {
        platform: 'win32',
        env: { SystemRoot: 'D:\\Windows' },
        runProcessIdentity: ((candidate: string) => {
          command = candidate
          return {
            pid: 1,
            output: [],
            stdout: '638000000000000000',
            stderr: '',
            status: 0,
            signal: null
          }
        }) as never
      })
    ).toEqual({ status: 'known', value: 'windows:638000000000000000' })
    expect(command).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })
})
