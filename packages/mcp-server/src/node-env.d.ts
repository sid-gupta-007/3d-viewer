// Minimal Node.js type declarations for standalone typechecking without @types/node.
declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  export function access(path: string): Promise<void>
  export function mkdtemp(prefix: string): Promise<string>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string
  export function dirname(p: string): string
  export function join(...paths: string[]): string
  export function isAbsolute(p: string): boolean
}

declare module 'node:os' {
  export function tmpdir(): string
}

declare module 'node:process' {
  export const argv: string[]
  export const env: Record<string, string | undefined>
  export const stdin: NodeJS.ReadableStream & { setEncoding(enc: string): void }
  export const stdout: NodeJS.WritableStream
  export const stderr: NodeJS.WritableStream
  export function cwd(): string
  export function exit(code?: number): never
}

declare module 'node:readline' {
  export interface Interface {
    on(event: 'line', listener: (line: string) => void): this
    on(event: 'close', listener: () => void): this
    close(): void
  }
  export function createInterface(options: {
    input: NodeJS.ReadableStream
    crlfDelay?: number
  }): Interface
}

declare module 'node:stream' {
  export class PassThrough implements NodeJS.ReadableStream, NodeJS.WritableStream {
    setEncoding(enc: string): void
    on(event: string, listener: (...args: any[]) => void): this
    write(chunk: string): boolean
    end(): void
  }
}

declare module 'node:test' {
  export interface TestContext {
    name: string
  }
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): void
  export function describe(name: string, fn: () => void): void
  export function it(name: string, fn: (t: TestContext) => void | Promise<void>): void
  export default test
}

declare function setTimeout(cb: (...args: any[]) => void, ms?: number): unknown

declare module 'node:assert/strict' {
  export function equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void
  export function ok(value: unknown, message?: string): asserts value
  export function match(string: string, regexp: RegExp, message?: string): void
  export function rejects(fn: () => Promise<unknown>, error?: RegExp | Function, message?: string): Promise<void>
}

declare namespace NodeJS {
  interface ReadableStream {
    on(event: string, listener: (...args: unknown[]) => void): this
  }
  interface WritableStream {
    write(chunk: string): boolean
  }
}

declare const process: {
  argv: string[]
  env: Record<string, string | undefined>
  stdin: NodeJS.ReadableStream & { setEncoding(enc: string): void }
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  cwd(): string
  exit(code?: number): never
}
