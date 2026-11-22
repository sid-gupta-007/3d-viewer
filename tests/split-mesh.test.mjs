import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { pickAllVisibleMeshes, cycleMeshHit } from '../src/features/selection/pickMesh.ts'
import { splitMeshByConnectedIslands, splitMeshByMaterialGroups } from '../src/features/geometry/splitMesh.ts'

function mergeGeometriesSimple(a, b) {
  const na = a.toNonIndexed()
  const nb = b.toNonIndexed()
  const pa = na.getAttribute('position')
  const pb = nb.getAttribute('position')
  const merged = new Float32Array((pa.count + pb.count) * 3)
  merged.set(pa.array, 0)
  merged.set(pb.array, pa.count * 3)
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(merged, 3))
  out.computeVertexNormals()
  return out
}

test('AutoCAD-style raycast cycling selects occluded inner mesh inside outer mesh', () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)

  const outer = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial())
  outer.userData.forgeId = 'outer-shell'
  const inner = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  inner.userData.forgeId = 'inner-core'
  scene.add(outer, inner)

  const map = new Map([['outer-shell', outer], ['inner-core', inner]])
  const raycaster = new THREE.Raycaster()
  const hits = pickAllVisibleMeshes(map, camera, raycaster, new THREE.Vector2(0, 0))

  assert.deepEqual(hits.map((h) => h.object.userData.forgeId), ['outer-shell', 'inner-core'])
  assert.equal(cycleMeshHit(hits, 'outer-shell')?.object.userData.forgeId, 'inner-core')
  assert.equal(cycleMeshHit(hits, 'inner-core')?.object.userData.forgeId, 'outer-shell')
})

test('splitMeshByConnectedIslands separates disconnected parts with centered pivots', () => {
  const boxA = new THREE.BoxGeometry(1, 1, 1).translate(-3, 0, 0)
  const boxB = new THREE.BoxGeometry(1, 1, 1).translate(3, 0, 0)
  const merged = mergeGeometriesSimple(boxA, boxB)
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial())
  mesh.name = 'Wheels'
  mesh.userData.forgeId = 'model:wheels'

  const { parts } = splitMeshByConnectedIslands(mesh)
  assert.equal(parts.length, 2)
  const xs = parts.map((p) => Math.round(p.position.x)).sort((a, b) => a - b)
  assert.deepEqual(xs, [-3, 3])
  assert.equal(parts[0].userData.splitFrom, 'model:wheels')
})

test('splitMeshByMaterialGroups separates multi-group geometry into child meshes', () => {
  const box = new THREE.BoxGeometry(1, 1, 1) // has 6 groups (1 per face)
  const mesh = new THREE.Mesh(box, [
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
  ])
  mesh.name = 'Cube'
  mesh.userData.forgeId = 'model:cube'

  const { parts } = splitMeshByMaterialGroups(mesh)
  assert.equal(parts.length, 6)
})
