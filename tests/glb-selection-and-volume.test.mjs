import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three/webgpu'
import { cycleMeshHit, pickAllVisibleMeshes, pickClosestVisibleMesh } from '../src/features/selection/pickMesh.ts'
import { selectMeshesInRect } from '../src/features/selection/viewportSelection.ts'
import {
  extractTrianglesAsPart,
  selectMeshesInBox,
  selectTrianglesInBox,
} from '../src/features/selection/volumeSelector.ts'

function getTriangleWorldVertices(mesh, triIndex) {
  mesh.updateWorldMatrix(true, false)
  const posAttr = mesh.geometry.getAttribute('position')
  const index = mesh.geometry.getIndex()
  const verts = []
  for (let c = 0; c < 3; c++) {
    const vi = index ? index.getX(triIndex * 3 + c) : triIndex * 3 + c
    verts.push(new THREE.Vector3().fromBufferAttribute(posAttr, vi).applyMatrix4(mesh.matrixWorld))
  }
  return verts
}

function triangleKey(verts) {
  return verts
    .map((v) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`)
    .sort()
    .join('|')
}

test('GLB nested hierarchy pointer picking and Alt+Click cycleMeshHit ignore helpers and hidden ancestors', () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 12)
  camera.lookAt(0, 0, 0)

  const rootGroup = new THREE.Group()
  rootGroup.userData.forgeId = 'glb:root'
  rootGroup.position.set(0.25, -0.1, 0)
  rootGroup.rotation.set(0.1, -0.15, 0.05)
  rootGroup.scale.set(1.2, 0.9, 1.1)
  scene.add(rootGroup)

  const outer = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), new THREE.MeshBasicMaterial())
  outer.userData.forgeId = 'glb:outer'
  const middle = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial())
  middle.userData.forgeId = 'glb:middle'
  const inner = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshBasicMaterial())
  inner.userData.forgeId = 'glb:inner'

  const editorHelper = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), new THREE.MeshBasicMaterial())
  editorHelper.position.z = 3
  editorHelper.userData.forgeId = 'helper:box'
  editorHelper.userData.forgeEditorHelper = true

  const hiddenAncestor = new THREE.Group()
  hiddenAncestor.visible = false
  const hiddenChild = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial())
  hiddenChild.position.z = 2
  hiddenChild.userData.forgeId = 'glb:hidden'
  hiddenAncestor.add(hiddenChild)

  rootGroup.add(outer, middle, inner, editorHelper, hiddenAncestor)

  const objects = new Map([
    ['glb:root', rootGroup],
    ['glb:outer', outer],
    ['glb:middle', middle],
    ['glb:inner', inner],
    ['helper:box', editorHelper],
    ['glb:hidden', hiddenChild],
  ])

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2(0, 0)
  const hits = pickAllVisibleMeshes(objects, camera, raycaster, pointer)

  assert.deepEqual(
    hits.map((h) => h.object.userData.forgeId),
    ['glb:outer', 'glb:middle', 'glb:inner'],
  )
  assert.equal(pickClosestVisibleMesh(objects, camera, raycaster, pointer)?.object.userData.forgeId, 'glb:outer')
  assert.equal(cycleMeshHit(hits, null)?.object.userData.forgeId, 'glb:outer')
  assert.equal(cycleMeshHit(hits, 'glb:root')?.object.userData.forgeId, 'glb:outer')
  assert.equal(cycleMeshHit(hits, 'glb:outer')?.object.userData.forgeId, 'glb:middle')
  assert.equal(cycleMeshHit(hits, 'glb:middle')?.object.userData.forgeId, 'glb:inner')
  assert.equal(cycleMeshHit(hits, 'glb:inner')?.object.userData.forgeId, 'glb:outer')
})

test('2D marquee selects dense mesh (> 2000 vertices) via tiny localized patch without 512-vertex subsampling', () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)

  // 2500 triangles (7500 vertices): 2499 far left at x=-3.5, 1 tiny triangle at center (0, 0, 0)
  const triCount = 2500
  const positions = new Float32Array(triCount * 9)
  for (let t = 0; t < triCount - 1; t++) {
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
  // Place triangle #1234 (not near stride multiples) right at world origin (0,0,0)
  const targetTri = 1234
  const saved = positions.slice(targetTri * 9, targetTri * 9 + 9)
  positions.set(saved, (triCount - 1) * 9)
  positions.set([
    -0.02, -0.02, 0,
    0.02, -0.02, 0,
    0, 0.02, 0,
  ], targetTri * 9)

  const denseGeo = new THREE.BufferGeometry()
  denseGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const denseMesh = new THREE.Mesh(denseGeo, new THREE.MeshBasicMaterial())

  // Also test a dense SphereGeometry (> 2000 vertices)
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.5, 64, 32), new THREE.MeshBasicMaterial())
  assert.ok(sphere.geometry.getAttribute('position').count > 2000)
  sphere.position.set(2.5, 2.5, 0)
  scene.add(denseMesh, sphere)

  const map = new Map([
    ['dense-patch', denseMesh],
    ['dense-sphere', sphere],
  ])

  // Small rect around screen center (300, 300)
  const centerRect = { minX: 295, maxX: 305, minY: 295, maxY: 305 }
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, centerRect, true), ['dense-patch'])
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, centerRect, false), [])
})

test('2D marquee handles nested rotated/scaled GLB hierarchies without prior updateMatrixWorld', () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)

  const parent = new THREE.Group()
  parent.position.set(-1.5, 0.5, 0)
  parent.rotation.set(0.2, 0.3, Math.PI / 5)
  parent.scale.set(1.4, 0.7, 1.0)

  const child = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshBasicMaterial())
  child.position.set(0.2, -0.1, 0)
  parent.add(child)
  scene.add(parent)

  const map = new Map([['nested', child]])
  const rect = { minX: 100, maxX: 310, minY: 160, maxY: 340 }
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, rect, false), ['nested'])
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, rect, true), ['nested'])
})

test('2D marquee clips behind-camera vertices safely without negative-w inversion and handles Box3 fallback', () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 100)
  camera.position.set(0, 0, 5)
  camera.lookAt(0, 0, 0)

  // Mesh behind camera on the left (z = 8 > camera.z = 5, x = -2).
  // Without w > 0 clipping, negative w flips (-x / -w) to +x on the right side!
  const behindLeftGeo = new THREE.BufferGeometry()
  behindLeftGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -3, -1, 8,
        -1, -1, 8,
        -2, 1, 8,
        -2, 0, 4, // one vertex in front on the left
        -3, 1, 8,
        -1, 1, 8,
      ]),
      3,
    ),
  )
  const behindLeft = new THREE.Mesh(behindLeftGeo, new THREE.MeshBasicMaterial())

  // Triangle straddling the near plane across screen center (z=6 behind camera to z=3 in front)
  const straddleGeo = new THREE.BufferGeometry()
  straddleGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -0.05, -0.1, 6,
        0.05, -0.1, 6,
        0, 0.1, 3,
      ]),
      3,
    ),
  )
  const straddling = new THREE.Mesh(straddleGeo, new THREE.MeshBasicMaterial())

  // Fallback Box3 path: parent mesh with empty position attr wrapping a child behind camera on the left
  const fallbackParent = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const fallbackChild = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  fallbackChild.position.set(-2.5, 0, 8)
  fallbackParent.add(fallbackChild)

  scene.add(behindLeft, straddling, fallbackParent)

  const map = new Map([
    ['behind-left', behindLeft],
    ['straddling', straddling],
    ['fallback-behind', fallbackParent],
  ])

  const rightRect = { minX: 420, maxX: 560, minY: 220, maxY: 380 }
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, rightRect, true), [])
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, rightRect, false), [])

  const centerRect = { minX: 280, maxX: 320, minY: 280, maxY: 320 }
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, centerRect, true), ['straddling'])
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, centerRect, false), [])
})

test('2D marquee crossing mode rejects hollow/L-gap AABB overlaps and accepts diagonal edges and enclosing faces', () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)

  // L-shaped / two-bar mesh at (-2, -2)..(-1.6, 2) and (-2, -2)..(2, -1.6)
  // Its screen AABB covers the whole viewport center, but the center (0,0) is empty.
  const lShapeGeo = new THREE.BufferGeometry()
  lShapeGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        // Left vertical bar
        -2.2, -2.2, 0, -1.8, -2.2, 0, -1.8, 2.2, 0,
        -2.2, -2.2, 0, -1.8, 2.2, 0, -2.2, 2.2, 0,
        // Bottom horizontal bar
        -2.2, -2.2, 0, 2.2, -2.2, 0, 2.2, -1.8, 0,
        -2.2, -2.2, 0, 2.2, -1.8, 0, -2.2, -1.8, 0,
      ]),
      3,
    ),
  )
  const lShape = new THREE.Mesh(lShapeGeo, new THREE.MeshBasicMaterial())

  // Thin diagonal strut from (-3, -3, 0) to (3, 3, 0) — no vertices in center rect, but crosses it
  const diagGeo = new THREE.BufferGeometry()
  diagGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -3, -3.05, 0, 3, 2.95, 0, 3, 3.05, 0,
        -3, -3.05, 0, 3, 3.05, 0, -3, -2.95, 0,
      ]),
      3,
    ),
  )
  const diagonal = new THREE.Mesh(diagGeo, new THREE.MeshBasicMaterial())

  // Large quad covering [-4, 4] x [-4, 4] — all 4 vertices outside center rect
  const quadGeo = new THREE.BufferGeometry()
  quadGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -4, -4, 0, 4, -4, 0, 4, 4, 0,
        -4, -4, 0, 4, 4, 0, -4, 4, 0,
      ]),
      3,
    ),
  )
  const largeQuad = new THREE.Mesh(quadGeo, new THREE.MeshBasicMaterial())

  scene.add(lShape, diagonal, largeQuad)
  const centerRect = { minX: 280, maxX: 320, minY: 280, maxY: 320 }

  assert.deepEqual(selectMeshesInRect(new Map([['l-shape', lShape]]), camera, 600, 600, centerRect, true), [])
  assert.deepEqual(selectMeshesInRect(new Map([['diagonal', diagonal]]), camera, 600, 600, centerRect, true), ['diagonal'])
  assert.deepEqual(selectMeshesInRect(new Map([['diagonal', diagonal]]), camera, 600, 600, centerRect, false), [])
  assert.deepEqual(selectMeshesInRect(new Map([['large-quad', largeQuad]]), camera, 600, 600, centerRect, true), ['large-quad'])
  assert.deepEqual(selectMeshesInRect(new Map([['large-quad', largeQuad]]), camera, 600, 600, centerRect, false), [])
})

test('selectMeshesInBox filters helpers/visibility, updates world matrices, and rejects diagonal AABB-only overlaps', () => {
  const scene = new THREE.Scene()
  const parent = new THREE.Group()
  parent.position.set(1, 0, 0)
  parent.rotation.z = Math.PI / 4
  parent.scale.set(2, 1, 1)
  scene.add(parent)

  // Thin diagonal slab rotated by parent; its world Box3 is wide, leaving corners empty
  const hitMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 0.2), new THREE.MeshBasicMaterial())
  parent.add(hitMesh)

  const helperMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial())
  helperMesh.userData.forgeEditorHelper = true
  scene.add(helperMesh)

  const hiddenGroup = new THREE.Group()
  hiddenGroup.visible = false
  const hiddenMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial())
  hiddenGroup.add(hiddenMesh)
  scene.add(hiddenGroup)

  const objects = new Map([
    ['hit', hitMesh],
    ['helper', helperMesh],
    ['hidden', hiddenMesh],
  ])

  // Box around world origin hits hitMesh? Wait: hitMesh is centered at (1, 0, 0), length 4 along rotated X.
  // Check a box around (1, 0, 0) -> hits 'hit' (ignoring 'helper' and 'hidden') without prior updateMatrixWorld
  const boxCenter = new THREE.Box3(new THREE.Vector3(0.8, -0.2, -0.2), new THREE.Vector3(1.2, 0.2, 0.2))
  assert.deepEqual(selectMeshesInBox(objects, boxCenter), ['hit'])

  // Box placed in the corner of hitMesh's world AABB where no triangle of the thin rotated slab passes
  hitMesh.updateWorldMatrix(true, false)
  const worldAabb = new THREE.Box3().setFromObject(hitMesh)
  const emptyCornerBox = new THREE.Box3(
    new THREE.Vector3(worldAabb.min.x, worldAabb.max.y - 0.1, -0.1),
    new THREE.Vector3(worldAabb.min.x + 0.1, worldAabb.max.y, 0.1),
  )
  assert.equal(worldAabb.intersectsBox(emptyCornerBox), true)
  assert.deepEqual(selectMeshesInBox(objects, emptyCornerBox), [])
})

test('selectTrianglesInBox supports indexed, non-indexed, InterleavedBufferAttribute, and centroid vs intersects modes', () => {
  // 1. Indexed BoxGeometry under rotated/non-uniformly scaled parent
  const group = new THREE.Group()
  group.position.set(2, 0, 0)
  group.rotation.y = Math.PI / 2
  group.scale.set(1, 2, 1)

  const indexedBox = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), new THREE.MeshBasicMaterial())
  group.add(indexedBox)

  // Local x in [-1, 1] maps to world z in [1, -1] after +90deg Y rotation; y scaled by 2 -> [-1, 1]
  // Box covering world x in [1.5, 2.5], y in [-1.5, 1.5], z in [0.5, 1.5] selects the face at world z=+1 (local x=-1)
  const faceBox = new THREE.Box3(new THREE.Vector3(1.5, -1.5, 0.5), new THREE.Vector3(2.5, 1.5, 1.5))
  const indexedTris = selectTrianglesInBox(indexedBox, faceBox, 'centroid')
  assert.equal(indexedTris.length, 2)

  // 2. InterleavedBufferAttribute non-indexed single triangle straddling box boundary
  // Vertices at (-2, 0, 0), (2, 0, 0), (0, 0.3, 0) -> centroid is (0, 0.1, 0)
  const interleavedData = new Float32Array([
    -2, 0, 0, 0, 0,
    2, 0, 0, 1, 0,
    0, 0.3, 0, 0.5, 1,
  ])
  const interleavedBuffer = new THREE.InterleavedBuffer(interleavedData, 5)
  const interleavedGeo = new THREE.BufferGeometry()
  interleavedGeo.setAttribute('position', new THREE.InterleavedBufferAttribute(interleavedBuffer, 3, 0))
  interleavedGeo.setAttribute('uv', new THREE.InterleavedBufferAttribute(interleavedBuffer, 2, 3))
  const interleavedMesh = new THREE.Mesh(interleavedGeo, new THREE.MeshBasicMaterial())

  // Box covers [0.5, 1.5] on X and [-0.5, 0.5] on Y/Z: triangle intersects box, but centroid (0, 0.1, 0) is outside!
  const edgeBox = new THREE.Box3(new THREE.Vector3(0.5, -0.5, -0.5), new THREE.Vector3(1.5, 0.5, 0.5))
  assert.deepEqual(selectTrianglesInBox(interleavedMesh, edgeBox, 'centroid'), [])
  assert.deepEqual(selectTrianglesInBox(interleavedMesh, edgeBox, 'intersects'), [0])

  const centroidBox = new THREE.Box3(new THREE.Vector3(-0.2, -0.2, -0.2), new THREE.Vector3(0.2, 0.2, 0.2))
  assert.deepEqual(selectTrianglesInBox(interleavedMesh, centroidBox, 'centroid'), [0])
})

test('extractTrianglesAsPart preserves world pose under rotated/non-uniformly scaled hierarchy, attributes, and multi-material groups', () => {
  const scene = new THREE.Scene()
  const parent = new THREE.Group()
  parent.position.set(1, -2, 0.5)
  parent.rotation.set(0.3, -0.4, 0.2)
  parent.scale.set(1.2, 0.8, 1.5)
  scene.add(parent)

  // Build 4 triangles (2 material groups) with position, normal, uv, uv1, normalized uint8 color, tangent
  const vertCount = 12
  const positions = new Float32Array([
    // Tri 0 (left, mat 0)
    -2, 0, 0, -1, 0, 0, -1.5, 1, 0,
    // Tri 1 (left, mat 0)
    -2, 0, 1, -1, 0, 1, -1.5, 1, 1,
    // Tri 2 (right, mat 1)
    2, 0, 0, 3, 0, 0, 2.5, 1, 0,
    // Tri 3 (right, mat 1)
    2, 0, 1, 3, 0, 1, 2.5, 1, 1,
  ])
  const normals = new Float32Array(vertCount * 3).fill(0)
  for (let i = 0; i < vertCount; i++) normals[i * 3 + 2] = 1
  const uvs = new Float32Array(vertCount * 2).map((_, i) => (i % 2 === 0 ? 0.25 : 0.75))
  const uv1s = new Float32Array(vertCount * 2).map((_, i) => (i % 2 === 0 ? 0.1 : 0.9))
  const colors = new Uint8Array(vertCount * 4).fill(255)
  colors[3 * 4] = 128 // normalized color check on first vertex of triangle 1
  const tangents = new Float32Array(vertCount * 4)
  for (let i = 0; i < vertCount; i++) {
    tangents[i * 4] = 1
    tangents[i * 4 + 3] = 1
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv1s, 2))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 4, true))
  geo.setAttribute('tangent', new THREE.BufferAttribute(tangents, 4))
  geo.addGroup(0, 6, 0)
  geo.addGroup(6, 6, 1)

  const matA = new THREE.MeshBasicMaterial({ color: '#ff0000' })
  const matB = new THREE.MeshBasicMaterial({ color: '#00ff00' })
  const mesh = new THREE.Mesh(geo, [matA, matB])
  mesh.name = 'MergedWing'
  mesh.userData.forgeId = 'asset:wing'
  mesh.userData.forgeImported = true
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.position.set(0.4, 0.7, -0.3)
  mesh.rotation.set(-0.25, 0.5, 0.15)
  mesh.scale.set(2.0, 0.5, 1.25)
  parent.add(mesh)

  // Snapshot original world vertices of triangles 1 and 2 before extraction
  const expectedWorldKeys = [
    triangleKey(getTriangleWorldVertices(mesh, 1)),
    triangleKey(getTriangleWorldVertices(mesh, 2)),
  ].sort()

  // Pass duplicate + out-of-range indices to test deduplication/validation
  const result = extractTrianglesAsPart(mesh, [2, 1, 2, -1, 99], {
    name: 'MergedWing_extract_1',
    forgeId: 'asset:wing:extract-1',
  })
  assert.ok(result)
  assert.equal(result.removedCount, 2)
  assert.equal(result.remainingCount, 2)

  // Add part as sibling under mesh.parent and replace source geometry
  parent.add(result.part)
  mesh.geometry = result.remainingGeometry

  // 1. Centered local pivot on part
  result.part.geometry.computeBoundingBox()
  const localCenter = result.part.geometry.boundingBox.getCenter(new THREE.Vector3())
  assert.ok(localCenter.length() < 1e-5, `Expected local center near (0,0,0), got ${localCenter.toArray()}`)

  // 2. Exact world-space vertex preservation
  const actualWorldKeys = [
    triangleKey(getTriangleWorldVertices(result.part, 0)),
    triangleKey(getTriangleWorldVertices(result.part, 1)),
  ].sort()
  for (let i = 0; i < 2; i++) {
    assert.equal(actualWorldKeys[i], expectedWorldKeys[i])
  }

  // 3. Attributes & multi-material groups preserved
  assert.ok(result.part.geometry.getAttribute('position'))
  assert.ok(result.part.geometry.getAttribute('normal'))
  assert.ok(result.part.geometry.getAttribute('uv'))
  assert.ok(result.part.geometry.getAttribute('uv1'))
  assert.ok(result.part.geometry.getAttribute('color'))
  assert.ok(result.part.geometry.getAttribute('tangent'))
  assert.equal(result.part.geometry.getAttribute('color').itemSize, 4)
  assert.ok(Math.abs(result.part.geometry.getAttribute('color').getX(0) - 128 / 255) < 0.01)
  assert.equal(result.part.geometry.getAttribute('tangent').itemSize, 4)
  assert.deepEqual(
    result.part.geometry.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })),
    [
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 },
    ],
  )
  assert.deepEqual(
    result.remainingGeometry.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })),
    [
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 },
    ],
  )

  // 4. Metadata preserved
  assert.equal(result.part.userData.forgeId, 'asset:wing:extract-1')
  assert.equal(result.part.userData.splitFrom, 'asset:wing')
  assert.equal(result.part.userData.forgeImported, true)
  assert.equal(result.part.castShadow, true)
  assert.equal(result.part.receiveShadow, true)

  // 5. Full extraction leaves 0 remaining triangles cleanly without crashing bounds or raycasting
  const fullExtract = extractTrianglesAsPart(mesh, [0, 1])
  assert.ok(fullExtract)
  assert.equal(fullExtract.removedCount, 2)
  assert.equal(fullExtract.remainingCount, 0)
  mesh.geometry = fullExtract.remainingGeometry
  const emptyBox = new THREE.Box3().setFromObject(mesh)
  assert.equal(emptyBox.isEmpty(), true)
  const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1))
  assert.deepEqual(raycaster.intersectObject(mesh, false), [])

  // 6. Empty/invalid inputs return null
  assert.equal(extractTrianglesAsPart(mesh, [0]), null)
  const freshMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  assert.equal(extractTrianglesAsPart(freshMesh, []), null)
  assert.equal(extractTrianglesAsPart(freshMesh, [-1, 999]), null)
})

test('2D marquee supports WebGPUCoordinateSystem [0, 1] near-plane clipping on PerspectiveCamera and OrthographicCamera', () => {
  const centerRect = { minX: 260, maxX: 340, minY: 260, maxY: 340 }

  // 1. PerspectiveCamera with WebGPUCoordinateSystem (near = 1.0, far = 100)
  const perspCam = new THREE.PerspectiveCamera(50, 1, 1.0, 100)
  perspCam.position.set(0, 0, 0)
  perspCam.lookAt(0, 0, -1)
  perspCam.coordinateSystem = THREE.WebGPUCoordinateSystem
  perspCam.updateProjectionMatrix()

  const perspInFrontGeo = new THREE.BufferGeometry()
  perspInFrontGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -0.1, -0.1, -0.7,
        0.1, -0.1, -0.7,
        0, 0.1, -0.7,
      ]),
      3,
    ),
  )
  const perspInFront = new THREE.Mesh(perspInFrontGeo, new THREE.MeshBasicMaterial())

  const perspVisibleGeo = new THREE.BufferGeometry()
  perspVisibleGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -0.1, -0.1, -5,
        0.1, -0.1, -5,
        0, 0.1, -5,
      ]),
      3,
    ),
  )
  const perspVisible = new THREE.Mesh(perspVisibleGeo, new THREE.MeshBasicMaterial())

  const perspStraddleGeo = new THREE.BufferGeometry()
  perspStraddleGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -0.05, -0.05, -0.5,
        0.05, -0.05, -0.5,
        0, 0.05, -2.0,
      ]),
      3,
    ),
  )
  const perspStraddle = new THREE.Mesh(perspStraddleGeo, new THREE.MeshBasicMaterial())

  const perspFallbackInFront = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  perspFallbackInFront.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial()))
  perspFallbackInFront.children[0].position.set(0, 0, -0.7)

  const perspMap = new Map([
    ['in-front-of-near', perspInFront],
    ['visible', perspVisible],
    ['straddle', perspStraddle],
    ['fallback-in-front', perspFallbackInFront],
  ])
  assert.deepEqual(selectMeshesInRect(perspMap, perspCam, 600, 600, centerRect, true), ['visible', 'straddle'])
  assert.deepEqual(selectMeshesInRect(perspMap, perspCam, 600, 600, centerRect, false), ['visible'])

  // 2. OrthographicCamera with WebGPUCoordinateSystem (near = 1.0, far = 10)
  const orthoCam = new THREE.OrthographicCamera(-5, 5, 5, -5, 1.0, 10)
  orthoCam.position.set(0, 0, 0)
  orthoCam.lookAt(0, 0, -1)
  orthoCam.coordinateSystem = THREE.WebGPUCoordinateSystem
  orthoCam.updateProjectionMatrix()

  const orthoInFrontGeo = new THREE.BufferGeometry()
  orthoInFrontGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -0.2, -0.2, -0.5,
        0.2, -0.2, -0.5,
        0, 0.2, -0.5,
      ]),
      3,
    ),
  )
  const orthoInFront = new THREE.Mesh(orthoInFrontGeo, new THREE.MeshBasicMaterial())

  const orthoVisibleGeo = new THREE.BufferGeometry()
  orthoVisibleGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -0.2, -0.2, -3,
        0.2, -0.2, -3,
        0, 0.2, -3,
      ]),
      3,
    ),
  )
  const orthoVisible = new THREE.Mesh(orthoVisibleGeo, new THREE.MeshBasicMaterial())

  const orthoMap = new Map([
    ['ortho-in-front-of-near', orthoInFront],
    ['ortho-visible', orthoVisible],
  ])
  assert.deepEqual(selectMeshesInRect(orthoMap, orthoCam, 600, 600, centerRect, true), ['ortho-visible'])
  assert.deepEqual(selectMeshesInRect(orthoMap, orthoCam, 600, 600, centerRect, false), ['ortho-visible'])
})

test('2D marquee ignores unreferenced vertices in indexed geometries and short index buffers', () => {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)

  const centerRect = { minX: 270, maxX: 330, minY: 270, maxY: 330 }

  // 1. Unreferenced vertex inside centerRect while referenced triangle [1, 2, 3] is far left outside rect
  const falsePosGeo = new THREE.BufferGeometry()
  falsePosGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        0, 0, 0, // unreferenced vertex right in centerRect
        -3.5, -0.5, 0,
        -3.0, -0.5, 0,
        -3.25, 0.5, 0,
      ]),
      3,
    ),
  )
  falsePosGeo.setIndex([1, 2, 3])
  const falsePosMesh = new THREE.Mesh(falsePosGeo, new THREE.MeshBasicMaterial())

  // 2. Unreferenced vertex way outside rect/frustum while referenced triangle [0, 1, 2] is completely inside centerRect
  const falseNegGeo = new THREE.BufferGeometry()
  falseNegGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -0.1, -0.1, 0,
        0.1, -0.1, 0,
        0, 0.1, 0,
        50, 50, 0, // unreferenced outlier vertex
      ]),
      3,
    ),
  )
  falseNegGeo.setIndex([0, 1, 2])
  const falseNegMesh = new THREE.Mesh(falseNegGeo, new THREE.MeshBasicMaterial())

  // 3. Indexed mesh with < 3 indices (0 triangles)
  const shortIndexGeo = new THREE.BufferGeometry()
  shortIndexGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.05, 0.05, 0]), 3),
  )
  shortIndexGeo.setIndex([0, 1])
  const shortIndexMesh = new THREE.Mesh(shortIndexGeo, new THREE.MeshBasicMaterial())

  assert.deepEqual(selectMeshesInRect(new Map([['unreferenced', falsePosMesh]]), camera, 600, 600, centerRect, true), [])
  assert.deepEqual(selectMeshesInRect(new Map([['unreferenced', falsePosMesh]]), camera, 600, 600, centerRect, false), [])
  assert.deepEqual(
    selectMeshesInRect(new Map([['contained-indexed', falseNegMesh]]), camera, 600, 600, centerRect, false),
    ['contained-indexed'],
  )
  assert.deepEqual(selectMeshesInRect(new Map([['short-index', shortIndexMesh]]), camera, 600, 600, centerRect, true), [])
  assert.deepEqual(selectMeshesInRect(new Map([['short-index', shortIndexMesh]]), camera, 600, 600, centerRect, false), [])
})

test('2D marquee does not select empty-geometry parent mesh via child bounds after full triangle extraction', () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)

  const parentMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  const fullExtract = extractTrianglesAsPart(
    parentMesh,
    Array.from({ length: 12 }, (_, i) => i),
  )
  assert.ok(fullExtract)
  assert.equal(fullExtract.remainingCount, 0)
  parentMesh.geometry = fullExtract.remainingGeometry
  assert.equal(parentMesh.geometry.getAttribute('position').count, 0)

  const childMesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshBasicMaterial())
  parentMesh.add(childMesh)
  scene.add(parentMesh)

  const map = new Map([
    ['empty-parent', parentMesh],
    ['child', childMesh],
  ])
  const centerRect = { minX: 250, maxX: 350, minY: 250, maxY: 350 }
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, centerRect, true), ['child'])
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, centerRect, false), ['child'])
})
