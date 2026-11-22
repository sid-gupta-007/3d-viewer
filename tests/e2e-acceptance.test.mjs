import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import ts from 'typescript'

import { createDefaultManifest, validateSceneManifest } from '../src/domain/sceneManifest.ts'
import { generateR3FComponent, generateR3FSceneBlock, patchR3FFile } from '../src/export/r3f/r3fCodegen.ts'
import { useTimelineStore } from '../src/features/animation/timelineStore.ts'
import { ENVIRONMENT_PRESETS, createEnvironmentManifest } from '../src/features/environment/environmentPresets.ts'
import { splitMeshByConnectedIslands } from '../src/features/geometry/splitMesh.ts'
import { cycleMeshHit, pickAllVisibleMeshes, pickClosestVisibleMesh } from '../src/features/selection/pickMesh.ts'
import { selectMeshesInRect } from '../src/features/selection/viewportSelection.ts'
import { createPivotController } from '../src/renderer/three/pivots.ts'

// Node 24 shim for Three.js GLTFLoader.parseAsync
if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent extends Event {
    constructor(type, init = {}) {
      super(type)
      this.lengthComputable = Boolean(init.lengthComputable)
      this.loaded = Number(init.loaded ?? 0)
      this.total = Number(init.total ?? 0)
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Dynamic loaders for in-progress / planned modules (M1-M3)
// Keeps ESM link phase safe even while milestones are in progress.
// ---------------------------------------------------------------------------

async function loadVolumeSelector() {
  let mod
  try {
    mod = await import('../src/features/selection/volumeSelector.ts')
  } catch (error) {
    assert.fail(`Missing or unloadable volumeSelector module (M1): ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const fn of ['selectMeshesInBox', 'selectTrianglesInBox', 'extractTrianglesAsPart']) {
    assert.equal(typeof mod[fn], 'function', `volumeSelector.ts must export ${fn}()`)
  }
  return mod
}

async function loadHistoryStore() {
  let mod
  try {
    mod = await import('../src/features/history/historyStore.ts')
  } catch (error) {
    assert.fail(`Missing or unloadable historyStore module (M2): ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const fn of ['createHistoryStore', 'useHistoryStore', 'shouldIgnoreHistoryShortcut', 'matchHistoryShortcut']) {
    assert.ok(mod[fn] !== undefined, `historyStore.ts must export ${fn}`)
  }
  return mod
}

async function loadForgeExporter() {
  let mod
  try {
    mod = await import('../src/export/forgeExporter.ts')
  } catch (error) {
    assert.fail(`Missing or unloadable forgeExporter module (M3): ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const fn of [
    'resolveExportAssetPath',
    'validateExportPreconditions',
    'buildProjectData',
    'generateRuntimeJs',
    'buildExportZipEntries',
  ]) {
    assert.equal(typeof mod[fn], 'function', `forgeExporter.ts must export ${fn}()`)
  }
  return mod
}

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makeCamera(pos = [0, 0, 10], target = [0, 0, 0], fov = 50) {
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 100)
  camera.position.set(...pos)
  camera.lookAt(...target)
  camera.updateMatrixWorld(true)
  return camera
}

function makeMesh(forgeId, geometry, position = [0, 0, 0], name = forgeId) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  mesh.name = name
  mesh.userData.forgeId = forgeId
  mesh.position.set(...position)
  return mesh
}

function getTriangleCount(geometry) {
  const pos = geometry.getAttribute('position')
  if (!pos || pos.count < 3) return 0
  const idx = geometry.getIndex()
  return idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3)
}

function getTriangleWorldVertices(mesh, triIndex) {
  mesh.updateWorldMatrix(true, false)
  const pos = mesh.geometry.getAttribute('position')
  const idx = mesh.geometry.getIndex()
  const verts = []
  for (let c = 0; c < 3; c++) {
    const vi = idx ? idx.getX(triIndex * 3 + c) : triIndex * 3 + c
    verts.push(new THREE.Vector3().fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld))
  }
  return verts
}

function getAllWorldTriangleVertexKeys(mesh) {
  mesh.updateWorldMatrix(true, false)
  const triCount = getTriangleCount(mesh.geometry)
  const keys = []
  for (let t = 0; t < triCount; t++) {
    const verts = getTriangleWorldVertices(mesh, t)
    const triKey = verts
      .map((v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`)
      .sort()
      .join('|')
    keys.push(triKey)
  }
  return keys.sort()
}

function makeLShapedGeometry() {
  // Two rectangular strips forming an L in [-2, 2] x [-2, 2]:
  // Vertical strip: x in [-2, -1.6], y in [-2, 2]
  // Horizontal strip: x in [-2, 2], y in [-2, -1.6]
  // Top-right region x in [0.5, 1.8], y in [0.5, 1.8] is inside the AABB but completely empty!
  const positions = new Float32Array([
    // Vertical strip (2 tris)
    -2.0, -2.0, 0, -1.6, -2.0, 0, -1.6, 2.0, 0,
    -2.0, -2.0, 0, -1.6, 2.0, 0, -2.0, 2.0, 0,
    // Horizontal strip (2 tris)
    -2.0, -2.0, 0, 2.0, -2.0, 0, 2.0, -1.6, 0,
    -2.0, -2.0, 0, 2.0, -1.6, 0, -2.0, -1.6, 0,
  ])
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.computeVertexNormals()
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

function makeSingleTriangleGeometry(a, b, c) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...a, ...b, ...c]), 3))
  geo.computeVertexNormals()
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

function makeTwoSeparatedSubAssembliesGeometry() {
  // Single merged geometry containing 2 spatially separated boxes:
  // Cluster A centered near x = -3, Cluster B centered near x = +3
  const left = new THREE.BoxGeometry(1.5, 1.5, 1.5).toNonIndexed()
  left.translate(-3, 0, 0)
  const right = new THREE.BoxGeometry(1.5, 1.5, 1.5).toNonIndexed()
  right.translate(3, 0, 0)

  const posA = left.getAttribute('position')
  const posB = right.getAttribute('position')
  const normA = left.getAttribute('normal')
  const normB = right.getAttribute('normal')
  const uvA = left.getAttribute('uv')
  const uvB = right.getAttribute('uv')

  const totalVerts = posA.count + posB.count
  const pos = new Float32Array(totalVerts * 3)
  const norm = new Float32Array(totalVerts * 3)
  const uv = new Float32Array(totalVerts * 2)

  pos.set(posA.array, 0)
  pos.set(posB.array, posA.array.length)
  norm.set(normA.array, 0)
  norm.set(normB.array, normA.array.length)
  uv.set(uvA.array, 0)
  uv.set(uvB.array, uvA.array.length)

  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  merged.setAttribute('normal', new THREE.BufferAttribute(norm, 3))
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return { merged, leftTriCount: posA.count / 3, rightTriCount: posB.count / 3 }
}

async function parseGltfFixture(relativePath) {
  const raw = await readFile(path.join(ROOT_DIR, relativePath), 'utf8')
  const loader = new GLTFLoader()
  return loader.parseAsync(raw, '')
}

function assignDeterministicForgeIds(root, assetKey = 'model-0') {
  const objects = new Map()
  root.userData.forgeId = `${assetKey}:root`
  objects.set(root.userData.forgeId, root)
  root.traverse((obj) => {
    if (obj === root) return
    const indices = []
    let cur = obj
    while (cur.parent && cur.parent !== root) {
      indices.unshift(cur.parent.children.indexOf(cur))
      cur = cur.parent
    }
    indices.unshift(root.children.indexOf(cur))
    const id = `${assetKey}:${indices.join('.')}`
    obj.userData.forgeId = id
    objects.set(id, obj)
  })
  return objects
}

function makeSnapshot(overrides = {}) {
  return {
    nodes: overrides.nodes ?? [{ id: 'model:0', name: 'Body', type: 'Mesh', visible: true, parent: 'model:root' }],
    transforms: overrides.transforms ?? {
      'model:0': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    visibility: overrides.visibility ?? { 'model:0': true },
    pivots: overrides.pivots ?? {},
    frames: overrides.frames ?? [],
    selected: overrides.selected ?? 'model:0',
    selectedIds: overrides.selectedIds ?? ['model:0'],
    ...(overrides.geometrySnapshot !== undefined ? { geometrySnapshot: overrides.geometrySnapshot } : {}),
  }
}

async function readWorkspaceText(relPath) {
  return readFile(path.join(ROOT_DIR, relPath), 'utf8')
}

function assertValidModuleJsSyntax(source, label = 'generated JS') {
  const withoutImports = source.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
  assert.doesNotThrow(() => {
    new Function(`return (async () => {\n${withoutImports}\n});`)
  }, `${label} must be syntactically valid ES module JavaScript`)
}

function assertValidTsxSyntax(source, label = 'generated TSX') {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
  })
  const errors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  assert.equal(
    errors.length,
    0,
    `${label} had TypeScript syntax diagnostics: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`,
  )
}

function extractJsxElements(source, tagName) {
  const results = []
  const openNeedle = `<${tagName}`
  let idx = 0
  while (idx < source.length) {
    const start = source.indexOf(openNeedle, idx)
    if (start === -1) break
    const afterName = source[start + openNeedle.length]
    if (
      afterName !== ' ' &&
      afterName !== '\t' &&
      afterName !== '\n' &&
      afterName !== '\r' &&
      afterName !== '>' &&
      afterName !== '/'
    ) {
      idx = start + openNeedle.length
      continue
    }
    let pos = start + openNeedle.length
    let braceDepth = 0
    let quote = null
    let openEnd = -1
    let selfClosing = false
    while (pos < source.length) {
      const ch = source[pos]
      const prev = source[pos - 1]
      if (quote) {
        if (ch === quote && prev !== '\\') quote = null
        pos++
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch
        pos++
        continue
      }
      if (ch === '{') {
        braceDepth++
        pos++
        continue
      }
      if (ch === '}') {
        if (braceDepth > 0) braceDepth--
        pos++
        continue
      }
      if (braceDepth === 0 && ch === '>') {
        selfClosing = prev === '/'
        openEnd = pos + 1
        break
      }
      pos++
    }
    if (openEnd === -1) break
    const openingTag = source.slice(start, openEnd)
    if (selfClosing) {
      results.push({ openingTag, fullElement: openingTag, body: '' })
      idx = openEnd
      continue
    }
    const closeTag = `</${tagName}>`
    const closeIdx = source.indexOf(closeTag, openEnd)
    if (closeIdx === -1) {
      results.push({ openingTag, fullElement: openingTag, body: '' })
      idx = openEnd
      continue
    }
    const fullElement = source.slice(start, closeIdx + closeTag.length)
    const body = source.slice(openEnd, closeIdx)
    results.push({ openingTag, fullElement, body })
    idx = closeIdx + closeTag.length
  }
  return results
}

function invokeExportValidation(exporter, input) {
  try {
    const res = exporter.validateExportPreconditions(input)
    if (res && typeof res === 'object' && 'ok' in res && !res.ok) {
      return { valid: false, message: String(res.error ?? res.message ?? 'Export validation failed') }
    }
    return { valid: true, message: '' }
  } catch (error) {
    if (error instanceof TypeError) throw error
    return { valid: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function makeExporterInput(overrides = {}) {
  const assetFiles = overrides.assetFiles ?? [{ name: 'RobotArm.glb' }]
  const assetResourcePaths = overrides.assetResourcePaths ?? assetFiles.map((f) => f.name)
  const frames = overrides.frames ?? overrides.keyframes ?? []
  return {
    projectName: overrides.projectName ?? 'Arm Demo',
    assetKey: overrides.assetKey ?? 'model-1',
    assetFiles,
    assetResourcePaths,
    duration: overrides.duration ?? 5,
    loopMode: overrides.loopMode ?? 'loop',
    cameraPose: overrides.cameraPose ?? overrides.camera ?? { position: [4.6, 3.6, 6.8], target: [0, 0.8, 0], fov: 38, near: 0.1, far: 100 },
    envPreset: overrides.envPreset ?? overrides.environment?.preset ?? 'studio',
    xrEnabled: overrides.xrEnabled ?? overrides.environment?.xrEnabled ?? false,
    nodes: overrides.nodes ?? [
      { id: 'model-1:root', name: 'Root', type: 'Group', visible: true, parent: null },
      { id: 'model-1:0', name: 'Arm', type: 'Mesh', visible: true, parent: 'model-1:root' },
    ],
    transforms: overrides.transforms ?? {
      'model-1:root': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      'model-1:0': { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    frames,
    effects: overrides.effects ?? [],
    pivots: overrides.pivots ?? {},
    ...(overrides.splits !== undefined ? { splits: overrides.splits } : {}),
  }
}

beforeEach(() => {
  useTimelineStore.getState().reset()
})

afterEach(() => {
  useTimelineStore.getState().reset()
})

// ===========================================================================
// TIER 1 — FEATURE COVERAGE (31 tests across 5 domains)
// ===========================================================================

describe('Tier 1 — Feature Coverage', () => {
  describe('Domain A: GLB Pointer Picking & 2D Marquee (F1, F2)', () => {
    test('T1-A1: pickClosestVisibleMesh & pickAllVisibleMeshes handle nested GLB hierarchy nearest-first without manual updateMatrixWorld', () => {
      const scene = new THREE.Scene()
      const camera = makeCamera([0, 0, 10], [0, 0, 0])

      const root = new THREE.Group()
      root.userData.forgeId = 'model:root'
      const subGroup = new THREE.Group()
      subGroup.position.set(0, 0, 0)
      subGroup.rotation.set(0, 0, 0)
      const meshA = makeMesh('model:0.0', new THREE.BoxGeometry(1.5, 1.5, 1), [0, 0, 1])
      const meshB = makeMesh('model:0.1', new THREE.BoxGeometry(2.5, 2.5, 1), [0, 0, -1])

      subGroup.add(meshA, meshB)
      root.add(subGroup)
      scene.add(root)
      // Deliberately omit scene.updateMatrixWorld(true)

      const objects = new Map([
        ['model:root', root],
        ['model:0.0', meshA],
        ['model:0.1', meshB],
      ])
      const raycaster = new THREE.Raycaster()
      const pointer = new THREE.Vector2(0, 0)

      const closest = pickClosestVisibleMesh(objects, camera, raycaster, pointer)
      const all = pickAllVisibleMeshes(objects, camera, raycaster, pointer)

      assert.equal(closest?.object.userData.forgeId, 'model:0.0')
      assert.deepEqual(
        all.map((h) => h.object.userData.forgeId),
        ['model:0.0', 'model:0.1'],
      )
    })

    test('T1-A2: cycleMeshHit cycles through occluded concentric meshes and wraps back to first', () => {
      const scene = new THREE.Scene()
      const camera = makeCamera([0, 0, 10], [0, 0, 0])
      const outer = makeMesh('outer', new THREE.BoxGeometry(4, 4, 4), [0, 0, 0])
      const mid = makeMesh('mid', new THREE.BoxGeometry(2, 2, 2), [0, 0, 0])
      const inner = makeMesh('inner', new THREE.BoxGeometry(0.8, 0.8, 0.8), [0, 0, 0])
      scene.add(outer, mid, inner)

      const objects = new Map([
        ['outer', outer],
        ['mid', mid],
        ['inner', inner],
      ])
      const hits = pickAllVisibleMeshes(objects, camera, new THREE.Raycaster(), new THREE.Vector2(0, 0))
      assert.deepEqual(hits.map((h) => h.object.userData.forgeId), ['outer', 'mid', 'inner'])

      assert.equal(cycleMeshHit(hits, null)?.object.userData.forgeId, 'outer')
      assert.equal(cycleMeshHit(hits, 'outer')?.object.userData.forgeId, 'mid')
      assert.equal(cycleMeshHit(hits, 'mid')?.object.userData.forgeId, 'inner')
      assert.equal(cycleMeshHit(hits, 'inner')?.object.userData.forgeId, 'outer')
    })

    test('T1-A3: pointer picking skips visible mesh under hidden ancestor and hits visible sibling behind it', () => {
      const scene = new THREE.Scene()
      const camera = makeCamera([0, 0, 10], [0, 0, 0])

      const hiddenParent = new THREE.Group()
      hiddenParent.visible = false
      const occludedChild = makeMesh('hidden-child', new THREE.BoxGeometry(2, 2, 1), [0, 0, 2])
      hiddenParent.add(occludedChild)

      const visibleSibling = makeMesh('visible-sibling', new THREE.BoxGeometry(2, 2, 1), [0, 0, -1])
      scene.add(hiddenParent, visibleSibling)

      const objects = new Map([
        ['hidden-child', occludedChild],
        ['visible-sibling', visibleSibling],
      ])
      const hits = pickAllVisibleMeshes(objects, camera, new THREE.Raycaster(), new THREE.Vector2(0, 0))
      assert.deepEqual(hits.map((h) => h.object.userData.forgeId), ['visible-sibling'])
      assert.equal(
        pickClosestVisibleMesh(objects, camera, new THREE.Raycaster(), new THREE.Vector2(0, 0))?.object.userData.forgeId,
        'visible-sibling',
      )
    })

    test('T1-A4: 2D marquee selects contained meshes left-to-right and crossing meshes right-to-left', () => {
      const scene = new THREE.Scene()
      const camera = makeCamera([0, 0, 10], [0, 0, 0])
      const inside = makeMesh('inside', new THREE.BoxGeometry(1, 1, 1), [-1, 0, 0])
      const crossing = makeMesh('crossing', new THREE.BoxGeometry(1, 1, 1), [1.7, 0, 0])
      const outside = makeMesh('outside', new THREE.BoxGeometry(1, 1, 1), [4.5, 0, 0])
      scene.add(inside, crossing, outside)

      const objects = new Map([
        ['inside', inside],
        ['crossing', crossing],
        ['outside', outside],
      ])
      const rect = { minX: 190, maxX: 400, minY: 260, maxY: 340 }

      assert.deepEqual(selectMeshesInRect(objects, camera, 600, 600, rect, false), ['inside'])
      assert.deepEqual(selectMeshesInRect(objects, camera, 600, 600, rect, true), ['inside', 'crossing'])
    })

    test('T1-A5: 2D marquee detects dense >2000-vertex mesh localized patch without stride subsampling blind spots', () => {
      const scene = new THREE.Scene()
      const camera = makeCamera([0, 0, 10], [0, 0, 0])
      // 2500 triangles = 7500 vertices: 2499 far left at x=-3.5, 1 tiny triangle at stride-skipped index 1234 near origin
      const triCount = 2500
      const positions = new Float32Array(triCount * 9)
      for (let t = 0; t < triCount; t++) {
        const base = t * 9
        positions[base] = -3.5
        positions[base + 1] = -0.2
        positions[base + 2] = 0
        positions[base + 3] = -3.4
        positions[base + 4] = -0.2
        positions[base + 5] = 0
        positions[base + 6] = -3.45
        positions[base + 7] = -0.1
        positions[base + 8] = 0
      }
      // Triangle 1234 has vertex indices 3702, 3703, 3704 — skipped by floor(7500/512)=14 and ceil(7500/512)=15 strides
      const targetTri = 1234
      positions.set([-0.02, -0.02, 0, 0.02, -0.02, 0, 0, 0.02, 0], targetTri * 9)
      const patchGeo = new THREE.BufferGeometry()
      patchGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      assert.ok(patchGeo.getAttribute('position').count > 2000)
      const patchMesh = makeMesh('dense-patch', patchGeo, [0, 0, 0])

      const denseSphere = makeMesh('dense-sphere', new THREE.SphereGeometry(0.5, 64, 32), [2.5, 2.5, 0])
      assert.ok(denseSphere.geometry.getAttribute('position').count > 2000)
      scene.add(patchMesh, denseSphere)

      const objects = new Map([
        ['dense-patch', patchMesh],
        ['dense-sphere', denseSphere],
      ])
      const centerRect = { minX: 295, maxX: 305, minY: 295, maxY: 305 }
      assert.deepEqual(selectMeshesInRect(objects, camera, 600, 600, centerRect, true), ['dense-patch'])
      assert.deepEqual(selectMeshesInRect(objects, camera, 600, 600, centerRect, false), [])
    })

    test('T1-A6: 2D marquee avoids coarse screen-space AABB false positives on L-shaped geometry', () => {
      const scene = new THREE.Scene()
      const camera = makeCamera([0, 0, 10], [0, 0, 0])
      const lMesh = makeMesh('l-shape', makeLShapedGeometry(), [0, 0, 0])
      scene.add(lMesh)

      const objects = new Map([['l-shape', lMesh]])
      // Top-right quadrant: overlaps the bounding box of the L-shape, but zero actual triangles lie here
      const emptyAabbPocket = { minX: 360, maxX: 420, minY: 180, maxY: 240 }
      assert.deepEqual(selectMeshesInRect(objects, camera, 600, 600, emptyAabbPocket, true), [])
    })
  })

  describe('Domain B: 3D Volume Selector & Triangle Extraction (F3, F4)', () => {
    test('T1-B1: selectMeshesInBox returns visible meshes intersecting worldBox and selectTrianglesInBox rejects empty diagonal AABB corners', async () => {
      const { selectMeshesInBox, selectTrianglesInBox } = await loadVolumeSelector()
      const scene = new THREE.Scene()
      const left = makeMesh('left', new THREE.BoxGeometry(1, 1, 1), [-3, 0, 0])
      const center = makeMesh('center', new THREE.BoxGeometry(1, 1, 1), [0, 0, 0])
      const right = makeMesh('right', new THREE.BoxGeometry(1, 1, 1), [3, 0, 0])
      scene.add(left, center, right)

      const map = new Map([
        ['left', left],
        ['center', center],
        ['right', right],
      ])
      const worldBox = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(4, 1, 1))
      assert.deepEqual(selectMeshesInBox(map, worldBox), ['center', 'right'])

      // Diagonal mesh whose world AABB [-2, 2] x [-2, 2] overlaps emptyCornerBox, yet zero triangles touch it
      const diagGeo = new THREE.BufferGeometry()
      diagGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(
          new Float32Array([
            -2, -2, 0, -1.8, -2, 0, 2, 2, 0,
            -2, -2, 0, 2, 2, 0, 1.8, 2, 0,
          ]),
          3,
        ),
      )
      const diagMesh = makeMesh('diag', diagGeo, [0, 0, 0])
      const emptyCornerBox = new THREE.Box3(new THREE.Vector3(0.8, -2, -1), new THREE.Vector3(2, -0.8, 1))
      assert.deepEqual(selectTrianglesInBox(diagMesh, emptyCornerBox, 'centroid'), [])
      assert.deepEqual(selectTrianglesInBox(diagMesh, emptyCornerBox, 'intersects'), [])
    })

    test('T1-B2: selectTrianglesInBox selects strictly triangles with centroids inside worldBox', async () => {
      const { selectTrianglesInBox } = await loadVolumeSelector()
      const mesh = makeMesh('box', new THREE.BoxGeometry(2, 2, 2, 2, 2, 2), [0, 0, 0])
      const worldBox = new THREE.Box3(new THREE.Vector3(0.01, -2, -2), new THREE.Vector3(2, 2, 2))

      const indices = selectTrianglesInBox(mesh, worldBox, 'centroid')
      assert.equal(indices.length, 24)
      for (const idx of indices) {
        const verts = getTriangleWorldVertices(mesh, idx)
        const centroid = verts[0].clone().add(verts[1]).add(verts[2]).multiplyScalar(1 / 3)
        assert.ok(worldBox.containsPoint(centroid), `Triangle ${idx} centroid must be inside worldBox`)
      }
    })

    test('T1-B3: selectTrianglesInBox intersects mode detects triangles crossing box whose vertices & centroid lie outside', async () => {
      const { selectTrianglesInBox } = await loadVolumeSelector()
      const mesh = makeMesh('big-tri', makeSingleTriangleGeometry([-5, 0, 0], [5, 0, 0], [0, 5, 0]))
      const worldBox = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5))

      assert.deepEqual(selectTrianglesInBox(mesh, worldBox, 'centroid'), [])
      assert.deepEqual(selectTrianglesInBox(mesh, worldBox, 'intersects'), [0])
    })

    test('T1-B4: extractTrianglesAsPart creates sibling mesh with centered local pivot and metadata while conserving triangle count', async () => {
      const { selectTrianglesInBox, extractTrianglesAsPart } = await loadVolumeSelector()
      const root = new THREE.Group()
      const mesh = makeMesh('model:0', new THREE.BoxGeometry(2, 2, 2, 2, 2, 2), [0, 0, 0], 'Body')
      root.add(mesh)

      const totalTris = getTriangleCount(mesh.geometry)
      const worldBox = new THREE.Box3(new THREE.Vector3(0.01, -2, -2), new THREE.Vector3(2, 2, 2))
      const selectedTris = selectTrianglesInBox(mesh, worldBox, 'centroid')
      assert.equal(selectedTris.length, 24)

      const result = extractTrianglesAsPart(mesh, selectedTris)
      assert.ok(result !== null)
      assert.equal(result.removedCount, 24)
      assert.equal(result.remainingCount, totalTris - 24)
      assert.equal(result.removedCount + result.remainingCount, totalTris)
      assert.equal(getTriangleCount(result.part.geometry), 24)
      assert.equal(getTriangleCount(result.remainingGeometry), totalTris - 24)
      assert.equal(result.part.userData.splitFrom, 'model:0')
      assert.equal(typeof result.part.userData.forgeId, 'string')
      assert.ok(result.part.userData.forgeId.length > 0)

      result.part.geometry.computeBoundingBox()
      const localCenter = result.part.geometry.boundingBox.getCenter(new THREE.Vector3())
      assert.ok(localCenter.length() < 1e-4, `Expected centered local geometry, got ${localCenter.toArray()}`)
    })

    test('T1-B5: extractTrianglesAsPart preserves world-space vertex positions on extracted part and removes them from source', async () => {
      const { selectTrianglesInBox, extractTrianglesAsPart } = await loadVolumeSelector()
      const parent = new THREE.Group()
      parent.position.set(1, 2, -1)
      const mesh = makeMesh('model:0', new THREE.BoxGeometry(2, 2, 2, 2, 2, 2), [0.5, -0.5, 1])
      parent.add(mesh)
      parent.updateMatrixWorld(true)

      const beforeAllKeys = getAllWorldTriangleVertexKeys(mesh)
      const worldBox = new THREE.Box3(new THREE.Vector3(1.51, -1, -2), new THREE.Vector3(5, 5, 5))
      const triIndices = selectTrianglesInBox(mesh, worldBox, 'centroid')
      assert.ok(triIndices.length > 0 && triIndices.length < getTriangleCount(mesh.geometry))

      const expectedExtractedKeys = triIndices
        .map((idx) =>
          getTriangleWorldVertices(mesh, idx)
            .map((v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`)
            .sort()
            .join('|'),
        )
        .sort()

      const result = extractTrianglesAsPart(mesh, triIndices)
      assert.ok(result !== null)
      mesh.geometry = result.remainingGeometry
      parent.add(result.part)
      parent.updateMatrixWorld(true)

      const actualExtractedKeys = getAllWorldTriangleVertexKeys(result.part)
      const actualRemainingKeys = getAllWorldTriangleVertexKeys(mesh)
      assert.deepEqual(actualExtractedKeys, expectedExtractedKeys)
      assert.deepEqual([...actualExtractedKeys, ...actualRemainingKeys].sort(), beforeAllKeys)
    })

    test('T1-B6: SceneViewport exposes ViewportApi 3D volume box methods and gizmo wiring', async () => {
      const viewportSrc = await readWorkspaceText('src/SceneViewport.tsx')
      assert.match(viewportSrc, /setVolumeBoxMode\??:\s*\(mode:\s*'translate'\s*\|\s*'scale'\)\s*=>\s*void/)
      assert.match(viewportSrc, /getVolumeSelection\??:\s*\(\)\s*=>/)
      assert.match(viewportSrc, /extractBoxSelection\??:\s*\(\)\s*=>/)
      assert.match(viewportSrc, /Box3Helper/)
      assert.match(viewportSrc, /TransformControls/)
    })
  })

  describe('Domain C: Unified Export & R3F Codegen (F7, F8)', () => {
    test('T1-C1: resolveExportAssetPath uses actual imported filename instead of fabricating from projectName', async () => {
      const { resolveExportAssetPath } = await loadForgeExporter()
      const resolved = resolveExportAssetPath([{ name: 'Drone_V2.glb' }], ['Drone_V2.glb'], 'My Cool Project', 0)
      assert.deepEqual(resolved, {
        manifestAssetPath: './assets/Drone_V2.glb',
        archiveAssetPath: 'assets/Drone_V2.glb',
        fileName: 'Drone_V2.glb',
      })
    })

    test('T1-C2: .tsx, .forge.js, and .forge.zip reference consistent asset path for RobotArm.glb', async () => {
      const exporter = await loadForgeExporter()
      const input = makeExporterInput({
        projectName: 'Arm Demo',
        assetFiles: [{ name: 'RobotArm.glb' }],
        assetResourcePaths: ['RobotArm.glb'],
      })

      const pathInfo = exporter.resolveExportAssetPath(input.assetFiles, input.assetResourcePaths, input.projectName, 0)
      assert.equal(pathInfo.manifestAssetPath, './assets/RobotArm.glb')
      assert.equal(pathInfo.archiveAssetPath, 'assets/RobotArm.glb')

      const projectData = exporter.buildProjectData(input)
      const runtimeJs = exporter.generateRuntimeJs(projectData)
      const zipEntries = exporter.buildExportZipEntries(input)

      const manifest = createDefaultManifest(input.projectName, pathInfo.manifestAssetPath)
      const tsx = generateR3FComponent(manifest)

      assert.ok(tsx.includes(`assetPath: './assets/RobotArm.glb'`))
      assert.ok(runtimeJs.includes(`assets/RobotArm.glb`))
      assert.equal(projectData.assets[0].path, 'assets/RobotArm.glb')

      const entryKeys = Array.isArray(zipEntries)
        ? zipEntries.map((e) => e.path ?? e.name)
        : Object.keys(zipEntries)
      for (const expectedKey of ['project.json', 'assets/RobotArm.glb', 'src/main.js', 'index.html', 'package.json', 'README.md']) {
        assert.ok(entryKeys.includes(expectedKey), `ZIP entries missing ${expectedKey}`)
      }
    })

    test('T1-C3: R3F codegen preserves root node (parentId === null) normalization transform', () => {
      const manifest = createDefaultManifest('NormalizedScene', './assets/rig.glb')
      manifest.nodes = [
        {
          forgeId: 'rig:root',
          name: 'Root',
          parentId: null,
          type: 'Group',
          visible: true,
          position: [0, 0.5, 0],
          rotation: [0, 0.25, 0],
          scale: [1.5, 1.5, 1.5],
        },
        {
          forgeId: 'rig:0',
          name: 'Chassis',
          parentId: 'rig:root',
          type: 'Mesh',
          visible: true,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ]

      const block = generateR3FSceneBlock(manifest)
      assert.ok(block.includes(`'rig:root'`), 'FORGE_SCENE_CONFIG.nodes must include root normalization node')
      assert.ok(block.includes('[1.5, 1.5, 1.5]'), 'Root normalization scale must be emitted in R3F block')
    })

    test('T1-C4: R3F codegen supports deterministic traversal forgeIds, pivots, useFrame keyframes, and splitFrom parts', () => {
      const manifest = createDefaultManifest('AnimatedMech', './assets/mech.glb')
      manifest.nodes = [
        {
          forgeId: 'mech:root',
          name: 'Root',
          parentId: null,
          type: 'Group',
          visible: true,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        {
          forgeId: 'mech:0.1',
          name: 'ArmPart',
          parentId: 'mech:0',
          type: 'Mesh',
          visible: true,
          position: [1, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          pivot: [0.2, -0.1, 0],
          splitFrom: 'mech:0',
        },
      ]
      manifest.keyframes = [
        { id: 'k1', targetId: 'mech:0.1', time: 0, position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        { id: 'k2', targetId: 'mech:0.1', time: 2, position: [3, 0, 0], rotation: [0, 1.5, 0], scale: [1, 1, 1] },
      ]

      const tsx = generateR3FComponent(manifest)
      assertValidTsxSyntax(tsx, 'T1-C4 R3F TSX')
      assert.match(tsx, /useFrame/, 'R3F export with keyframes must animate via useFrame')
      assert.ok(tsx.includes('0.2') && tsx.includes('-0.1'), 'R3F export must emit node pivot')
      assert.ok(tsx.includes('mech:0.1'), 'R3F export must include extracted/split part forgeId')

      // Inspect runtime traversal logic OUTSIDE FORGE_SCENE_CONFIG (do not match config object keys trivially)
      const runtimeStart = tsx.indexOf('export function ForgeStageContent')
      assert.ok(runtimeStart !== -1, 'Generated TSX must export ForgeStageContent')
      const runtimeCode = tsx.slice(runtimeStart)
      assert.ok(runtimeCode.includes('children.indexOf'), 'R3F runtime must compute deterministic forgeIds via children.indexOf traversal')
      assert.match(runtimeCode, /\.name\s*===\s*.*\.name\b/, 'R3F runtime must implement name-based fallback matching')
      assert.ok(runtimeCode.includes('splitFrom'), 'R3F runtime must handle splitFrom parts during matching/replay')
    })

    test('T1-C5: camera, sunset environment, xrEnabled, and pingpong loopMode propagate to .tsx, .forge.js, and .forge.zip', async () => {
      const exporter = await loadForgeExporter()
      const env = createEnvironmentManifest('sunset', { xrEnabled: true })
      const camera = { position: [3, 4, 5], target: [0, 1, 0], fov: 52, near: 0.2, far: 250 }
      const input = makeExporterInput({
        projectName: 'SunsetStage',
        assetFiles: [{ name: 'Stage.glb' }],
        camera,
        environment: env,
        loopMode: 'pingpong',
      })

      const projectData = exporter.buildProjectData(input)
      const runtimeJs = exporter.generateRuntimeJs(projectData)
      assertValidModuleJsSyntax(runtimeJs, 'T1-C5 runtime JS')

      const r3f = exporter.generateR3FFromEditor(input)
      assertValidTsxSyntax(r3f.code, 'T1-C5 R3F TSX')
      const tsx = r3f.code

      assert.ok(tsx.includes('preset="sunset"') || tsx.includes("preset='sunset'"))
      assert.ok(tsx.includes('fov: 52'))
      assert.ok(tsx.includes('xrEnabled: true'))
      assert.ok(tsx.includes('pingpong'))

      assert.ok(runtimeJs.includes('sunset') || runtimeJs.includes(env.background))
      assert.ok(runtimeJs.includes('52'))
      assert.ok(runtimeJs.includes('pingpong'))
      assert.equal(projectData.loopMode, 'pingpong')
      assert.equal(projectData.camera.fov, 52)
    })

    test('T1-C6: patchR3FFile updates only @forge:begin..@forge:end markers and leaves surrounding user code intact', () => {
      const initial = createDefaultManifest('PatchedApp', './assets/bot.glb')
      const originalTsx = [
        "import { useState } from 'react'",
        generateR3FComponent(initial),
        'export const CUSTOM_USER_CONST = { keep: true }',
        'export function helper() { return 123 }',
      ].join('\n')

      const updated = createDefaultManifest('PatchedApp', './assets/bot.glb')
      updated.camera.position = [9, 8, 7]
      updated.camera.fov = 60

      const patched = patchR3FFile(originalTsx, updated)
      assert.ok(patched.includes('position: [9, 8, 7]'))
      assert.ok(patched.includes('fov: 60'))
      assert.ok(patched.includes("import { useState } from 'react'"))
      assert.ok(patched.includes('export const CUSTOM_USER_CONST = { keep: true }'))
      assert.ok(patched.includes('export function helper() { return 123 }'))
    })

    test('T1-C7: sceneManifest, r3fCodegen, and forgeExporter execute in Node 24 without DOM globals', async () => {
      const exporter = await loadForgeExporter()
      assert.equal(typeof globalThis.window, 'undefined')
      assert.equal(typeof globalThis.document, 'undefined')

      const pathInfo = exporter.resolveExportAssetPath([{ name: 'Headless.glb' }], ['Headless.glb'], 'HeadlessTest', 0)
      const manifest = createDefaultManifest('HeadlessTest', pathInfo.manifestAssetPath)
      assert.equal(validateSceneManifest(manifest), true)
      const tsx = generateR3FComponent(manifest)
      assert.match(tsx, /export function HeadlessTest\(\)/)
      const projectData = exporter.buildProjectData(makeExporterInput({ assetFiles: [{ name: 'Headless.glb' }] }))
      const runtime = exporter.generateRuntimeJs(projectData)
      assert.ok(runtime.includes('Headless.glb'))
    })
  })

  describe('Domain D: Undo/Redo History & Scene Restoration (F5, F6)', () => {
    test('T1-D1: createHistoryStore and useHistoryStore singleton support pushState, undo, redo, canUndo, and canRedo transitions', async () => {
      const { createHistoryStore, useHistoryStore } = await loadHistoryStore()
      const store = createHistoryStore()
      const s0 = makeSnapshot({ transforms: { 'model:0': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } } })
      const s1 = makeSnapshot({ transforms: { 'model:0': { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } } })

      store.getState().pushState(s0)
      store.getState().pushState(s1)
      assert.equal(store.getState().canUndo, true)
      assert.equal(store.getState().canRedo, false)

      const undone = store.getState().undo()
      assert.deepEqual(undone?.transforms['model:0'].position, [0, 0, 0])
      assert.equal(store.getState().canRedo, true)

      const redone = store.getState().redo()
      assert.deepEqual(redone?.transforms['model:0'].position, [2, 0, 0])
      assert.equal(store.getState().canRedo, false)

      // Also exercise the global useHistoryStore singleton and clean up afterwards
      useHistoryStore.getState().clear()
      try {
        useHistoryStore.getState().pushState(s0)
        useHistoryStore.getState().pushState(s1)
        assert.equal(useHistoryStore.getState().canUndo, true)
        assert.deepEqual(useHistoryStore.getState().undo()?.transforms['model:0'].position, [0, 0, 0])
        assert.deepEqual(useHistoryStore.getState().redo()?.transforms['model:0'].position, [2, 0, 0])
      } finally {
        useHistoryStore.getState().clear()
      }
      assert.equal(useHistoryStore.getState().canUndo, false)
      assert.equal(useHistoryStore.getState().canRedo, false)
    })

    test('T1-D2: history store round-trips transforms, triangle extraction, pivots, visibility, and keyframes across all 5 transitions', async () => {
      const { createHistoryStore } = await loadHistoryStore()
      const store = createHistoryStore()

      const s0 = makeSnapshot({
        nodes: [{ id: 'm:0', name: 'Body', type: 'Mesh', visible: true, parent: 'm:root' }],
        transforms: { 'm:0': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        visibility: { 'm:0': true },
        pivots: {},
        frames: [],
      })
      const s1Transform = makeSnapshot({
        ...s0,
        transforms: { 'm:0': { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      })
      const s2Extract = makeSnapshot({
        ...s1Transform,
        nodes: [
          { id: 'm:0', name: 'Body', type: 'Mesh', visible: true, parent: 'm:root' },
          { id: 'm:0:extract', name: 'Body_extracted', type: 'Mesh', visible: true, parent: 'm:root' },
        ],
        geometrySnapshot: { tag: 'extracted-geo' },
      })
      const s3Pivot = makeSnapshot({
        ...s2Extract,
        pivots: { 'm:0:extract': [0.2, 0.3, 0] },
      })
      const s4Visibility = makeSnapshot({
        ...s3Pivot,
        visibility: { 'm:0': false },
      })
      const s5Keyframe = makeSnapshot({
        ...s4Visibility,
        frames: [{ id: 'kf1', targetId: 'm:0:extract', time: 1.5, position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
      })

      for (const snap of [s0, s1Transform, s2Extract, s3Pivot, s4Visibility, s5Keyframe]) {
        store.getState().pushState(snap)
      }

      // 5 undos from s5Keyframe -> s4Visibility -> s3Pivot -> s2Extract -> s1Transform -> s0
      const u4 = store.getState().undo()
      assert.equal(u4?.visibility['m:0'], false)
      assert.equal(u4?.frames.length, 0)

      const u3 = store.getState().undo()
      assert.equal(u3?.visibility['m:0'], true)
      assert.deepEqual(u3?.pivots['m:0:extract'], [0.2, 0.3, 0])

      const u2 = store.getState().undo()
      assert.deepEqual(u2?.pivots, {})
      assert.equal(u2?.nodes.length, 2)

      const u1 = store.getState().undo()
      assert.equal(u1?.nodes.length, 1)
      assert.deepEqual(u1?.transforms['m:0'].position, [1, 2, 3])

      const u0 = store.getState().undo()
      assert.deepEqual(u0?.transforms['m:0'].position, [0, 0, 0])
      assert.equal(store.getState().canUndo, false)

      // 5 redos forward s0 -> s1Transform -> s2Extract -> s3Pivot -> s4Visibility -> s5Keyframe
      const r1 = store.getState().redo()
      assert.deepEqual(r1?.transforms['m:0'].position, [1, 2, 3])

      const r2 = store.getState().redo()
      assert.equal(r2?.nodes.length, 2)

      const r3 = store.getState().redo()
      assert.deepEqual(r3?.pivots['m:0:extract'], [0.2, 0.3, 0])

      const r4 = store.getState().redo()
      assert.equal(r4?.visibility['m:0'], false)
      assert.equal(r4?.frames.length, 0)

      const finalRedone = store.getState().redo()
      assert.equal(finalRedone?.frames.length, 1)
      assert.equal(finalRedone?.visibility['m:0'], false)
      assert.deepEqual(finalRedone?.pivots['m:0:extract'], [0.2, 0.3, 0])
      assert.equal(finalRedone?.nodes.length, 2)
      assert.equal(store.getState().canRedo, false)
    })

    test('T1-D3: matchHistoryShortcut matches Ctrl+Z, Ctrl+Y, and Ctrl+Shift+Z', async () => {
      const { matchHistoryShortcut } = await loadHistoryStore()
      assert.equal(matchHistoryShortcut({ key: 'z', ctrlKey: true }), 'undo')
      assert.equal(matchHistoryShortcut({ key: 'y', ctrlKey: true }), 'redo')
      assert.equal(matchHistoryShortcut({ key: 'z', ctrlKey: true, shiftKey: true }), 'redo')
    })

    test('T1-D4: shouldIgnoreHistoryShortcut allows DIV/null and ignores INPUT/SELECT', async () => {
      const { shouldIgnoreHistoryShortcut } = await loadHistoryStore()
      assert.equal(shouldIgnoreHistoryShortcut(null), false)
      assert.equal(shouldIgnoreHistoryShortcut({ tagName: 'DIV' }), false)
      assert.equal(shouldIgnoreHistoryShortcut({ tagName: 'INPUT' }), true)
      assert.equal(shouldIgnoreHistoryShortcut({ tagName: 'SELECT' }), true)
    })

    test('T1-D5: SceneViewport exposes captureSceneSnapshot, restoreSceneSnapshot, and transform commit hook', async () => {
      const viewportSrc = await readWorkspaceText('src/SceneViewport.tsx')
      assert.match(viewportSrc, /captureSceneSnapshot\??:\s*\([^)]*\)\s*(?:=>|:)/)
      assert.match(viewportSrc, /restoreSceneSnapshot\??:\s*\([^)]*\)\s*(?:=>|:)/)
      assert.match(viewportSrc, /onTransformCommit|onTransformEnd|onTransformDragEnd/)
      assert.match(viewportSrc, /dragging-changed/)
    })

    test('T1-D6: history store clear() resets past, future, canUndo, canRedo, and disposes retained BufferGeometry', async () => {
      const { createHistoryStore } = await loadHistoryStore()
      const store = createHistoryStore()
      const geo1 = new THREE.BoxGeometry(1, 1, 1)
      const geo2 = new THREE.BoxGeometry(2, 2, 2)
      let disposeCalls = 0
      const origProtoDispose = THREE.BufferGeometry.prototype.dispose
      THREE.BufferGeometry.prototype.dispose = function () {
        disposeCalls++
        return origProtoDispose.call(this)
      }

      try {
        store.getState().pushState(makeSnapshot({ geometrySnapshot: { 'model:0': geo1 } }))
        store.getState().pushState(makeSnapshot({ selected: 'other', geometrySnapshot: { 'model:0': geo2 } }))
        store.getState().undo()

        store.getState().clear()
        assert.equal(store.getState().past.length, 0)
        assert.equal(store.getState().future.length, 0)
        assert.equal(store.getState().canUndo, false)
        assert.equal(store.getState().canRedo, false)
        assert.ok(disposeCalls >= 1, 'clear() must dispose retained BufferGeometry instances in geometrySnapshot')
      } finally {
        THREE.BufferGeometry.prototype.dispose = origProtoDispose
        geo1.dispose()
        geo2.dispose()
      }
    })
  })

  describe('Domain E: Toolbar & Inspector UI Clarity & Layout (F9, F10)', () => {
    test('T1-E1: App topbar displays Undo/Redo buttons and single unified Export menu (.tsx, .forge.js, .forge.zip)', async () => {
      const appSrc = await readWorkspaceText('src/App.tsx')
      const topbar = extractJsxElements(appSrc, 'header').find((el) => el.openingTag.includes('topbar'))
      assert.ok(topbar, 'App.tsx must define <header className="topbar">')

      const topbarButtons = extractJsxElements(topbar.fullElement, 'button')
      assert.ok(topbarButtons.some((b) => /\bUndo\b/i.test(b.fullElement)), 'Topbar must include an Undo button')
      assert.ok(topbarButtons.some((b) => /\bRedo\b/i.test(b.fullElement)), 'Topbar must include a Redo button')
      assert.ok(topbarButtons.some((b) => /\bExport\b/i.test(b.fullElement)), 'Topbar must include a unified Export menu button')

      // Must appear as UI format choices (not only `${slug(...)}.forge.js` download filenames)
      assert.match(appSrc, /['"(>\s]\.tsx\b/i)
      assert.match(appSrc, /['"(>\s]\.forge\.js\b/i)
      assert.match(appSrc, /['"(>\s]\.forge\.zip\b/i)
    })

    test('T1-E2: App removes scattered duplicate export buttons (viewport R3F, left-rail export, separate topbar Code2/Download)', async () => {
      const appSrc = await readWorkspaceText('src/App.tsx')
      assert.doesNotMatch(appSrc, />\s*R3F\s*<\/button>/)
      assert.doesNotMatch(appSrc, /title="Export runnable Three\.js project"/)
      assert.doesNotMatch(appSrc, /title="Export Three\.js animation code"/)
      assert.doesNotMatch(appSrc, /title="Save editable project and runnable app"/)
    })

    test('T1-E3: Environment select uses .toolbar-select styled wider than 29px tool-button', async () => {
      const appSrc = await readWorkspaceText('src/App.tsx')
      const cssSrc = await readWorkspaceText('src/styles.css')
      const envSelect = extractJsxElements(appSrc, 'select').find((el) =>
        /Environment preset|toolbar-select/.test(el.openingTag),
      )
      assert.ok(envSelect, 'App.tsx must contain Environment <select> element')
      assert.match(envSelect.openingTag, /className="[^"]*toolbar-select/)
      assert.match(envSelect.openingTag, /\b(aria-label|title)=/)
      const selectCssRule = cssSrc.match(/\.toolbar-select\s*\{[^}]*\}/)
      assert.ok(selectCssRule, 'styles.css must define .toolbar-select rule')
      assert.match(selectCssRule[0], /(width\s*:\s*auto|min-width\s*:)/, '.toolbar-select must override 29px .tool-button width')
    })

    test('T1-E4: Inspector uses RotateCcw reset icon, Split Loose Parts, Split by Material, and accessible .visibility-pill', async () => {
      const appSrc = await readWorkspaceText('src/App.tsx')
      assert.match(appSrc, /RotateCcw/)
      assert.doesNotMatch(appSrc, /<Activity\b/)
      assert.match(appSrc, /Split Loose Parts/)
      assert.match(appSrc, /Split by Material/)
      const visButton = extractJsxElements(appSrc, 'button').find((el) => el.openingTag.includes('visibility-pill'))
      assert.ok(visButton, 'App.tsx must render .visibility-pill <button>')
      assert.match(visButton.openingTag, /\baria-label=/)
      assert.match(visButton.openingTag, /\btitle=/)
    })

    test('T1-E5: Toolbar & Inspector clarify WebXR, rotation degrees, effect seconds, and 3D Box controls', async () => {
      const appSrc = await readWorkspaceText('src/App.tsx')
      const buttons = extractJsxElements(appSrc, 'button')
      assert.ok(buttons.some((b) => /\bWebXR\b/.test(b.fullElement)), 'Toolbar must render a WebXR toggle button')
      assert.doesNotMatch(appSrc, />\s*XR\s*<\/button>/)
      assert.match(appSrc, /°/)
      const withoutObjectS = appSrc.replace(/object\(s\)/gi, '')
      assert.match(withoutObjectS, /\(s\)|\bseconds\b/i, 'Effect timing inputs must show (s) or seconds unit')
      assert.match(appSrc, /3D Box|Volume/i)
      assert.ok(
        buttons.some((b) => /\bExtract\b/i.test(b.fullElement)),
        'UI must expose a <button> control for extracting 3D box selection',
      )
    })

    test('T1-E6: 3-column IDE layout structure is preserved without overhaul', async () => {
      const appSrc = await readWorkspaceText('src/App.tsx')
      for (const cls of ['app-shell', 'topbar', 'workspace', 'left-rail', 'scene-panel', 'center-column', 'viewport-toolbar', 'viewport-wrap', 'timeline', 'inspector', 'statusbar']) {
        assert.ok(appSrc.includes(cls), `App.tsx must preserve .${cls}`)
      }
    })
  })
})

// ===========================================================================
// TIER 2 — BOUNDARY & CORNER CASES (27 tests)
// ===========================================================================

describe('Tier 2 — Boundary & Corner Cases', () => {
  describe('Domain A: Picking & Marquee Boundaries', () => {
    test('T2-A1: selectMeshesInRect ignores meshes behind camera (w <= 0 / z > 1) without NDC sign inversion', () => {
      const scene = new THREE.Scene()
      const camera = makeCamera([0, 0, 10], [0, 0, 0])
      const behind = makeMesh('behind', new THREE.BoxGeometry(2, 2, 2), [0, 0, 15])
      const straddling = makeMesh('straddling', new THREE.BoxGeometry(1, 1, 6), [8, 0, 10])
      scene.add(behind, straddling)

      const objects = new Map([
        ['behind', behind],
        ['straddling', straddling],
      ])
      const centerRect = { minX: 150, maxX: 450, minY: 150, maxY: 450 }
      assert.deepEqual(selectMeshesInRect(objects, camera, 600, 600, centerRect, false), [])
      assert.deepEqual(selectMeshesInRect(objects, camera, 600, 600, centerRect, true), [])
    })

    test('T2-A2: selectMeshesInRect handles zero-area and off-screen rects without NaN or throwing', () => {
      const scene = new THREE.Scene()
      const camera = makeCamera([0, 0, 10], [0, 0, 0])
      const box = makeMesh('box', new THREE.BoxGeometry(1, 1, 1), [0, 0, 0])
      scene.add(box)
      const objects = new Map([['box', box]])

      assert.deepEqual(selectMeshesInRect(objects, camera, 600, 600, { minX: -100, maxX: -10, minY: 0, maxY: 50 }, true), [])
      assert.deepEqual(selectMeshesInRect(objects, camera, 600, 600, { minX: 10, maxX: 10, minY: 10, maxY: 10 }, false), [])
      assert.deepEqual(selectMeshesInRect(objects, camera, 0, 600, { minX: 0, maxX: 600, minY: 0, maxY: 600 }, true), [])
    })

    test('T2-A3: picking and marquee return empty results for empty map, Groups, Lights, and untagged meshes', () => {
      const scene = new THREE.Scene()
      const camera = makeCamera([0, 0, 10], [0, 0, 0])
      const emptyMap = new Map()
      const raycaster = new THREE.Raycaster()
      const ptr = new THREE.Vector2(0, 0)

      assert.deepEqual(pickAllVisibleMeshes(emptyMap, camera, raycaster, ptr), [])
      assert.equal(pickClosestVisibleMesh(emptyMap, camera, raycaster, ptr), null)
      assert.deepEqual(selectMeshesInRect(emptyMap, camera, 600, 600, { minX: 0, maxX: 600, minY: 0, maxY: 600 }, true), [])

      const group = new THREE.Group()
      group.userData.forgeId = 'grp'
      const light = new THREE.PointLight()
      light.userData.forgeId = 'lgt'
      const untagged = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial())
      const helper = makeMesh('helper', new THREE.BoxGeometry(2, 2, 2))
      helper.userData.forgeEditorHelper = true
      scene.add(group, light, untagged, helper)

      const nonPickable = new Map([
        ['grp', group],
        ['lgt', light],
        ['untagged', untagged],
        ['helper', helper],
      ])
      assert.deepEqual(pickAllVisibleMeshes(nonPickable, camera, raycaster, ptr), [])

      const nonMarqueeMeshes = new Map([
        ['grp', group],
        ['lgt', light],
        ['helper', helper],
      ])
      assert.deepEqual(selectMeshesInRect(nonMarqueeMeshes, camera, 600, 600, { minX: 0, maxX: 600, minY: 0, maxY: 600 }, true), [])
    })

    test('T2-A4: 4-level GLB hierarchy with hidden top ancestor excludes visible deep leaf from picking and marquee', () => {
      const scene = new THREE.Scene()
      const camera = makeCamera([0, 0, 10], [0, 0, 0])
      const lvl1 = new THREE.Group()
      lvl1.visible = false
      const lvl2 = new THREE.Group()
      const lvl3 = new THREE.Group()
      const leaf = makeMesh('deep-leaf', new THREE.BoxGeometry(2, 2, 2), [0, 0, 0])
      leaf.visible = true
      lvl3.add(leaf)
      lvl2.add(lvl3)
      lvl1.add(lvl2)
      scene.add(lvl1)

      const objects = new Map([['deep-leaf', leaf]])
      assert.deepEqual(pickAllVisibleMeshes(objects, camera, new THREE.Raycaster(), new THREE.Vector2(0, 0)), [])
      assert.deepEqual(selectMeshesInRect(objects, camera, 600, 600, { minX: 0, maxX: 600, minY: 0, maxY: 600 }, true), [])
    })

    test('T2-A5: cycleMeshHit handles single hit, unknown selectedId, and empty hit list', () => {
      const mesh = makeMesh('only', new THREE.BoxGeometry(2, 2, 2))
      const hit = { distance: 1, point: new THREE.Vector3(), object: mesh }

      assert.equal(cycleMeshHit([], 'only'), null)
      assert.equal(cycleMeshHit([hit], 'only')?.object.userData.forgeId, 'only')
      assert.equal(cycleMeshHit([hit], 'unknown')?.object.userData.forgeId, 'only')
    })

    test('T2-A6: selectMeshesInRect skips 0-vertex BufferGeometry cleanly without TypeError', () => {
      const scene = new THREE.Scene()
      const camera = makeCamera([0, 0, 10], [0, 0, 0])
      const emptyGeo = new THREE.BufferGeometry()
      emptyGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
      const mesh = makeMesh('empty-geo', emptyGeo)
      scene.add(mesh)

      const objects = new Map([['empty-geo', mesh]])
      assert.deepEqual(selectMeshesInRect(objects, camera, 600, 600, { minX: 0, maxX: 600, minY: 0, maxY: 600 }, true), [])
    })
  })

  describe('Domain B: 3D Volume & Extraction Boundaries', () => {
    test('T2-B1: empty/out-of-bounds triangle indices return null without mutating source mesh', async () => {
      const { selectTrianglesInBox, extractTrianglesAsPart } = await loadVolumeSelector()
      const mesh = makeMesh('m', new THREE.BoxGeometry(1, 1, 1))
      const beforeCount = getTriangleCount(mesh.geometry)

      assert.deepEqual(
        selectTrianglesInBox(mesh, new THREE.Box3(new THREE.Vector3(50, 50, 50), new THREE.Vector3(60, 60, 60))),
        [],
      )
      assert.equal(extractTrianglesAsPart(mesh, []), null)
      assert.equal(extractTrianglesAsPart(mesh, [-1, 99999]), null)
      assert.equal(getTriangleCount(mesh.geometry), beforeCount)
    })

    test('T2-B2: extracting 100% of triangles yields removedCount === total and empty remainingGeometry cleanly', async () => {
      const { extractTrianglesAsPart } = await loadVolumeSelector()
      const mesh = makeMesh('full', new THREE.BoxGeometry(2, 2, 2))
      const total = getTriangleCount(mesh.geometry)
      const allIndices = Array.from({ length: total }, (_, i) => i)

      const result = extractTrianglesAsPart(mesh, allIndices)
      assert.ok(result !== null)
      assert.equal(result.removedCount, total)
      assert.equal(result.remainingCount, 0)
      assert.equal(result.remainingGeometry.getAttribute('position').count, 0)
      assert.equal(getTriangleCount(result.part.geometry), total)
    })

    test('T2-B3: indexed and non-indexed geometries produce equivalent selections and preserve attributes', async () => {
      const { selectTrianglesInBox, extractTrianglesAsPart } = await loadVolumeSelector()
      const indexedMesh = makeMesh('idx', new THREE.BoxGeometry(2, 2, 2, 2, 2, 2))
      const nonIndexedMesh = makeMesh('nonidx', new THREE.BoxGeometry(2, 2, 2, 2, 2, 2).toNonIndexed())
      const worldBox = new THREE.Box3(new THREE.Vector3(0.01, -2, -2), new THREE.Vector3(2, 2, 2))

      const idxTris = selectTrianglesInBox(indexedMesh, worldBox, 'centroid')
      const nonIdxTris = selectTrianglesInBox(nonIndexedMesh, worldBox, 'centroid')
      assert.equal(idxTris.length, nonIdxTris.length)

      const r1 = extractTrianglesAsPart(indexedMesh, idxTris)
      const r2 = extractTrianglesAsPart(nonIndexedMesh, nonIdxTris)
      assert.equal(r1?.removedCount, r2?.removedCount)
      for (const attr of ['position', 'normal', 'uv']) {
        assert.ok(r1?.part.geometry.getAttribute(attr), `Missing ${attr} on indexed extracted part`)
        assert.ok(r2?.part.geometry.getAttribute(attr), `Missing ${attr} on non-indexed extracted part`)
      }
    })

    test('T2-B4: extractTrianglesAsPart preserves world pose under non-uniform scale, rotation, and parent transform', async () => {
      const { selectTrianglesInBox, extractTrianglesAsPart } = await loadVolumeSelector()
      const parent = new THREE.Group()
      parent.position.set(-2, 1.5, 0.5)
      parent.rotation.set(0.1, -0.3, 0.2)

      const mesh = makeMesh('trs', new THREE.BoxGeometry(2, 2, 2, 2, 2, 2), [3, -1, 2])
      mesh.rotation.set(0.4, 0.9, -0.3)
      mesh.scale.set(2, 0.5, 1.5)
      parent.add(mesh)
      parent.updateMatrixWorld(true)

      const tris = selectTrianglesInBox(mesh, new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10)), 'centroid')
      const subset = tris.slice(0, 10)
      const expectedKeys = subset
        .map((idx) =>
          getTriangleWorldVertices(mesh, idx)
            .map((v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`)
            .sort()
            .join('|'),
        )
        .sort()

      const result = extractTrianglesAsPart(mesh, subset)
      assert.ok(result !== null)
      parent.add(result.part)
      parent.updateMatrixWorld(true)

      assert.deepEqual(getAllWorldTriangleVertexKeys(result.part), expectedKeys)
      result.part.geometry.computeBoundingBox()
      assert.ok(result.part.geometry.boundingBox.getCenter(new THREE.Vector3()).length() < 1e-4)
    })

    test('T2-B5: extractTrianglesAsPart deduplicates repeated triangle indices', async () => {
      const { extractTrianglesAsPart } = await loadVolumeSelector()
      const mesh = makeMesh('dup', new THREE.BoxGeometry(1, 1, 1))
      const total = getTriangleCount(mesh.geometry)

      const result = extractTrianglesAsPart(mesh, [0, 0, 1, 1, 0])
      assert.ok(result !== null)
      assert.equal(result.removedCount, 2)
      assert.equal(result.remainingCount, total - 2)
      assert.equal(getTriangleCount(result.part.geometry), 2)
    })

    test('T2-B6: selectMeshesInBox skips invisible meshes, hidden ancestors, editor helpers, and bare Groups', async () => {
      const { selectMeshesInBox } = await loadVolumeSelector()
      const scene = new THREE.Scene()
      const hiddenMesh = makeMesh('hidden', new THREE.BoxGeometry(1, 1, 1))
      hiddenMesh.visible = false
      const hiddenParent = new THREE.Group()
      hiddenParent.visible = false
      const childOfHidden = makeMesh('child-hidden', new THREE.BoxGeometry(1, 1, 1))
      hiddenParent.add(childOfHidden)
      const helper = makeMesh('helper', new THREE.BoxGeometry(1, 1, 1))
      helper.userData.forgeEditorHelper = true
      const group = new THREE.Group()
      scene.add(hiddenMesh, hiddenParent, helper, group)

      const map = new Map([
        ['hidden', hiddenMesh],
        ['child-hidden', childOfHidden],
        ['helper', helper],
        ['group', group],
      ])
      const box = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5))
      assert.deepEqual(selectMeshesInBox(map, box), [])
    })
  })

  describe('Domain C: Unified Export & R3F Codegen Boundaries', () => {
    test('T2-C1: empty-scene preconditions reject export consistently when no model is loaded', async () => {
      const exporter = await loadForgeExporter()
      const emptyValidation = invokeExportValidation(exporter, makeExporterInput({ assetFiles: [], assetResourcePaths: [], nodes: [] }))
      assert.equal(emptyValidation.valid, false)

      const nonModelOnly = invokeExportValidation(
        exporter,
        makeExporterInput({ assetFiles: [{ name: 'albedo.png' }], assetResourcePaths: ['albedo.png'], nodes: [] }),
      )
      assert.equal(nonModelOnly.valid, false)

      assert.throws(() =>
        exporter.buildProjectData(makeExporterInput({ assetFiles: [], assetResourcePaths: [], nodes: [] })),
      )
    })

    test('T2-C2: resolveExportAssetPath preserves spaces, symbols, .gltf extension, and nested folder paths', async () => {
      const { resolveExportAssetPath } = await loadForgeExporter()
      const nested = resolveExportAssetPath(
        [{ name: 'hull_albedo.png' }, { name: 'My Robot (v2) [final].gltf' }],
        ['sub/dir/hull_albedo.png', 'sub/dir/My Robot (v2) [final].gltf'],
        'Arbitrary Name',
        1,
      )
      assert.equal(nested.manifestAssetPath, './assets/sub/dir/My Robot (v2) [final].gltf')
      assert.equal(nested.archiveAssetPath, 'assets/sub/dir/My Robot (v2) [final].gltf')
    })

    test('T2-C3: duplicate normalized asset paths are rejected to prevent silent ZIP overwrites', async () => {
      const exporter = await loadForgeExporter()
      const dupInput = makeExporterInput({
        assetFiles: [{ name: 'model.glb' }, { name: 'tex.png' }, { name: 'tex.png' }],
        assetResourcePaths: ['model.glb', 'tex.png', 'tex.png'],
      })
      const validation = invokeExportValidation(exporter, dupInput)
      assert.equal(validation.valid, false)
      assert.throws(() => exporter.buildProjectData(dupInput))
    })

    test('T2-C4: generated .tsx traversal deterministically assigns forgeId / falls back by name on raw GLTF scene', () => {
      const manifest = createDefaultManifest('RawGltf', './assets/raw.glb')
      manifest.nodes = [
        {
          forgeId: 'raw:0',
          name: 'Turret',
          parentId: 'raw:root',
          type: 'Mesh',
          visible: false,
          position: [1, 2, 3],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ]
      const tsx = generateR3FComponent(manifest)
      // Baseline only checked obj.userData?.forgeId; production codegen must assign deterministic forgeId or match by name
      assert.ok(
        tsx.includes('children.indexOf') || tsx.includes('override.name') || tsx.includes('find('),
        'R3F traversal must deterministically compute forgeId or fallback by node name on raw useGLTF scenes',
      )
    })

    test('T2-C5: patchR3FFile falls back cleanly to generateR3FComponent when markers are missing or reversed', () => {
      const manifest = createDefaultManifest('FallbackTest', './assets/cube.glb')
      const missing = 'export function Old() { return null }'
      const reversed = '// @forge:end\nfoo\n// @forge:begin'

      for (const input of [missing, reversed]) {
        const result = patchR3FFile(input, manifest)
        assert.ok(result.includes('// @forge:begin'))
        assert.ok(result.includes('// @forge:end'))
        assert.ok(result.indexOf('// @forge:begin') < result.indexOf('// @forge:end'))
        assert.match(result, /export function FallbackTest\(\)/)
      }
    })

    test('T2-C6: generateR3FComponent sanitizes digit-leading or symbol project names into valid TS identifiers', () => {
      const manifest = createDefaultManifest('123-Mecha!', './assets/mecha.glb')
      const tsx = generateR3FComponent(manifest)
      assert.match(tsx, /export function Forge123Mecha\(\)/)
    })
  })

  describe('Domain D: Undo/Redo History Boundaries', () => {
    test('T2-D1: undo() and redo() on empty stack are safe no-ops returning null', async () => {
      const { createHistoryStore } = await loadHistoryStore()
      const store = createHistoryStore()
      assert.equal(store.getState().canUndo, false)
      assert.equal(store.getState().canRedo, false)
      assert.equal(store.getState().undo(), null)
      assert.equal(store.getState().redo(), null)
      assert.equal(store.getState().canUndo, false)
      assert.equal(store.getState().canRedo, false)
    })

    test('T2-D2: pushing a new state after undo clears future redo stack', async () => {
      const { createHistoryStore } = await loadHistoryStore()
      const store = createHistoryStore()
      store.getState().pushState(makeSnapshot({ selected: 's0' }))
      store.getState().pushState(makeSnapshot({ selected: 's1' }))
      store.getState().pushState(makeSnapshot({ selected: 's2' }))

      assert.equal(store.getState().undo()?.selected, 's1')
      assert.equal(store.getState().canRedo, true)

      store.getState().pushState(makeSnapshot({ selected: 's3' }))
      assert.equal(store.getState().canRedo, false)
      assert.equal(store.getState().future.length, 0)
      assert.equal(store.getState().undo()?.selected, 's1')
    })

    test('T2-D3: shouldIgnoreHistoryShortcut blocks INPUT, SELECT, TEXTAREA, contentEditable and allows BUTTON/DIV/CANVAS', async () => {
      const { shouldIgnoreHistoryShortcut } = await loadHistoryStore()
      for (const target of [
        { tagName: 'INPUT' },
        { tagName: 'SELECT' },
        { tagName: 'TEXTAREA' },
        { tagName: 'DIV', isContentEditable: true },
      ]) {
        assert.equal(shouldIgnoreHistoryShortcut(target), true)
      }
      for (const target of [{ tagName: 'BUTTON' }, { tagName: 'DIV', isContentEditable: false }, { tagName: 'CANVAS' }]) {
        assert.equal(shouldIgnoreHistoryShortcut(target), false)
      }
    })

    test('T2-D4: matchHistoryShortcut rejects Alt combos, unmodified keys, and unrelated shortcuts', async () => {
      const { matchHistoryShortcut } = await loadHistoryStore()
      assert.equal(matchHistoryShortcut({ key: 'z', ctrlKey: true, altKey: true }), null)
      assert.equal(matchHistoryShortcut({ key: 'z' }), null)
      assert.equal(matchHistoryShortcut({ key: 'z', shiftKey: true }), null)
      assert.equal(matchHistoryShortcut({ key: 'y', ctrlKey: true, shiftKey: true }), null)
      assert.equal(matchHistoryShortcut({ key: 'a', ctrlKey: true }), null)
    })

    test('T2-D5: matchHistoryShortcut supports macOS metaKey and uppercase Z/Y keys', async () => {
      const { matchHistoryShortcut } = await loadHistoryStore()
      assert.equal(matchHistoryShortcut({ key: 'Z', metaKey: true }), 'undo')
      assert.equal(matchHistoryShortcut({ key: 'Z', metaKey: true, shiftKey: true }), 'redo')
      assert.equal(matchHistoryShortcut({ key: 'Y', metaKey: true }), 'redo')
    })

    test('T2-D6: mutating caller snapshot objects after pushState cannot corrupt stored history', async () => {
      const { createHistoryStore } = await loadHistoryStore()
      const store = createHistoryStore()
      const s0 = makeSnapshot({
        transforms: { 'model:0': { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      })
      const s1 = makeSnapshot({
        transforms: { 'model:0': { position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      })

      store.getState().pushState(s0)
      store.getState().pushState(s1)
      s0.transforms['model:0'].position[0] = 999
      s0.nodes.push({ id: 'corrupted', name: 'Bad', type: 'Mesh', visible: true, parent: null })

      const undone = store.getState().undo()
      assert.deepEqual(undone?.transforms['model:0'].position, [1, 2, 3])
      assert.equal(undone?.nodes.length, 1)
    })
  })

  describe('Domain E: UI, Manifest & Suite Registration Boundaries', () => {
    test('T2-E1: package.json test script explicitly executes tests/e2e-acceptance.test.mjs and all feature suites', async () => {
      const pkg = JSON.parse(await readWorkspaceText('package.json'))
      const testScript = String(pkg.scripts?.test ?? '')
      for (const suitePath of [
        'tests/e2e-acceptance.test.mjs',
        'tests/glb-selection-and-volume.test.mjs',
        'tests/export-consistency.test.mjs',
        'tests/history.test.mjs',
        'tests/phase2.test.mjs',
      ]) {
        assert.ok(testScript.includes(suitePath), `package.json "test" must run ${suitePath}`)
      }
    })

    test('T2-E2: validateSceneManifest rejects malformed inputs and invalid field types', () => {
      const valid = createDefaultManifest()
      assert.equal(validateSceneManifest(valid), true)
      assert.equal(validateSceneManifest(null), false)
      assert.equal(validateSceneManifest('not-an-object'), false)
      assert.equal(validateSceneManifest({ ...valid, version: 2 }), false)
      assert.equal(validateSceneManifest({ ...valid, assetPath: 42 }), false)
      assert.equal(validateSceneManifest({ ...valid, camera: { ...valid.camera, fov: 'wide' } }), false)
      assert.equal(validateSceneManifest({ ...valid, nodes: {} }), false)
      assert.equal(validateSceneManifest({ ...valid, keyframes: null }), false)
    })

    test('T2-E3: App global keydown handler guards shortcuts with shouldIgnoreHistoryShortcut', async () => {
      const appSrc = await readWorkspaceText('src/App.tsx')
      assert.match(appSrc, /shouldIgnoreHistoryShortcut/)
      assert.match(appSrc, /matchHistoryShortcut/)
    })
  })
})

// ===========================================================================
// TIER 3 — CROSS-FEATURE PAIRWISE COMBINATIONS (6 tests)
// ===========================================================================

describe('Tier 3 — Cross-Feature Pairwise Combinations', () => {
  test('T3-1: F1+F2+F5 — pointer cycling & marquee stay synchronized across visibility undo/redo', async () => {
    const { createHistoryStore } = await loadHistoryStore()
    const history = createHistoryStore()

    const scene = new THREE.Scene()
    const camera = makeCamera([0, 0, 10], [0, 0, 0])
    const outer = makeMesh('outer', new THREE.BoxGeometry(2, 2, 1), [0, 0, 1])
    const inner = makeMesh('inner', new THREE.BoxGeometry(1, 1, 1), [0, 0, -1])
    const side = makeMesh('side', new THREE.BoxGeometry(1, 1, 1), [-1.6, 0, 0])
    scene.add(outer, inner, side)
    const map = new Map([
      ['outer', outer],
      ['inner', inner],
      ['side', side],
    ])

    const hits0 = pickAllVisibleMeshes(map, camera, new THREE.Raycaster(), new THREE.Vector2(0, 0))
    assert.equal(cycleMeshHit(hits0, 'outer')?.object.userData.forgeId, 'inner')
    const marqueeRect = { minX: 140, maxX: 460, minY: 200, maxY: 400 }
    assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, marqueeRect, true), ['outer', 'inner', 'side'])

    history.getState().pushState(makeSnapshot({ visibility: { outer: true, inner: true, side: true } }))
    outer.visible = false
    history.getState().pushState(makeSnapshot({ visibility: { outer: false, inner: true, side: true } }))

    assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, marqueeRect, true), ['inner', 'side'])
    assert.equal(pickClosestVisibleMesh(map, camera, new THREE.Raycaster(), new THREE.Vector2(0, 0))?.object.userData.forgeId, 'inner')

    const restored = history.getState().undo()
    outer.visible = Boolean(restored?.visibility.outer)
    assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, marqueeRect, true), ['outer', 'inner', 'side'])
  })

  test('T3-2: F3+F4+F5+F6 — 3D volume extraction + pivot + transform round-trips cleanly via undo/redo', async () => {
    const { selectTrianglesInBox, extractTrianglesAsPart } = await loadVolumeSelector()
    const { createHistoryStore } = await loadHistoryStore()
    const history = createHistoryStore()
    const pivots = createPivotController()

    const parent = new THREE.Group()
    const source = makeMesh('model:0', new THREE.BoxGeometry(2, 2, 2, 2, 2, 2), [0, 0, 0])
    parent.add(source)
    const originalGeo = source.geometry.clone()
    const initialTris = getTriangleCount(source.geometry)

    history.getState().pushState(
      makeSnapshot({
        nodes: [{ id: 'model:0', name: 'Box', type: 'Mesh', visible: true, parent: 'root' }],
        geometrySnapshot: { 'model:0': originalGeo.clone() },
      }),
    )

    const tris = selectTrianglesInBox(source, new THREE.Box3(new THREE.Vector3(0.01, -2, -2), new THREE.Vector3(2, 2, 2)), 'centroid')
    const extracted = extractTrianglesAsPart(source, tris, { forgeId: 'model:0:extract', name: 'Half' })
    assert.ok(extracted !== null)
    source.geometry = extracted.remainingGeometry
    parent.add(extracted.part)

    history.getState().pushState(
      makeSnapshot({
        nodes: [
          { id: 'model:0', name: 'Box', type: 'Mesh', visible: true, parent: 'root' },
          { id: 'model:0:extract', name: 'Half', type: 'Mesh', visible: true, parent: 'root' },
        ],
        geometrySnapshot: {
          'model:0': source.geometry.clone(),
          'model:0:extract': extracted.part.geometry.clone(),
        },
      }),
    )

    pivots.apply('model:0:extract', extracted.part, [0.1, 0.2, 0])
    extracted.part.position.x += 1.5
    history.getState().pushState(
      makeSnapshot({
        nodes: [
          { id: 'model:0', name: 'Box', type: 'Mesh', visible: true, parent: 'root' },
          { id: 'model:0:extract', name: 'Half', type: 'Mesh', visible: true, parent: 'root' },
        ],
        pivots: pivots.snapshot(),
        transforms: {
          'model:0:extract': {
            position: extracted.part.position.toArray(),
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      }),
    )

    const s1 = history.getState().undo()
    assert.deepEqual(s1?.pivots, {})
    assert.equal(s1?.nodes.length, 2)

    const s0 = history.getState().undo()
    assert.equal(s0?.nodes.length, 1)
    assert.equal(getTriangleCount(s0?.geometrySnapshot['model:0']), initialTris)
  })

  test('T3-3: F4+F8 — extracted part with splitFrom, pivot, and timeline keyframes exports across .tsx, .forge.js, and .forge.zip', async () => {
    const { selectTrianglesInBox, extractTrianglesAsPart } = await loadVolumeSelector()
    const exporter = await loadForgeExporter()

    const source = makeMesh('model:body', new THREE.BoxGeometry(2, 2, 2, 2, 2, 2))
    const tris = selectTrianglesInBox(source, new THREE.Box3(new THREE.Vector3(0.01, -2, -2), new THREE.Vector3(2, 2, 2)))
    const extracted = extractTrianglesAsPart(source, tris, { forgeId: 'model:body:extract-0', name: 'Door' })
    assert.ok(extracted !== null)

    const store = useTimelineStore.getState()
    store.upsertKeyframe({
      id: 'k1',
      targetId: extracted.part.userData.forgeId,
      time: 0,
      position: extracted.part.position.toArray(),
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    })
    store.upsertKeyframe({
      id: 'k2',
      targetId: extracted.part.userData.forgeId,
      time: 3,
      position: [2, 0, 0],
      rotation: [0, 1.2, 0],
      scale: [1, 1, 1],
    })

    const keyframes = useTimelineStore.getState().keyframes
    const extractOp = {
      kind: 'extract',
      sourceId: 'model:body',
      partId: 'model:body:extract-0',
      partName: 'Door',
      triangleIndices: tris,
    }
    const exporterInput = makeExporterInput({
      projectName: 'DoorRig',
      assetKey: 'model',
      assetFiles: [{ name: 'Cabinet.glb' }],
      nodes: [
        { id: 'model:root', name: 'Root', type: 'Group', visible: true, parent: null },
        { id: 'model:body', name: 'Body', type: 'Mesh', visible: true, parent: 'model:root' },
        {
          id: 'model:body:extract-0',
          name: 'Door',
          type: 'Mesh',
          visible: true,
          parent: 'model:root',
          splitFrom: 'model:body',
          splitMode: 'extract',
          extractedTriangles: tris,
        },
      ],
      transforms: {
        'model:root': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        'model:body': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        'model:body:extract-0': { position: extracted.part.position.toArray(), rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      keyframes,
      pivots: { 'model:body:extract-0': [0.1, 0.2, 0] },
      splits: [extractOp],
    })

    const r3f = exporter.generateR3FFromEditor(exporterInput)
    const tsx = r3f.code
    assertValidTsxSyntax(tsx, 'T3-3 R3F TSX')
    assert.equal(validateSceneManifest(r3f.manifest), true)

    const projectData = exporter.buildProjectData(exporterInput)
    const runtimeJs = exporter.generateRuntimeJs(projectData)
    assertValidModuleJsSyntax(runtimeJs, 'T3-3 runtime JS')

    assert.ok(tsx.includes('model:body:extract-0'))
    assert.ok(tsx.includes('useFrame'))
    assert.ok(tsx.includes('forgeExtractTriangles'))
    assert.ok(runtimeJs.includes('model:body:extract-0'))
    assert.ok(runtimeJs.includes('extractMeshTriangles'))
    assert.equal(projectData.splits?.length, 1)
    assert.equal(projectData.tracks?.length ?? projectData.keyframes?.length, 2)
  })

  test('T3-4: F6+F8 — connected-island split + pivot offset survives history undo/redo and exports identically', async () => {
    const { createHistoryStore } = await loadHistoryStore()
    const exporter = await loadForgeExporter()
    const { merged } = makeTwoSeparatedSubAssembliesGeometry()
    const mesh = makeMesh('model:0', merged, [0, 0, 0], 'TwinBox')

    const split = splitMeshByConnectedIslands(mesh)
    assert.equal(split.parts.length, 2)

    const pivots = createPivotController()
    pivots.apply(split.parts[0].userData.forgeId, split.parts[0], [0.25, 0, 0])

    const history = createHistoryStore()
    history.getState().pushState(makeSnapshot({ nodes: [{ id: 'model:0', name: 'TwinBox', type: 'Mesh', visible: true, parent: null }] }))
    history.getState().pushState(
      makeSnapshot({
        nodes: split.parts.map((p) => ({ id: p.userData.forgeId, name: p.name, type: 'Mesh', visible: true, parent: null })),
        pivots: pivots.snapshot(),
      }),
    )

    assert.equal(history.getState().undo()?.nodes.length, 1)
    const redone = history.getState().redo()
    assert.equal(redone?.nodes.length, 2)
    assert.deepEqual(redone?.pivots['model:0:part-0'], [0.25, 0, 0])

    const projectData = exporter.buildProjectData(
      makeExporterInput({
        projectName: 'TwinExport',
        assetKey: 'model',
        assetFiles: [{ name: 'Twin.glb' }],
        nodes: redone.nodes,
        pivots: redone.pivots,
      }),
    )
    assert.deepEqual(projectData.pivots['model:0:part-0'], [0.25, 0, 0])
  })

  test('T3-5: F7+F8 — xr-stage preset + custom camera + loopMode once maintain parity across all 3 export formats', async () => {
    const exporter = await loadForgeExporter()
    const xrPreset = ENVIRONMENT_PRESETS['xr-stage']
    const env = createEnvironmentManifest('xr-stage')
    const camera = { position: xrPreset.xrStage.spawnPosition, target: xrPreset.xrStage.spawnTarget, fov: 60, near: 0.1, far: 150 }

    const manifest = createDefaultManifest('XRVehicle', './assets/Vehicle.glb')
    manifest.camera = camera
    manifest.environment = env
    manifest.loopMode = 'once'

    const tsx = generateR3FComponent(manifest)
    const projectData = exporter.buildProjectData(
      makeExporterInput({
        projectName: 'XRVehicle',
        assetFiles: [{ name: 'Vehicle.glb' }],
        camera,
        environment: env,
        loopMode: 'once',
      }),
    )
    const runtimeJs = exporter.generateRuntimeJs(projectData)

    assert.ok(tsx.includes(`@react-three/xr`))
    assert.ok(tsx.includes(`Enter VR`))
    assert.ok(tsx.includes(`./assets/Vehicle.glb`))
    assert.ok(runtimeJs.includes(`assets/Vehicle.glb`))
    assert.ok(runtimeJs.includes(`once`))
  })

  test('T3-6: F4+F8 — post-extraction manifest validates and patches user R3F file cleanly', () => {
    const manifest = createDefaultManifest('PatchCycle', './assets/drone.glb')
    manifest.nodes = [
      {
        forgeId: 'drone:root',
        name: 'Root',
        parentId: null,
        type: 'Group',
        visible: true,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      {
        forgeId: 'drone:0:extract',
        name: 'WingTip',
        parentId: 'drone:root',
        type: 'Mesh',
        visible: true,
        position: [1.2, 0.4, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        pivot: [0, -0.2, 0],
        splitFrom: 'drone:0',
      },
    ]
    manifest.keyframes = [
      { id: 'kf1', targetId: 'drone:0:extract', time: 0, position: [1.2, 0.4, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { id: 'kf2', targetId: 'drone:0:extract', time: 1.5, position: [1.5, 0.8, 0], rotation: [0, 0.5, 0], scale: [1, 1, 1] },
    ]
    assert.equal(validateSceneManifest(manifest), true)

    const userSource = [
      "import { Canvas } from '@react-three/fiber'",
      generateR3FSceneBlock(createDefaultManifest('PatchCycle', './assets/drone.glb')),
      'export function UserHud() { return <div>HUD</div> }',
    ].join('\n')

    const patched = patchR3FFile(userSource, manifest)
    assert.ok(patched.includes('drone:0:extract'))
    assert.ok(patched.includes('export function UserHud() { return <div>HUD</div> }'))
  })
})

// ===========================================================================
// TIER 4 — REAL-WORLD END-TO-END WORKFLOWS (6 scenarios)
// ===========================================================================

describe('Tier 4 — Real-World End-to-End Workflows', () => {
  test('T4-1: Full production GLTF editing & export pipeline on phase2-articulated-fixture.gltf', async () => {
    const { selectTrianglesInBox, extractTrianglesAsPart } = await loadVolumeSelector()
    const { createHistoryStore } = await loadHistoryStore()
    const exporter = await loadForgeExporter()

    const gltf = await parseGltfFixture('tests/fixtures/phase2-articulated-fixture.gltf')
    const objects = assignDeterministicForgeIds(gltf.scene, 'art')
    gltf.scene.updateMatrixWorld(true)

    const bodyMesh = [...objects.values()].find((o) => o.isMesh && o.name === 'Body')
    const rotorMesh = [...objects.values()].find((o) => o.isMesh && o.name === 'Rotor_Blade')
    assert.ok(bodyMesh && rotorMesh, 'Fixture must contain Body and Rotor_Blade meshes')
    const initialBodyTris = getTriangleCount(bodyMesh.geometry)
    assert.equal(initialBodyTris, 1200)

    const history = createHistoryStore()
    const pivots = createPivotController()

    history.getState().pushState(
      makeSnapshot({
        nodes: [...objects.entries()].map(([id, obj]) => ({
          id,
          name: obj.name,
          type: obj.isMesh ? 'Mesh' : 'Group',
          visible: obj.visible,
          parent: obj.parent?.userData.forgeId ?? null,
        })),
        geometrySnapshot: { [bodyMesh.userData.forgeId]: bodyMesh.geometry.clone() },
      }),
    )

    // Extract +X half of Body via 3D Box3
    const box = new THREE.Box3(new THREE.Vector3(0.01, -2, -2), new THREE.Vector3(2, 2, 2))
    const selectedTris = selectTrianglesInBox(bodyMesh, box, 'centroid')
    assert.ok(selectedTris.length > 0 && selectedTris.length < initialBodyTris)

    const extracted = extractTrianglesAsPart(bodyMesh, selectedTris, {
      forgeId: `${bodyMesh.userData.forgeId}:extract-0`,
      name: 'Body_RightHalf',
    })
    assert.ok(extracted !== null)
    bodyMesh.geometry = extracted.remainingGeometry
    bodyMesh.parent.add(extracted.part)
    objects.set(extracted.part.userData.forgeId, extracted.part)

    // Transform, pivot, hide rotor, add keyframes
    extracted.part.position.x += 0.5
    pivots.apply(extracted.part.userData.forgeId, extracted.part, [0.1, 0, 0])
    rotorMesh.visible = false
    useTimelineStore.getState().upsertKeyframe({
      id: 'k0',
      targetId: extracted.part.userData.forgeId,
      time: 0,
      position: extracted.part.position.toArray(),
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    })
    useTimelineStore.getState().upsertKeyframe({
      id: 'k1',
      targetId: extracted.part.userData.forgeId,
      time: 2,
      position: [1.5, 0.2, 0],
      rotation: [0, 1.0, 0],
      scale: [1, 1, 1],
    })

    const extractId = extracted.part.userData.forgeId
    const editedSnap = makeSnapshot({
      nodes: [...objects.entries()].map(([id, obj]) => ({
        id,
        name: obj.name,
        type: obj.isMesh ? 'Mesh' : 'Group',
        visible: obj.visible,
        parent: obj.parent?.userData.forgeId ?? null,
        ...(id === extractId
          ? {
              splitFrom: bodyMesh.userData.forgeId,
              splitMode: 'extract',
              extractedTriangles: selectedTris,
            }
          : {}),
      })),
      transforms: Object.fromEntries(
        [...objects.entries()].map(([id, obj]) => [
          id,
          { position: obj.position.toArray(), rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z], scale: obj.scale.toArray() },
        ]),
      ),
      visibility: { [rotorMesh.userData.forgeId]: false },
      pivots: pivots.snapshot(),
      frames: useTimelineStore.getState().keyframes,
      geometrySnapshot: { [bodyMesh.userData.forgeId]: bodyMesh.geometry.clone() },
    })
    history.getState().pushState(editedSnap)

    // Undo back to original GLTF state, then redo back to edited state
    const undone = history.getState().undo()
    assert.equal(getTriangleCount(undone?.geometrySnapshot[bodyMesh.userData.forgeId]), initialBodyTris)
    const redone = history.getState().redo()
    assert.equal(getTriangleCount(redone?.geometrySnapshot[bodyMesh.userData.forgeId]), initialBodyTris - selectedTris.length)

    // Export all 3 formats (.tsx, .forge.js, .forge.zip) and verify JSZip round-trip
    const input = makeExporterInput({
      projectName: 'ArticulatedDrone',
      assetKey: 'art',
      assetFiles: [{ name: 'phase2-articulated-fixture.gltf' }],
      nodes: redone.nodes,
      transforms: redone.transforms,
      keyframes: redone.frames,
      pivots: redone.pivots,
      splits: [
        {
          kind: 'extract',
          sourceId: bodyMesh.userData.forgeId,
          partId: extractId,
          partName: 'Body_RightHalf',
          triangleIndices: selectedTris,
        },
      ],
    })
    const r3f = exporter.generateR3FFromEditor(input)
    assert.equal(validateSceneManifest(r3f.manifest), true)
    assertValidTsxSyntax(r3f.code, 'T4-1 R3F TSX')
    assert.ok(r3f.code.includes('./assets/phase2-articulated-fixture.gltf'))
    assert.ok(r3f.code.includes(extractId))
    assert.ok(r3f.code.includes('forgeExtractTriangles'))

    const projectData = exporter.buildProjectData(input)
    const runtimeJs = exporter.generateRuntimeJs(projectData)
    assertValidModuleJsSyntax(runtimeJs, 'T4-1 runtime JS')
    const entries = exporter.buildExportZipEntries(input)

    const zip = new JSZip()
    if (Array.isArray(entries)) {
      for (const e of entries) zip.file(e.path ?? e.name, e.content ?? e.data ?? '')
    } else {
      for (const [k, v] of Object.entries(entries)) zip.file(k, v)
    }
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
    const reloaded = await JSZip.loadAsync(zipBuffer)
    const reloadedProject = JSON.parse(await reloaded.file('project.json').async('text'))

    assert.equal(reloadedProject.assets[0].path, 'assets/phase2-articulated-fixture.gltf')
    assert.equal(reloadedProject.splits?.length, 1)
    assert.ok(runtimeJs.includes('assets/phase2-articulated-fixture.gltf'))
    assert.ok(runtimeJs.includes('extractMeshTriangles'))
    assert.ok(reloaded.file('assets/phase2-articulated-fixture.gltf') !== null)
  })

  test('T4-2: Single-mesh merged GLB workflow (3D volume splitting + undo/redo + export)', async () => {
    const { selectMeshesInBox, selectTrianglesInBox, extractTrianglesAsPart } = await loadVolumeSelector()
    const { createHistoryStore } = await loadHistoryStore()
    const exporter = await loadForgeExporter()

    const root = new THREE.Group()
    root.position.set(0, 1, 0)
    root.scale.set(2, 2, 2)

    const { merged, leftTriCount, rightTriCount } = makeTwoSeparatedSubAssembliesGeometry()
    const singleMesh = makeMesh('single:0', merged, [0, 0, 0], 'MergedAssembly')
    root.add(singleMesh)
    root.updateMatrixWorld(true)

    const objects = new Map([['single:0', singleMesh]])
    const leftVolume = new THREE.Box3(new THREE.Vector3(-10, -5, -5), new THREE.Vector3(-1, 5, 5))

    assert.deepEqual(selectMeshesInBox(objects, leftVolume), ['single:0'])
    const tris = selectTrianglesInBox(singleMesh, leftVolume, 'centroid')
    assert.equal(tris.length, leftTriCount)

    const history = createHistoryStore()
    history.getState().pushState(makeSnapshot({ nodes: [{ id: 'single:0', name: 'MergedAssembly', type: 'Mesh', visible: true, parent: 'single:root' }] }))

    const extracted = extractTrianglesAsPart(singleMesh, tris, { forgeId: 'single:0:extract', name: 'SubAssemblyA' })
    assert.ok(extracted !== null)
    assert.equal(extracted.removedCount, leftTriCount)
    assert.equal(extracted.remainingCount, rightTriCount)
    assert.equal(extracted.part.userData.splitFrom, 'single:0')

    extracted.part.geometry.computeBoundingBox()
    assert.ok(extracted.part.geometry.boundingBox.getCenter(new THREE.Vector3()).length() < 1e-4)

    history.getState().pushState(
      makeSnapshot({
        nodes: [
          { id: 'single:0', name: 'MergedAssembly', type: 'Mesh', visible: true, parent: 'single:root' },
          { id: 'single:0:extract', name: 'SubAssemblyA', type: 'Mesh', visible: true, parent: 'single:root' },
        ],
      }),
    )
    assert.equal(history.getState().undo()?.nodes.length, 1)
    const redone = history.getState().redo()
    assert.equal(redone?.nodes.length, 2)

    const manifest = createDefaultManifest('SingleMeshSplit', './assets/merged.glb')
    manifest.nodes = redone.nodes.map((n) => ({
      forgeId: n.id,
      name: n.name,
      parentId: n.parent,
      type: n.type,
      visible: n.visible,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      ...(n.id === 'single:0:extract' ? { splitFrom: 'single:0' } : {}),
    }))
    const tsx = generateR3FComponent(manifest)
    const projectData = exporter.buildProjectData(
      makeExporterInput({
        projectName: 'SingleMeshSplit',
        assetKey: 'single',
        assetFiles: [{ name: 'merged.glb' }],
        nodes: redone.nodes,
      }),
    )
    assert.ok(tsx.includes('single:0:extract'))
    assert.equal(projectData.nodes.length, 2)
  })

  test('T4-3: Multi-part dense assembly selection, Alt+Click cycling & loose-part split on phase2-dense.gltf', async () => {
    const exporter = await loadForgeExporter()
    const gltf = await parseGltfFixture('tests/fixtures/phase2-dense.gltf')
    const objects = assignDeterministicForgeIds(gltf.scene, 'dense')
    gltf.scene.updateMatrixWorld(true)

    const meshes = [...objects.values()].filter((o) => o.isMesh)
    assert.equal(meshes.length, 2)
    assert.ok(meshes.every((m) => m.geometry.getAttribute('position').count > 512))

    const camera = makeCamera([0, 0, 5], [0, 0, 0], 50)
    const hits = pickAllVisibleMeshes(objects, camera, new THREE.Raycaster(), new THREE.Vector2(0, 0))
    assert.ok(hits.length >= 1)
    if (hits.length > 1) {
      const firstId = hits[0].object.userData.forgeId
      const cycled = cycleMeshHit(hits, firstId)
      assert.notEqual(cycled?.object.userData.forgeId, firstId)
    }

    const fullRect = { minX: 0, maxX: 600, minY: 0, maxY: 600 }
    assert.equal(selectMeshesInRect(objects, camera, 600, 600, fullRect, false).length, 2)

    // Hide first mesh and verify both picking and marquee exclude it
    meshes[0].visible = false
    const visibleAfterHide = selectMeshesInRect(objects, camera, 600, 600, fullRect, true)
    assert.deepEqual(visibleAfterHide, [meshes[1].userData.forgeId])

    // Multi-island split + export
    const { merged } = makeTwoSeparatedSubAssembliesGeometry()
    const multiIsland = makeMesh('dense:split-target', merged)
    const splitRes = splitMeshByConnectedIslands(multiIsland)
    assert.equal(splitRes.parts.length, 2)

    const projectData = exporter.buildProjectData(
      makeExporterInput({
        projectName: 'DenseAssembly',
        assetKey: 'dense',
        assetFiles: [{ name: 'phase2-dense.gltf' }],
        nodes: [...objects.entries()].map(([id, obj]) => ({
          id,
          name: obj.name,
          type: obj.isMesh ? 'Mesh' : 'Group',
          visible: obj.visible,
          parent: obj.parent?.userData.forgeId ?? null,
        })),
      }),
    )
    assert.equal(projectData.assets[0].path, 'assets/phase2-dense.gltf')
  })

  test('T4-4: glTF + companion folder textures & custom project name export parity', async () => {
    const exporter = await loadForgeExporter()
    const files = [{ name: 'Space Rover (v2).gltf' }, { name: 'hull_albedo.png' }]
    const resourcePaths = ['vehicles/Space Rover (v2).gltf', 'vehicles/textures/hull_albedo.png']

    const pathInfo = exporter.resolveExportAssetPath(files, resourcePaths, 'Mars Explorer 2026', 0)
    assert.equal(pathInfo.manifestAssetPath, './assets/vehicles/Space Rover (v2).gltf')
    assert.equal(pathInfo.archiveAssetPath, 'assets/vehicles/Space Rover (v2).gltf')

    const input = makeExporterInput({
      projectName: 'Mars Explorer 2026',
      assetFiles: files,
      assetResourcePaths: resourcePaths,
    })
    const projectData = exporter.buildProjectData(input)
    const runtimeJs = exporter.generateRuntimeJs(projectData)
    const zipEntries = exporter.buildExportZipEntries(input)
    const manifest = createDefaultManifest('Mars Explorer 2026', pathInfo.manifestAssetPath)
    const tsx = generateR3FComponent(manifest)

    assert.ok(tsx.includes('./assets/vehicles/Space Rover (v2).gltf'))
    assert.ok(!tsx.includes('mars-explorer-2026.glb'))
    assert.equal(projectData.assets[0].path, 'assets/vehicles/Space Rover (v2).gltf')
    assert.ok(projectData.assets[0].resources.includes('assets/vehicles/textures/hull_albedo.png'))
    assert.ok(runtimeJs.includes('assets/vehicles/Space Rover (v2).gltf'))

    const entryKeys = Array.isArray(zipEntries) ? zipEntries.map((e) => e.path ?? e.name) : Object.keys(zipEntries)
    assert.ok(entryKeys.includes('assets/vehicles/Space Rover (v2).gltf'))
    assert.ok(entryKeys.includes('assets/vehicles/textures/hull_albedo.png'))
  })

  test('T4-5: UI clarity, unified Export menu & 3-column layout acceptance contract', async () => {
    const [appSrc, viewportSrc, stylesSrc, pkgRaw] = await Promise.all([
      readWorkspaceText('src/App.tsx'),
      readWorkspaceText('src/SceneViewport.tsx'),
      readWorkspaceText('src/styles.css'),
      readWorkspaceText('package.json'),
    ])

    // Topbar Undo/Redo & Unified Export Menu (anchored to JSX topbar controls, not download filenames)
    const topbar = extractJsxElements(appSrc, 'header').find((el) => el.openingTag.includes('topbar'))
    assert.ok(topbar, 'App.tsx must contain <header className="topbar">')
    const topbarButtons = extractJsxElements(topbar.fullElement, 'button')
    assert.ok(topbarButtons.some((b) => /\bUndo\b/i.test(b.fullElement)))
    assert.ok(topbarButtons.some((b) => /\bRedo\b/i.test(b.fullElement)))
    assert.ok(topbarButtons.some((b) => /\bExport\b/i.test(b.fullElement)))
    assert.match(appSrc, /['"(>\s]\.tsx\b/i)
    assert.match(appSrc, /['"(>\s]\.forge\.js\b/i)
    assert.match(appSrc, /['"(>\s]\.forge\.zip\b/i)
    assert.doesNotMatch(appSrc, />\s*R3F\s*<\/button>/)

    // Simplified labels, units, icons & a11y
    const envSelect = extractJsxElements(appSrc, 'select').find((el) =>
      /Environment preset|toolbar-select/.test(el.openingTag),
    )
    assert.ok(envSelect, 'App.tsx must render Environment <select>')
    assert.match(envSelect.openingTag, /className="[^"]*toolbar-select/)
    const selectCssRule = stylesSrc.match(/\.toolbar-select\s*\{[^}]*\}/)
    assert.ok(selectCssRule, 'styles.css must define .toolbar-select rule')
    assert.match(selectCssRule[0], /(width\s*:\s*auto|min-width\s*:)/)

    assert.match(appSrc, /RotateCcw/)
    assert.doesNotMatch(appSrc, /<Activity\b/)
    assert.match(appSrc, /Split Loose Parts/)
    assert.match(appSrc, /Split by Material/)
    const buttons = extractJsxElements(appSrc, 'button')
    assert.ok(buttons.some((b) => /\bWebXR\b/.test(b.fullElement)))
    assert.doesNotMatch(appSrc, />\s*XR\s*<\/button>/)

    const visButton = buttons.find((el) => el.openingTag.includes('visibility-pill'))
    assert.ok(visButton, 'App.tsx must render .visibility-pill <button>')
    assert.match(visButton.openingTag, /\baria-label=/)
    assert.match(visButton.openingTag, /\btitle=/)

    // 3D Box selector controls, App wiring & ViewportApi history hooks
    assert.match(appSrc, /setVolumeBoxMode|'volume'/)
    assert.match(appSrc, /extractBoxSelection/)
    assert.ok(buttons.some((b) => /\bExtract\b/i.test(b.fullElement)))
    assert.match(appSrc, /captureSceneSnapshot|useHistoryStore/)
    assert.match(appSrc, /restoreSceneSnapshot/)
    assert.match(viewportSrc, /captureSceneSnapshot/)
    assert.match(viewportSrc, /restoreSceneSnapshot/)

    // Preserved 3-column layout
    for (const cls of ['topbar', 'left-rail', 'scene-panel', 'center-column', 'inspector', 'statusbar']) {
      assert.ok(appSrc.includes(cls), `Missing preserved layout class .${cls}`)
    }

    // Test registration
    const pkg = JSON.parse(pkgRaw)
    const testScript = String(pkg.scripts?.test ?? '')
    for (const suitePath of [
      'tests/e2e-acceptance.test.mjs',
      'tests/glb-selection-and-volume.test.mjs',
      'tests/export-consistency.test.mjs',
      'tests/history.test.mjs',
    ]) {
      assert.ok(testScript.includes(suitePath), `package.json "test" must run ${suitePath}`)
    }
  })

  test('T4-6: Cross-package toolchain compatibility (Node 24 TS stripping, zero DOM globals, MCP & VS Code manifest parity)', async () => {
    const [manifestSrc, codegenSrc, protocolSrc] = await Promise.all([
      readWorkspaceText('src/domain/sceneManifest.ts'),
      readWorkspaceText('src/export/r3f/r3fCodegen.ts'),
      readWorkspaceText('packages/vscode-extension/src/protocol.ts'),
    ])

    for (const src of [manifestSrc, codegenSrc]) {
      assert.doesNotMatch(src, /\b(window|document|Blob|File|URL\.createObjectURL)\b/)
    }

    const manifest = createDefaultManifest('CrossPkg', './assets/cross.glb')
    manifest.nodes = [
      {
        forgeId: 'cross:0',
        name: 'Part',
        parentId: 'cross:root',
        type: 'Mesh',
        visible: true,
        position: [0, 1, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        pivot: [0.1, 0, 0],
        splitFrom: 'cross:orig',
      },
    ]
    assert.equal(validateSceneManifest(manifest), true)
    assert.ok(protocolSrc.includes('pivot?: Vec3'))
    assert.ok(protocolSrc.includes('splitFrom?: string'))

    const patched = patchR3FFile(
      "// @forge:begin\nold\n// @forge:end\nexport const KEEP_ME = 'yes'\n",
      manifest,
    )
    assert.ok(patched.includes("export const KEEP_ME = 'yes'"))
    assert.ok(patched.includes('cross:0'))
  })
})
