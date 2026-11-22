import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three/webgpu'
import { selectMany, selectOne } from '../src/features/selection/selectionState.ts'
import { pickClosestVisibleMesh } from '../src/features/selection/pickMesh.ts'
import { dissolveProgress, effectSeedOffset, isDissolveEffect, isBurnEffect, isParticleEffect, isSceneEffect } from '../src/features/effects/dissolve.ts'
import { createPivotController } from '../src/renderer/three/pivots.ts'
import { createDissolveController } from '../src/renderer/three/dissolve.ts'
import { selectMeshesInRect } from '../src/features/selection/viewportSelection.ts'

test('viewport click picks the nearest visible mesh and ignores hidden parents', () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.z = 10
  camera.lookAt(0, 0, 0)
  const front = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1), new THREE.MeshBasicMaterial())
  front.position.z = 1
  front.userData.forgeId = 'front'
  scene.add(front)
  const back = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1), new THREE.MeshBasicMaterial())
  back.userData.forgeId = 'back'
  scene.add(back)
  const hiddenParent = new THREE.Group()
  hiddenParent.visible = false
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1), new THREE.MeshBasicMaterial())
  hidden.userData.forgeId = 'hidden'
  hiddenParent.add(hidden)
  scene.add(hiddenParent)
  scene.updateMatrixWorld(true)
  const map = new Map([['front', front], ['back', back], ['hidden', hidden]])
  const hit = pickClosestVisibleMesh(map, camera, new THREE.Raycaster(), new THREE.Vector2(0, 0))
  assert.equal(hit?.object.userData.forgeId, 'front')
})

test('pivot edits preserve the mesh pose and reset restores its geometry', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial())
  mesh.position.set(2, 1, -1)
  mesh.rotation.set(0.2, 0.4, -0.1)
  mesh.scale.set(1.5, 0.8, 2)
  mesh.updateMatrixWorld(true)
  const before = new THREE.Box3().setFromObject(mesh)
  const originalGeometry = mesh.geometry
  const pivots = createPivotController()
  assert.equal(pivots.apply('body', mesh, [0.35, -0.2, 0.1]), true)
  mesh.updateMatrixWorld(true)
  const after = new THREE.Box3().setFromObject(mesh)
  assert.ok(before.min.distanceTo(after.min) < 1e-5)
  assert.ok(before.max.distanceTo(after.max) < 1e-5)
  assert.deepEqual(pivots.get('body'), [0.35, -0.2, 0.1])
  pivots.reset('body')
  assert.equal(mesh.geometry, originalGeometry)
  assert.deepEqual(pivots.get('body'), [0, 0, 0])
})

test('single and area selection preserve additive behavior without duplicate IDs', () => {
  const first = selectOne({ primary: '', ids: [] }, 'body', false)
  const additive = selectOne(first, 'rotor', true)
  assert.deepEqual(additive, { primary: 'rotor', ids: ['body', 'rotor'] })
  assert.deepEqual(selectOne(additive, 'body', true), { primary: 'rotor', ids: ['rotor'] })
  assert.deepEqual(selectMany(additive, ['rotor', 'rotor', 'body'], true), { primary: 'body', ids: ['body', 'rotor'] })
})

test('marquee selects contained meshes left-to-right and intersecting meshes right-to-left', () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  const inside = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  inside.position.x = -1
  const crossing = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  crossing.position.x = 1.7
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  hidden.visible = false
  scene.add(inside, crossing, hidden)
  const map = new Map([['inside', inside], ['crossing', crossing], ['hidden', hidden]])
  const rect = { minX: 190, maxX: 400, minY: 260, maxY: 340 }
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, rect, false), ['inside'])
  assert.deepEqual(selectMeshesInRect(map, camera, 600, 600, rect, true), ['inside', 'crossing'])
})

test('dissolve progress is deterministic at endpoints and between them', () => {
  const effect = { targetId: 'part', startTime: 2, endTime: 6, edgeColor: '#ffaa22', edgeWidth: 0.08, seed: 7 }
  assert.equal(dissolveProgress(effect, 1), 0)
  assert.equal(dissolveProgress(effect, 4), 0.5)
  assert.equal(dissolveProgress(effect, 7), 1)
  assert.equal(isDissolveEffect(effect), true)
  assert.equal(isDissolveEffect({ ...effect, endTime: 2 }), false)
  assert.equal(isDissolveEffect({ ...effect, edgeColor: 'orange' }), false)
})

test('effect noise seeds stay bounded and deterministic for GPU precision', () => {
  assert.equal(effectSeedOffset(42), effectSeedOffset(42))
  assert.equal(effectSeedOffset(0), 0)
  assert.equal(effectSeedOffset(0xffffffff), 64)
  assert.ok(effectSeedOffset(0xdeadbeef) < 64)
})

test('dissolve, burn, and particle effect data validate with bounded settings', () => {
  const timing = { targetId: 'part', startTime: 0, endTime: 4, seed: 42 }
  const dissolve = { ...timing, kind: 'dissolve', edgeColor: '#b7f36b', edgeWidth: 0.08 }
  const burn = { ...timing, kind: 'burn', edgeColor: '#ff7a27', edgeWidth: 0.08, flameColor: '#ffb02e' }
  const particles = { ...timing, kind: 'particles', color: '#ff9b36', particleCount: 256, particleSize: 7 }
  assert.equal(isSceneEffect(dissolve), true)
  assert.equal(isBurnEffect(burn), true)
  assert.equal(isSceneEffect(burn), true)
  assert.equal(isParticleEffect(particles), true)
  assert.equal(isSceneEffect(particles), true)
  assert.equal(isParticleEffect({ ...particles, particleCount: 2 }), false)
  assert.equal(isSceneEffect({ ...burn, kind: 'unknown' }), false)
})

test('effect preview installs burn and GPU points, updates, then restores and disposes them', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
  mesh.userData.forgeId = 'part'
  const original = mesh.material
  const controller = createDissolveController()
  const effects = [
    { targetId: 'part', startTime: 0, endTime: 2, kind: 'burn', edgeColor: '#ff7722', flameColor: '#ffaa22', edgeWidth: 0.08, seed: 42 },
    { targetId: 'part', startTime: 0, endTime: 2, kind: 'particles', color: '#ff9b36', particleCount: 64, particleSize: 7, seed: 42 },
  ]
  controller.update(new Map([['part', mesh]]), effects, 1)
  assert.equal(mesh.material.isMeshPhysicalNodeMaterial, true)
  assert.equal(mesh.children.some((child) => child.isPoints), true)
  controller.clear()
  assert.equal(mesh.material, original)
  assert.equal(mesh.children.some((child) => child.isPoints), false)
})
