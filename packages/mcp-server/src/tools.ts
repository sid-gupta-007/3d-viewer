import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  EasingMode,
  KeyframeManifest,
  NodeManifest,
  Vec3,
} from '../../../src/domain/sceneManifest.ts'
import { generateR3FComponent, patchR3FFile } from '../../../src/export/r3f/r3fCodegen.ts'
import {
  fileExists,
  loadOrCreateSceneManifest,
  readSceneManifest,
  resolveManifestPath,
  writeSceneManifest,
} from './manifestStore.ts'

export type JsonSchema = Record<string, unknown>

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
}

export interface ToolContext {
  defaultProjectRoot: string
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const VALID_EASINGS: ReadonlySet<EasingMode> = new Set([
  'linear',
  'easeInOut',
  'easeIn',
  'easeOut',
  'step',
])

const VEC3_SCHEMA: JsonSchema = {
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
}

const PROJECT_ROOT_PROP: JsonSchema = {
  type: 'string',
  description: 'Optional workspace root containing .forge/scene.json. Defaults to server root.',
}

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'get_scene_summary',
    description:
      'Read .forge/scene.json and return a structured summary of project metadata, camera, environment/lights, nodes, and animation keyframes.',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_camera_pose',
    description:
      'Update camera position, target, fov, near, or far in .forge/scene.json (creating a default manifest if missing).',
    inputSchema: {
      type: 'object',
      properties: {
        position: { ...VEC3_SCHEMA, description: 'Camera world position [x, y, z].' },
        target: { ...VEC3_SCHEMA, description: 'OrbitControls look-at target [x, y, z].' },
        fov: { type: 'number', description: 'Vertical field of view in degrees (0 < fov < 180).' },
        near: { type: 'number', description: 'Near clipping plane (> 0).' },
        far: { type: 'number', description: 'Far clipping plane (> near).' },
        projectRoot: PROJECT_ROOT_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_node_transform',
    description:
      'Update a node transform (position, rotation, scale, visible, pivot, name) by forgeId in .forge/scene.json.',
    inputSchema: {
      type: 'object',
      properties: {
        forgeId: { type: 'string', description: 'Stable forgeId of the target node.' },
        position: { ...VEC3_SCHEMA, description: 'Local position [x, y, z].' },
        rotation: { ...VEC3_SCHEMA, description: 'Local Euler rotation in radians [rx, ry, rz].' },
        scale: { ...VEC3_SCHEMA, description: 'Local scale [sx, sy, sz].' },
        visible: { type: 'boolean', description: 'Node visibility.' },
        pivot: { ...VEC3_SCHEMA, description: 'Optional pivot offset [px, py, pz].' },
        name: { type: 'string', description: 'Optional node display name.' },
        parentId: {
          type: ['string', 'null'],
          description: 'Parent forgeId (used when createIfMissing is true).',
        },
        type: { type: 'string', description: 'Node type (used when createIfMissing is true).' },
        createIfMissing: {
          type: 'boolean',
          description: 'If true, append a new node entry when forgeId does not exist yet.',
        },
        projectRoot: PROJECT_ROOT_PROP,
      },
      required: ['forgeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_animation_keyframe',
    description:
      'Add or update an animation keyframe for targetId at time (seconds) in .forge/scene.json, keeping keyframes sorted by time.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Stable forgeId of the animated node.' },
        time: { type: 'number', description: 'Keyframe timestamp in seconds (>= 0).' },
        position: { ...VEC3_SCHEMA, description: 'Position [x, y, z] at this keyframe.' },
        rotation: { ...VEC3_SCHEMA, description: 'Euler rotation [rx, ry, rz] in radians.' },
        scale: { ...VEC3_SCHEMA, description: 'Scale [sx, sy, sz] at this keyframe.' },
        easing: {
          type: 'string',
          enum: ['linear', 'easeInOut', 'easeIn', 'easeOut', 'step'],
          description: 'Interpolation easing mode.',
        },
        id: { type: 'string', description: 'Optional stable keyframe ID.' },
        projectRoot: PROJECT_ROOT_PROP,
      },
      required: ['targetId', 'time'],
      additionalProperties: false,
    },
  },
  {
    name: 'sync_code_export',
    description:
      'Generate or patch a React Three Fiber (.tsx) component file from .forge/scene.json using // @forge:begin ... // @forge:end markers.',
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: {
          type: 'string',
          description: 'Path to the R3F component file (relative to projectRoot or absolute).',
        },
        projectRoot: PROJECT_ROOT_PROP,
      },
      required: ['outputPath'],
      additionalProperties: false,
    },
  },
]

function asObject(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {}
  }
  return args as Record<string, unknown>
}

function resolveRoot(args: Record<string, unknown>, ctx: ToolContext): string {
  if (typeof args.projectRoot === 'string' && args.projectRoot.trim().length > 0) {
    return path.resolve(args.projectRoot)
  }
  return ctx.defaultProjectRoot
}

function assertVec3(value: unknown, label: string): Vec3 {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new Error(`${label} must be an array of 3 finite numbers`)
  }
  return [value[0], value[1], value[2]]
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function jsonText(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  }
}

export async function executeTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const args = asObject(rawArgs)
  const root = resolveRoot(args, ctx)

  switch (name) {
    case 'get_scene_summary': {
      const manifest = await readSceneManifest(root)
      return jsonText({
        manifestPath: resolveManifestPath(root),
        version: manifest.version,
        projectName: manifest.projectName,
        assetPath: manifest.assetPath,
        loopMode: manifest.loopMode,
        camera: manifest.camera,
        environment: {
          preset: manifest.environment.preset,
          background: manifest.environment.background,
          exposure: manifest.environment.exposure,
          xrEnabled: manifest.environment.xrEnabled,
          fog: manifest.environment.fog ?? null,
          lightCount: manifest.environment.lights.length,
          lights: manifest.environment.lights,
        },
        nodeCount: manifest.nodes.length,
        nodes: manifest.nodes,
        keyframeCount: manifest.keyframes.length,
        keyframes: manifest.keyframes,
      })
    }

    case 'set_camera_pose': {
      const hasUpdate =
        args.position !== undefined ||
        args.target !== undefined ||
        args.fov !== undefined ||
        args.near !== undefined ||
        args.far !== undefined
      if (!hasUpdate) {
        throw new Error('Provide at least one of: position, target, fov, near, far')
      }

      const manifest = await loadOrCreateSceneManifest(root)
      const nextCamera = { ...manifest.camera }

      if (args.position !== undefined) {
        nextCamera.position = assertVec3(args.position, 'position')
      }
      if (args.target !== undefined) {
        nextCamera.target = assertVec3(args.target, 'target')
      }
      if (args.fov !== undefined) {
        const fov = assertFiniteNumber(args.fov, 'fov')
        if (fov <= 0 || fov >= 180) {
          throw new Error('fov must be between 0 and 180 (exclusive)')
        }
        nextCamera.fov = fov
      }
      if (args.near !== undefined) {
        const near = assertFiniteNumber(args.near, 'near')
        if (near <= 0) throw new Error('near must be > 0')
        nextCamera.near = near
      }
      if (args.far !== undefined) {
        const far = assertFiniteNumber(args.far, 'far')
        if (far <= 0) throw new Error('far must be > 0')
        nextCamera.far = far
      }
      if (nextCamera.near >= nextCamera.far) {
        throw new Error('near must be strictly less than far')
      }

      manifest.camera = nextCamera
      const manifestPath = await writeSceneManifest(root, manifest)
      return jsonText({ ok: true, manifestPath, camera: manifest.camera })
    }

    case 'set_node_transform': {
      const forgeId = assertNonEmptyString(args.forgeId, 'forgeId')
      const hasUpdate =
        args.position !== undefined ||
        args.rotation !== undefined ||
        args.scale !== undefined ||
        args.visible !== undefined ||
        args.pivot !== undefined ||
        args.name !== undefined
      if (!hasUpdate && args.createIfMissing !== true) {
        throw new Error(
          'Provide at least one transform field (position, rotation, scale, visible, pivot, name)'
        )
      }

      const manifest = await loadOrCreateSceneManifest(root)
      let node = manifest.nodes.find((n) => n.forgeId === forgeId)

      if (!node) {
        if (args.createIfMissing !== true) {
          throw new Error(
            `Node "${forgeId}" not found in .forge/scene.json (pass createIfMissing: true to add it)`
          )
        }
        const parentId =
          args.parentId === null || typeof args.parentId === 'string' ? args.parentId : null
        const nodeType = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : 'Mesh'
        const newNode: NodeManifest = {
          forgeId,
          name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : forgeId,
          parentId,
          type: nodeType,
          visible: typeof args.visible === 'boolean' ? args.visible : true,
          position: args.position !== undefined ? assertVec3(args.position, 'position') : [0, 0, 0],
          rotation: args.rotation !== undefined ? assertVec3(args.rotation, 'rotation') : [0, 0, 0],
          scale: args.scale !== undefined ? assertVec3(args.scale, 'scale') : [1, 1, 1],
        }
        if (args.pivot !== undefined) {
          newNode.pivot = assertVec3(args.pivot, 'pivot')
        }
        manifest.nodes.push(newNode)
        node = newNode
      } else {
        if (args.position !== undefined) node.position = assertVec3(args.position, 'position')
        if (args.rotation !== undefined) node.rotation = assertVec3(args.rotation, 'rotation')
        if (args.scale !== undefined) node.scale = assertVec3(args.scale, 'scale')
        if (args.pivot !== undefined) node.pivot = assertVec3(args.pivot, 'pivot')
        if (args.visible !== undefined) {
          if (typeof args.visible !== 'boolean') {
            throw new Error('visible must be a boolean')
          }
          node.visible = args.visible
        }
        if (args.name !== undefined) {
          node.name = assertNonEmptyString(args.name, 'name')
        }
      }

      const manifestPath = await writeSceneManifest(root, manifest)
      return jsonText({ ok: true, manifestPath, node })
    }

    case 'add_animation_keyframe': {
      const targetId = assertNonEmptyString(args.targetId, 'targetId')
      const time = assertFiniteNumber(args.time, 'time')
      if (time < 0) {
        throw new Error('time must be >= 0')
      }

      let easing: EasingMode | undefined
      if (args.easing !== undefined) {
        if (typeof args.easing !== 'string' || !VALID_EASINGS.has(args.easing as EasingMode)) {
          throw new Error(
            `easing must be one of: ${Array.from(VALID_EASINGS).join(', ')}`
          )
        }
        easing = args.easing as EasingMode
      }

      const manifest = await loadOrCreateSceneManifest(root)
      const targetNode = manifest.nodes.find((n) => n.forgeId === targetId)

      const position =
        args.position !== undefined
          ? assertVec3(args.position, 'position')
          : ([...(targetNode?.position ?? [0, 0, 0])] as Vec3)
      const rotation =
        args.rotation !== undefined
          ? assertVec3(args.rotation, 'rotation')
          : ([...(targetNode?.rotation ?? [0, 0, 0])] as Vec3)
      const scale =
        args.scale !== undefined
          ? assertVec3(args.scale, 'scale')
          : ([...(targetNode?.scale ?? [1, 1, 1])] as Vec3)

      const explicitId = args.id !== undefined ? assertNonEmptyString(args.id, 'id') : undefined
      const existingIdx = manifest.keyframes.findIndex((kf) =>
        explicitId
          ? kf.id === explicitId
          : kf.targetId === targetId && Math.abs(kf.time - time) < 1e-6
      )

      const id =
        explicitId ??
        (existingIdx >= 0
          ? manifest.keyframes[existingIdx].id
          : `kf:${targetId}:${Number(time.toFixed(4))}`)

      const keyframe: KeyframeManifest = {
        id,
        targetId,
        time,
        position,
        rotation,
        scale,
        ...(easing ? { easing } : {}),
      }

      if (existingIdx >= 0) {
        manifest.keyframes[existingIdx] = keyframe
      } else {
        manifest.keyframes.push(keyframe)
      }

      manifest.keyframes.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
      const manifestPath = await writeSceneManifest(root, manifest)
      return jsonText({
        ok: true,
        manifestPath,
        updatedExisting: existingIdx >= 0,
        keyframe,
        totalKeyframes: manifest.keyframes.length,
      })
    }

    case 'sync_code_export': {
      const outputArg = assertNonEmptyString(args.outputPath, 'outputPath')
      const outputPath = path.isAbsolute(outputArg) ? outputArg : path.resolve(root, outputArg)
      const manifest = await readSceneManifest(root)

      const existed = await fileExists(outputPath)
      const nextSource = existed
        ? patchR3FFile(await readFile(outputPath, 'utf8'), manifest)
        : generateR3FComponent(manifest)

      await mkdir(path.dirname(outputPath), { recursive: true })
      await writeFile(outputPath, nextSource, 'utf8')

      return jsonText({
        ok: true,
        outputPath,
        mode: existed ? 'patched' : 'created',
        bytesWritten: nextSource.length,
      })
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
