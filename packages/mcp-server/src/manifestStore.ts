import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createDefaultManifest,
  validateSceneManifest,
  type ForgeSceneManifest,
} from '../../../src/domain/sceneManifest.ts'

export const SCENE_MANIFEST_RELATIVE_PATH = '.forge/scene.json'

export function resolveManifestPath(projectRoot: string): string {
  return path.resolve(projectRoot, SCENE_MANIFEST_RELATIVE_PATH)
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export async function readSceneManifest(projectRoot: string): Promise<ForgeSceneManifest> {
  const manifestPath = resolveManifestPath(projectRoot)
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Scene manifest not found at ${manifestPath}`)
  }
  const raw = await readFile(manifestPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid JSON in ${manifestPath}: ${message}`)
  }
  if (!validateSceneManifest(parsed)) {
    throw new Error(`Scene manifest at ${manifestPath} failed schema validation`)
  }
  return parsed
}

export async function loadOrCreateSceneManifest(projectRoot: string): Promise<ForgeSceneManifest> {
  const manifestPath = resolveManifestPath(projectRoot)
  if (await fileExists(manifestPath)) {
    return readSceneManifest(projectRoot)
  }
  return createDefaultManifest()
}

export async function writeSceneManifest(
  projectRoot: string,
  manifest: ForgeSceneManifest
): Promise<string> {
  if (!validateSceneManifest(manifest)) {
    throw new Error('Cannot write invalid ForgeSceneManifest')
  }
  const manifestPath = resolveManifestPath(projectRoot)
  await mkdir(path.dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifestPath
}
