import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { selectMeshesInRect } from '../src/features/selection/viewportSelection.ts'
import { createDefaultManifest, validateSceneManifest } from '../src/domain/sceneManifest.ts'
import { generateR3FComponent, patchR3FFile } from '../src/export/r3f/r3fCodegen.ts'

test('marquee selection handles nested and rotated imported meshes accurately', () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)

  const parentGroup = new THREE.Group()
  parentGroup.position.set(-1.2, 0, 0)
  parentGroup.rotation.z = Math.PI / 4

  const childMesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshBasicMaterial())
  childMesh.userData.forgeId = 'imported:0.0'
  parentGroup.add(childMesh)
  scene.add(parentGroup)

  const map = new Map([['imported:0.0', childMesh]])
  // Deliberately do NOT call updateMatrixWorld on parentGroup before calling selectMeshesInRect
  const rect = { minX: 160, maxX: 300, minY: 220, maxY: 380 }
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, rect, false), ['imported:0.0'])
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, rect, true), ['imported:0.0'])
})

test('scene manifest validates and R3F patch preserves user code outside markers', () => {
  const manifest = createDefaultManifest('DroneStage', './assets/drone.glb')
  manifest.environment.xrEnabled = true
  manifest.camera.position = [1, 2, 3]
  assert.equal(validateSceneManifest(manifest), true)

  const initial = generateR3FComponent(manifest)
  assert.match(initial, /import \{ XR, createXRStore \} from '@react-three\/xr'/)
  assert.match(initial, /position: \[1, 2, 3\]/)

  const customized = initial + '\n// User custom helper\nexport const CUSTOM_FLAG = 42\n'
  manifest.camera.position = [9, 8, 7]
  const patched = patchR3FFile(customized, manifest)
  assert.match(patched, /position: \[9, 8, 7\]/)
  assert.match(patched, /export const CUSTOM_FLAG = 42/)
})
