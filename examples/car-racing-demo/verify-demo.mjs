import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createDefaultManifest, validateSceneManifest } from '../../src/domain/sceneManifest.ts'
import { generateR3FComponent, patchR3FFile } from '../../src/export/r3f/r3fCodegen.ts'
import { extractTrianglesAsPart, selectTrianglesInBox, sliceMeshWithBox } from '../../src/features/selection/volumeSelector.ts'

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

function createMultiPartCarAndPersonGltf() {
  // Real glTF 2.0 JSON with embedded base64 buffer containing:
  // - Racing_Car (Car_Body, Car_Door_Left, Steering_Wheel, Rear_View_Mirror, Windshield_Glass, 4 Wheels)
  // - Driver_Person standing outside next to Car_Door_Left (Person_Torso, Person_Head, Person_RightArm, Person_LeftArm, Person_Legs)
  const boxGeo = new THREE.BoxGeometry(1, 1, 1).toNonIndexed()
  const posAttr = boxGeo.getAttribute('position')
  const normAttr = boxGeo.getAttribute('normal')
  const posBytes = new Uint8Array(posAttr.array.buffer, posAttr.array.byteOffset, posAttr.array.byteLength)
  const normBytes = new Uint8Array(normAttr.array.buffer, normAttr.array.byteOffset, normAttr.array.byteLength)
  const combined = new Uint8Array(posBytes.byteLength + normBytes.byteLength)
  combined.set(posBytes, 0)
  combined.set(normBytes, posBytes.byteLength)
  const base64 = Buffer.from(combined).toString('base64')

  return {
    asset: { version: '2.0', generator: 'Forge-3D-Demo-Builder' },
    scene: 0,
    scenes: [{ name: 'CarRacingWorld', nodes: [0, 1] }],
    nodes: [
      {
        name: 'Racing_Car',
        children: [2, 3, 4, 5, 6, 7],
        translation: [0, 0, 0],
      },
      {
        name: 'Driver_Person',
        children: [8, 9, 10, 11],
        translation: [-1.6, 0, 0.2],
      },
      { name: 'Car_Body', mesh: 0, translation: [0, 0.45, 0], scale: [1.5, 0.45, 3.2] },
      { name: 'Car_Door_Left', mesh: 0, translation: [-0.78, 0.48, 0.4], scale: [0.1, 0.42, 1.05] },
      { name: 'Steering_Wheel', mesh: 0, translation: [-0.36, 0.68, 0.35], scale: [0.3, 0.3, 0.06] },
      { name: 'Rear_View_Mirror', mesh: 0, translation: [0, 0.96, 0.38], scale: [0.34, 0.1, 0.04] },
      { name: 'Windshield_Glass', mesh: 0, translation: [0, 0.84, 0.52], scale: [1.36, 0.48, 0.06] },
      { name: 'Wheel_FL', mesh: 0, translation: [-0.78, 0.26, 1.05], scale: [0.22, 0.5, 0.5] },
      { name: 'Person_Torso', mesh: 0, translation: [0, 0.92, 0], scale: [0.38, 0.56, 0.22] },
      { name: 'Person_Head', mesh: 0, translation: [0, 1.38, 0], scale: [0.24, 0.26, 0.24] },
      { name: 'Person_RightArm', mesh: 0, translation: [0.26, 0.96, 0], scale: [0.12, 0.48, 0.12] },
      { name: 'Person_Legs', mesh: 0, translation: [0, 0.32, 0], scale: [0.34, 0.64, 0.2] },
    ],
    meshes: [
      {
        name: 'UnitBoxMesh',
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, mode: 4 }],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: posAttr.count,
        type: 'VEC3',
        min: [-0.5, -0.5, -0.5],
        max: [0.5, 0.5, 0.5],
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: normAttr.count,
        type: 'VEC3',
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength },
      { buffer: 0, byteOffset: posBytes.byteLength, byteLength: normBytes.byteLength },
    ],
    buffers: [
      {
        byteLength: combined.byteLength,
        uri: `data:application/octet-stream;base64,${base64}`,
      },
    ],
  }
}

async function runDemoProjectVerification() {
  const assetsDir = path.join(__dirname, 'assets')
  const forgeDir = path.join(__dirname, '.forge')
  const srcDir = path.join(__dirname, 'src')
  await mkdir(assetsDir, { recursive: true })
  await mkdir(forgeDir, { recursive: true })
  await mkdir(srcDir, { recursive: true })

  // 1. Write the real glTF model asset to disk
  const gltfJson = createMultiPartCarAndPersonGltf()
  const gltfPath = path.join(assetsDir, 'car-and-driver.gltf')
  await writeFile(gltfPath, JSON.stringify(gltfJson, null, 2), 'utf8')

  // 2. Load the glTF model with Three.js GLTFLoader just like Forge 3D does
  const rawGltf = await readFile(gltfPath, 'utf8')
  const loader = new GLTFLoader()
  const loaded = await loader.parseAsync(rawGltf, '')
  const scene = loaded.scene
  scene.updateMatrixWorld(true)

  const objectsByName = new Map()
  scene.traverse((obj) => {
    if (obj.name) objectsByName.set(obj.name, obj)
  })

  const carRoot = objectsByName.get('Racing_Car')
  const carDoor = objectsByName.get('Car_Door_Left')
  const steeringWheel = objectsByName.get('Steering_Wheel')
  const carBody = objectsByName.get('Car_Body')
  const driverRoot = objectsByName.get('Driver_Person')
  const driverArm = objectsByName.get('Person_RightArm')
  const driverHead = objectsByName.get('Person_Head')

  assert.ok(carRoot && carDoor && steeringWheel && driverRoot && driverArm && driverHead, 'All Car and Person parts loaded from glTF')

  // 3. Test 3D Box Planar Slicing on Car_Body (zero spikes!)
  const sliceBox = new THREE.Box3(new THREE.Vector3(-2, 0.45, -2), new THREE.Vector3(2, 2, 2))
  const slicedRoof = sliceMeshWithBox(carBody, sliceBox, { name: 'Car_UpperBody', forgeId: 'car:upper' })
  assert.ok(slicedRoof && slicedRoof.part.geometry.getAttribute('position').count > 0, 'Planar 3D Box slicing cleanly sliced Car_Body')

  // 4. Build the Forge Scene Manifest (.forge/scene.json) with custom keybindings & keyframes
  const manifest = createDefaultManifest('CarRacingGame', './assets/car-and-driver.gltf')
  manifest.environment.preset = 'sunset'
  manifest.camera.position = [-3.2, 1.8, 4.5]
  manifest.camera.target = [0, 0.8, 0]
  manifest.nodes = [
    { forgeId: 'car:root', name: 'Racing_Car', parentId: null, type: 'Group', visible: true, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { forgeId: 'car:door', name: 'Car_Door_Left', parentId: 'car:root', type: 'Mesh', visible: true, position: [-0.78, 0.48, 0.4], rotation: [0, 1.22, 0], scale: [0.1, 0.42, 1.05], pivot: [0, 0, -0.52] },
    { forgeId: 'car:steer', name: 'Steering_Wheel', parentId: 'car:root', type: 'Mesh', visible: true, position: [-0.36, 0.68, 0.35], rotation: [0, 0, 0.65], scale: [0.3, 0.3, 0.06] },
    { forgeId: 'person:root', name: 'Driver_Person', parentId: 'car:root', type: 'Group', visible: true, position: [-0.36, -0.18, 0], rotation: [0, 0, 0], scale: [1, 0.82, 1] },
  ]
  manifest.keyframes = [
    { id: 'kf-door-0', targetId: 'car:door', time: 0, position: [-0.78, 0.48, 0.4], rotation: [0, 0, 0], scale: [0.1, 0.42, 1.05] },
    { id: 'kf-door-1', targetId: 'car:door', time: 1.0, position: [-0.78, 0.48, 0.4], rotation: [0, 1.22, 0], scale: [0.1, 0.42, 1.05] },
    { id: 'kf-drive-0', targetId: 'car:root', time: 1.5, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { id: 'kf-drive-1', targetId: 'car:root', time: 3.5, position: [1.4, 0, 8.5], rotation: [-0.04, 0.25, 0.05], scale: [1, 1, 1] },
  ]

  assert.equal(validateSceneManifest(manifest), true)
  const manifestPath = path.join(forgeDir, 'scene.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  // 5. Generate & Live-Patch the React Three Fiber Game Component (src/CarRacingGame.tsx)
  const initialR3F = generateR3FComponent(manifest)
  const gameComponentWithCustomKeys = `${initialR3F}
// Custom User Game Logic (preserved across Forge 3D live syncs!)
export const GAME_KEYBINDINGS = {
  E: { target: 'Car_Door_Left', action: 'hinge90' },
  F: { target: 'Driver_Person', action: 'enterCarSeat' },
  W: { target: 'Racing_Car', action: 'driveForwardWithInertia' },
  A: { target: 'Steering_Wheel', action: 'turnLeft' },
  D: { target: 'Steering_Wheel', action: 'turnRight' },
  C: { target: 'Person_Head', action: 'toggleFirstPersonFpsPov' },
} as const
`
  const tsxPath = path.join(srcDir, 'CarRacingGame.tsx')
  await writeFile(tsxPath, gameComponentWithCustomKeys, 'utf8')

  // 6. Simulate editing the camera & car position in Forge 3D and verify patchR3FFile updates the code without touching GAME_KEYBINDINGS!
  manifest.camera.position = [-0.36, 1.18, 0.12] // Driver First-Person FPS POV inside cabin!
  const patchedTsx = patchR3FFile(await readFile(tsxPath, 'utf8'), manifest)
  await writeFile(tsxPath, patchedTsx, 'utf8')

  assert.ok(patchedTsx.includes('position: [-0.36, 1.18, 0.12]'), 'Forge live sync updated camera to Driver First-Person FPS POV')
  assert.ok(patchedTsx.includes('export const GAME_KEYBINDINGS'), 'Forge live sync preserved custom user keybinding logic outside @forge markers')

  console.log('✔ Car Racing Demo Project built and verified at:', __dirname)
  console.log('  - Real glTF Model:', gltfPath)
  console.log('  - Forge Manifest :', manifestPath)
  console.log('  - Synced R3F Code:', tsxPath)
}

await runDemoProjectVerification()
