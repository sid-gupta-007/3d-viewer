#!/usr/bin/env node
import path from 'node:path'
import { startStdioServer } from './server.ts'

function resolveDefaultRoot(argv: string[]): string {
  const rootFlagIdx = argv.indexOf('--root')
  if (rootFlagIdx !== -1 && argv[rootFlagIdx + 1]) {
    return path.resolve(argv[rootFlagIdx + 1])
  }
  if (process.env.FORGE_PROJECT_ROOT) {
    return path.resolve(process.env.FORGE_PROJECT_ROOT)
  }
  return process.cwd()
}

const defaultProjectRoot = resolveDefaultRoot(process.argv.slice(2))
startStdioServer({ defaultProjectRoot })
