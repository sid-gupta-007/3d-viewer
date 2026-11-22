import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { selectMeshesInRect } from './features/selection/viewportSelection'
import { cycleMeshHit, pickAllVisibleMeshes } from './features/selection/pickMesh'
import { extractTrianglesAsPart, selectMeshesInBox, selectTrianglesInBox, selectTrianglesInScreenPolygon, sliceMeshWithBox, smoothSpikyMeshEdges, type ScreenPoint } from './features/selection/volumeSelector'
import { splitMeshByConnectedIslands, splitMeshByMaterialGroups } from './features/geometry/splitMesh'
import { ENVIRONMENT_PRESETS } from './features/environment/environmentPresets'
import type { EnvironmentPresetId } from './domain/sceneManifest'
import type { SceneEffect } from './features/effects/dissolve'
import { createDissolveController } from './renderer/three/dissolve'
import { createPivotController, type PivotPoint } from './renderer/three/pivots'

export type SceneNode = { id: string; name: string; type: string; visible: boolean; parent: string | null }
export type ObjectTransform = { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }
export type ObjectStats = { meshCount: number; vertexCount: number; triangleCount: number; materialCount: number; dimensions: [number, number, number] }
export type ViewportApi = {
  loadModel: (file: File, assetKey?: string, resources?: File[], resourcePaths?: string[], append?: boolean) => Promise<SceneNode[]>
  clearImported: () => void
  getTransform: (id: string) => ObjectTransform | null
  getTransforms: () => Record<string, ObjectTransform>
  setTransform: (id: string, transform: ObjectTransform) => void
  setVisible: (id: string, visible: boolean) => void
  getNodes: () => SceneNode[] | null
  getProjectSnapshot: () => { nodes: SceneNode[]; files: File[]; resourcePaths: string[]; assetKey: string } | null
  frameObject: (id: string) => void
  resetTransform: (id: string) => void
  getObjectStats: (id: string) => ObjectStats | null
  setWireframe: (enabled: boolean) => void
  setEffects: (effects: SceneEffect[], time: number) => void
  getPivot: (id: string) => PivotPoint
  getPivots: () => Record<string, PivotPoint>
  setPivot: (id: string, pivot: PivotPoint, preservePose?: boolean) => boolean
  setPivotFromLastHit: (id: string) => PivotPoint | null
  splitSelectedMesh: (id: string, mode: 'islands' | 'materials') => SceneNode[] | null
  applyEnvironmentPreset: (presetId: EnvironmentPresetId) => void
  getCameraPose: () => { position: [number, number, number]; target: [number, number, number]; fov: number } | null
  setVolumeBoxMode?: (mode: 'translate' | 'scale') => void
  getVolumeSelection?: () => { meshIds: string[]; triangleCount: number; primaryMeshId: string | null }
  extractBoxSelection?: () => { extractedIds: string[]; modifiedSourceIds: string[]; extractedCount: number } | null
  captureSceneSnapshot?: (includeGeometry?: boolean) => { nodes: SceneNode[]; transforms: Record<string, ObjectTransform>; visibility: Record<string, boolean>; pivots: Record<string, PivotPoint>; geometrySnapshot: Record<string, THREE.BufferGeometry> } | null
  restoreSceneSnapshot?: (snapshot: { nodes: SceneNode[]; transforms: Record<string, ObjectTransform>; visibility: Record<string, boolean>; pivots: Record<string, PivotPoint>; geometrySnapshot?: Record<string, unknown> }) => void
  addSceneCamera?: (name?: string) => SceneNode | null
  setActivePovCamera?: (id: string | null) => void
  applyVolumePreset?: (preset: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'lastHit') => void
  smoothSelectedMesh?: (id: string) => number
  deleteSelectedObjects?: (ids: string[]) => SceneNode[] | null
  deleteBoxSelection?: () => { modifiedSourceIds: string[]; deletedCount: number } | null
  getAnimationClips?: () => Array<{ name: string; duration: number }>
  setActiveAnimationClip?: (name: string | null, time?: number) => void
  setSkeletonVisible?: (visible: boolean) => void
  setFreeformMode?: (mode: 'off' | 'extract' | 'delete') => void
  duplicateObject?: (id: string) => SceneNode[] | null
  snapObjectToGround?: (id: string) => ObjectTransform | null
  setParentObject?: (childId: string, newParentId: string | null) => SceneNode[] | null
  setQuickHingePivot?: (id: string, preset: 'top' | 'bottom' | 'left' | 'right' | 'center') => PivotPoint | null
  alignObjectToTarget?: (sourceId: string, targetId: string) => ObjectTransform | null
  attachFpsCameraToNode?: (targetId: string) => SceneNode | null
  setMeshSurfacePreset?: (id: string, preset: 'mirror' | 'glass' | 'default') => boolean
  stepUniversalInputs?: (
    keys: Set<string>,
    toggledKeys: Set<string>,
    dt: number,
    bindings: Array<{
      targetId: string
      input: string
      axis: 'x' | 'y' | 'z'
      action: 'translate' | 'rotate' | 'hinge' | 'spin' | 'cameraPov'
      speed: number
    }>
  ) => void
}
type Props = {
  selectedId: string
  selectedIds: string[]
  activeTool: 'select' | 'move' | 'rotate' | 'scale' | 'volume'
  boxSelect: boolean
  onSelect: (id: string, additive: boolean) => void
  onSelectMany: (ids: string[], additive: boolean) => void
  onNodesChange: (nodes: SceneNode[]) => void
  onRendererChange: (name: string) => void
  onRendererError: (message: string) => void
  onTransformChange: (transform: ObjectTransform) => void
  onTransformCommit?: () => void
}
type VolumeSelectionState = {
  meshIds: string[]
  trianglesByMesh: Map<string, number[]>
  triangleCount: number
  primaryMeshId: string | null
}
type ViewportRuntime = { scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGPURenderer; controls: OrbitControls; objects: Map<string, THREE.Object3D>; nodes: SceneNode[]; initialTransforms: Map<string, ObjectTransform>; asset: { files: File[]; resourcePaths: string[]; assetKey: string } | null; transform: TransformControls; selectionHelper: THREE.Box3Helper; selectionHelpers: Map<string, THREE.Box3Helper>; selectionProxy: THREE.Group; dragStart: { proxyMatrix: THREE.Matrix4; objectMatrices: Map<string, THREE.Matrix4> } | null; wireframeMaterials: Map<THREE.Material, boolean | undefined>; dissolves: ReturnType<typeof createDissolveController>; pivots: ReturnType<typeof createPivotController>; lastHit: { id: string; point: PivotPoint } | null; observer: ResizeObserver; volumeProxy: THREE.Group; volumeBox: THREE.Box3; volumeHelper: THREE.Box3Helper; volumeFillMesh: THREE.Mesh; volumeHighlightMesh: THREE.Mesh; volumeMode: 'translate' | 'scale'; volumeActive: boolean; volumeInitialized: boolean; volumeSelection: VolumeSelectionState; mixer: THREE.AnimationMixer | null; clips: THREE.AnimationClip[]; activeClipName: string | null; skeletonHelper: THREE.SkeletonHelper | null; freeformMode: 'off' | 'extract' | 'delete' }

const tuple = (value: THREE.Vector3): [number, number, number] => [value.x, value.y, value.z]
const readTransform = (object: THREE.Object3D): ObjectTransform => ({ position: tuple(object.position), rotation: [object.rotation.x, object.rotation.y, object.rotation.z], scale: tuple(object.scale) })
function disposeObjectTree(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry) geometries.add(mesh.geometry)
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
    }
  })
  geometries.forEach((geometry) => geometry.dispose())
  materials.forEach((material) => material.dispose())
  textures.forEach((texture) => texture.dispose())
}
function readImportedNodes(current: ViewportRuntime): SceneNode[] {
  const importedRoots = current.scene.children.filter((child) => child.userData.forgeImported)
  if (Array.isArray(current.nodes) && (current.nodes.length || importedRoots.length === 0)) return [...current.nodes]
  const nodes: SceneNode[] = []
  current.initialTransforms ??= new Map()
  for (const root of importedRoots) {
    const rootId = root.userData.forgeId as string | undefined
    if (!rootId) continue
    nodes.push({ id: rootId, name: root.name || 'Scene', type: 'imported', visible: root.visible, parent: null })
    root.traverse((object) => {
      if (object === root) return
      const id = object.userData.forgeId as string | undefined
      if (!id) return
      const parentId = object.parent?.userData.forgeId as string | undefined
      nodes.push({ id, name: object.name || object.type, type: (object as THREE.Mesh).isMesh ? 'Mesh' : object.type, visible: object.visible, parent: parentId ?? rootId })
      current.initialTransforms.set(id, readTransform(object))
    })
    current.initialTransforms.set(rootId, readTransform(root))
  }
  current.nodes = nodes
  return [...nodes]
}

function syncVolumeVisuals(current: ViewportRuntime) {
  current.volumeProxy.rotation.set(0, 0, 0)
  current.volumeProxy.quaternion.identity()
  current.volumeProxy.scale.set(
    Math.max(Math.abs(current.volumeProxy.scale.x), 0.02),
    Math.max(Math.abs(current.volumeProxy.scale.y), 0.02),
    Math.max(Math.abs(current.volumeProxy.scale.z), 0.02),
  )
  current.volumeProxy.updateMatrixWorld(true)
  current.volumeBox.setFromCenterAndSize(current.volumeProxy.position, current.volumeProxy.scale)
  current.volumeFillMesh.position.copy(current.volumeProxy.position)
  current.volumeFillMesh.scale.copy(current.volumeProxy.scale)
}

function computeTargetBounds(current: ViewportRuntime, selectedId: string): THREE.Box3 {
  const selectedObj = selectedId ? current.objects.get(selectedId) : undefined
  const bounds = new THREE.Box3()
  if (selectedObj) {
    bounds.setFromObject(selectedObj)
  }
  if (bounds.isEmpty()) {
    for (const child of current.scene.children) {
      if (child.userData.forgeImported) bounds.expandByObject(child)
    }
  }
  return bounds
}

function initVolumeBounds(current: ViewportRuntime, selectedId: string) {
  const bounds = computeTargetBounds(current, selectedId)
  if (!bounds.isEmpty()) {
    const center = bounds.getCenter(new THREE.Vector3())
    const size = bounds.getSize(new THREE.Vector3())
    current.volumeProxy.position.copy(center)
    current.volumeProxy.scale.set(
      Math.max(size.x * 0.6, 0.25),
      Math.max(size.y * 0.6, 0.25),
      Math.max(size.z * 0.6, 0.25),
    )
  } else {
    current.volumeProxy.position.set(0, 0.75, 0)
    current.volumeProxy.scale.set(1.2, 1.2, 1.2)
  }
  current.volumeInitialized = true
  syncVolumeVisuals(current)
}

function refreshVolumeSelection(current: ViewportRuntime, selectedId: string, rebuildHighlight = true): VolumeSelectionState {
  syncVolumeVisuals(current)
  current.scene.updateMatrixWorld(true)
  const meshIds = selectMeshesInBox(current.objects, current.volumeBox)
  const trianglesByMesh = new Map<string, number[]>()
  let triangleCount = 0

  for (const id of meshIds) {
    const mesh = current.objects.get(id) as THREE.Mesh | undefined
    if (!mesh?.isMesh) continue
    let tris = selectTrianglesInBox(mesh, current.volumeBox, 'centroid')
    if (tris.length === 0) {
      tris = selectTrianglesInBox(mesh, current.volumeBox, 'intersects')
    }
    if (tris.length > 0) {
      trianglesByMesh.set(id, tris)
      triangleCount += tris.length
    }
  }

  const primaryMeshId = selectedId && meshIds.includes(selectedId) ? selectedId : (meshIds[0] ?? null)
  current.volumeSelection = { meshIds, trianglesByMesh, triangleCount, primaryMeshId }

  if (rebuildHighlight) {
    const prevGeo = current.volumeHighlightMesh.geometry
    const nextGeo = new THREE.BufferGeometry()
    if (triangleCount > 0) {
      const positions = new Float32Array(triangleCount * 9)
      let offset = 0
      const vertex = new THREE.Vector3()
      for (const [id, tris] of trianglesByMesh) {
        const mesh = current.objects.get(id) as THREE.Mesh | undefined
        const posAttr = mesh?.geometry?.getAttribute('position')
        if (!mesh || !posAttr) continue
        const skinned = mesh as THREE.SkinnedMesh
        const index = mesh.geometry.getIndex()
        for (const t of tris) {
          for (let c = 0; c < 3; c++) {
            const vi = index ? index.getX(t * 3 + c) : t * 3 + c
            vertex.fromBufferAttribute(posAttr, vi)
            if (skinned.isSkinnedMesh && typeof skinned.applyBoneTransform === 'function' && skinned.skeleton) {
              try { skinned.applyBoneTransform(vi, vertex) } catch { /* ignore */ }
            }
            vertex.applyMatrix4(mesh.matrixWorld)
            positions[offset++] = vertex.x
            positions[offset++] = vertex.y
            positions[offset++] = vertex.z
          }
        }
      }
      nextGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      nextGeo.computeVertexNormals()
      nextGeo.computeBoundingSphere()
    } else {
      nextGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3))
      nextGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3))
    }
    current.volumeHighlightMesh.geometry = nextGeo
    prevGeo.dispose()
    current.volumeHighlightMesh.visible = current.volumeActive && triangleCount > 0
  }

  return current.volumeSelection
}

function resetViewportSelectionAndHelpers(current: ViewportRuntime) {
  current.transform.detach()
  current.dragStart = null
  current.lastHit = null
  current.selectionHelper.visible = false
  current.selectionHelper.box.makeEmpty()
  for (const helper of current.selectionHelpers.values()) {
    current.scene.remove(helper)
    helper.geometry.dispose()
    const materials = Array.isArray(helper.material) ? helper.material : [helper.material]
    materials.forEach((material) => material.dispose())
  }
  current.selectionHelpers.clear()
  current.selectionProxy.position.set(0, 0, 0)
  current.selectionProxy.rotation.set(0, 0, 0)
  current.selectionProxy.scale.set(1, 1, 1)
  for (const [material, original] of current.wireframeMaterials) {
    const wireMaterial = material as THREE.Material & { wireframe?: boolean }
    if ('wireframe' in wireMaterial) wireMaterial.wireframe = original ?? false
  }
  current.wireframeMaterials.clear()
  current.volumeInitialized = false
  current.volumeBox.makeEmpty()
  current.volumeSelection = { meshIds: [], trianglesByMesh: new Map(), triangleCount: 0, primaryMeshId: null }
  const prevHighlightGeo = current.volumeHighlightMesh.geometry
  current.volumeHighlightMesh.geometry = new THREE.BufferGeometry()
  prevHighlightGeo.dispose()
  current.volumeHighlightMesh.visible = false
  current.volumeHelper.visible = false
  current.volumeFillMesh.visible = false
}

const SceneViewport = forwardRef<ViewportApi, Props>(function SceneViewport({ selectedId, selectedIds, activeTool, boxSelect, onSelect, onSelectMany, onNodesChange, onRendererChange, onRendererError, onTransformChange, onTransformCommit }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const activeToolRef = useRef(activeTool)
  activeToolRef.current = activeTool
  const prevActiveToolRef = useRef(activeTool)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds
  const boxSelectRef = useRef(boxSelect)
  boxSelectRef.current = boxSelect
  const runtime = useRef<ViewportRuntime | null>(null)

  useImperativeHandle(ref, () => ({
    async loadModel(file, assetKey, resources = [file], resourcePaths = [], append = false) {
      const current = runtime.current
      if (!current) throw new Error('The 3D viewport is still starting')
      const sourceFiles = resources.includes(file) ? resources : [file, ...resources]
      const urls = sourceFiles.map((resource) => URL.createObjectURL(resource))
      const fileUrl = urls[sourceFiles.indexOf(file)]
      try {
        const resourcesByName = new Map<string, string>()
        const basenameCounts = new Map<string, number>()
        sourceFiles.forEach((resource) => basenameCounts.set(resource.name.toLowerCase(), (basenameCounts.get(resource.name.toLowerCase()) ?? 0) + 1))
        sourceFiles.forEach((resource, index) => {
          const path = resourcePaths[index] || resource.webkitRelativePath || resource.name
          resourcesByName.set(path.replaceAll('\\', '/').toLowerCase(), urls[index])
          if ((basenameCounts.get(resource.name.toLowerCase()) ?? 0) === 1) resourcesByName.set(resource.name.toLowerCase(), urls[index])
        })
        const manager = new THREE.LoadingManager()
        manager.setURLModifier((url) => {
          let decoded = url
          try { decoded = decodeURIComponent(url) } catch { /* Keep the original URL when decoding fails. */ }
          const normalized = decoded.split(/[?#]/, 1)[0].replaceAll('\\', '/').toLowerCase()
          const match = [...resourcesByName].find(([name]) => normalized === name || normalized.endsWith(`/${name}`))
          return match?.[1] ?? url
        })
        const loader = new GLTFLoader(manager)
        const dracoLoader = new DRACOLoader(manager)
        dracoLoader.setDecoderPath('./draco/')
        loader.setDRACOLoader(dracoLoader)
        const ktx2Loader = new KTX2Loader(manager)
        ktx2Loader.setTranscoderPath('./basis/')
        try {
          ktx2Loader.detectSupport(current.renderer)
        } catch {
          // Ignore KTX2 GPU capability detection fallback if renderer is still warming up
        }
        loader.setKTX2Loader(ktx2Loader)
        loader.setMeshoptDecoder(MeshoptDecoder)
        const gltf = await loader.loadAsync(fileUrl)
        dracoLoader.dispose()
        ktx2Loader.dispose()
        const root = gltf.scene
        let key = assetKey ?? `model-${file.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`
        if (append) {
          let suffix = 1
          while (current.objects.has(`${key}:root`)) {
            key = `${assetKey ?? 'model'}-${suffix++}`
          }
        } else {
          resetViewportSelectionAndHelpers(current)
          current.dissolves.clear()
          current.pivots.clear()
          current.scene.children.filter((child) => child.userData.forgeImported).forEach((child) => {
            current.scene.remove(child)
            child.traverse((item) => {
              const id = item.userData.forgeId
              if (id) current.objects.delete(id)
            })
            disposeObjectTree(child)
          })
        }
        const rootId = `${key}:root`
        root.userData.forgeId = rootId
        root.userData.forgeImported = true
        root.name ||= file.name.replace(/\.(glb|gltf)$/i, '')
        current.scene.add(root)
        root.position.set(0, 0, 0)
        const nodes: SceneNode[] = [{ id: rootId, name: root.name, type: 'imported', visible: true, parent: null }]
        const register = (object: THREE.Object3D, parentId: string, path: number[]) => {
          object.userData.forgeId = `${key}:${path.join('.')}`
          current.objects.set(object.userData.forgeId, object)
          if (object !== root) nodes.push({ id: object.userData.forgeId, name: object.name || object.type, type: (object as THREE.Mesh).isMesh ? 'Mesh' : object.type, visible: object.visible, parent: parentId })
          object.children.forEach((child, index) => register(child, object.userData.forgeId, [...path, index]))
        }
        current.objects.set(rootId, root)
        root.children.forEach((child, index) => register(child, rootId, [index]))
        const bounds = new THREE.Box3().setFromObject(root)
        if (!bounds.isEmpty()) {
          const size = bounds.getSize(new THREE.Vector3())
          const extent = Math.max(size.x, size.y, size.z)
          const aspectFlatness = extent / Math.max(0.0001, Math.min(size.x, size.y, size.z))
          const isLargeWorldOrTerrain = !append && (nodes.length > 150 || aspectFlatness > 6)
          const targetExtent = append ? 1.5 : (isLargeWorldOrTerrain ? 16 : 2.8)
          if (extent > 0) root.scale.multiplyScalar(targetExtent / extent)
          root.updateMatrixWorld(true)
          const normalizedBounds = new THREE.Box3().setFromObject(root)
          const center = normalizedBounds.getCenter(new THREE.Vector3())
          const ground = normalizedBounds.min.y
          const existingRoots = current.scene.children.filter((child) => child.userData.forgeImported && child !== root)
          const offsetX = append ? existingRoots.length * 1.8 : 0
          root.position.x -= center.x - offsetX
          root.position.y -= ground
          root.position.z -= center.z
          root.updateMatrixWorld(true)
          if (!append) {
            const framedBounds = new THREE.Box3().setFromObject(root)
            const framedSize = framedBounds.getSize(new THREE.Vector3())
            const target = framedBounds.getCenter(new THREE.Vector3())
            current.controls.target.copy(target)
            const radius = Math.max(framedSize.length() * 0.5, 0.5)
            const distance = radius / Math.sin(THREE.MathUtils.degToRad(current.camera.fov * 0.5)) * (isLargeWorldOrTerrain ? 0.55 : 1.15)
            const direction = current.camera.position.clone().sub(current.controls.target).normalize()
            current.camera.position.copy(target).addScaledVector(direction, distance)
            current.controls.minDistance = 0.05
            current.controls.maxDistance = Math.max(120, radius * 8)
            current.controls.update()
          }
        }
        if (!append) current.initialTransforms.clear()
        for (const [id, object] of current.objects) if (object.userData.forgeImported || object.userData.forgeId?.startsWith(`${key}:`)) current.initialTransforms.set(id, readTransform(object))
        if (!append) {
          current.asset = { files: sourceFiles, resourcePaths: sourceFiles.map((resource, index) => resourcePaths[index] || resource.webkitRelativePath || resource.name), assetKey: key }
        }
        current.nodes = append ? [...current.nodes, ...nodes] : nodes
        if (current.skeletonHelper) {
          current.scene.remove(current.skeletonHelper)
          current.skeletonHelper.dispose()
          current.skeletonHelper = null
        }
        const hasBones = nodes.some((n) => n.type === 'Bone')
        if (hasBones) {
          const skelHelper = new THREE.SkeletonHelper(root)
          skelHelper.visible = false
          skelHelper.userData.forgeEditorHelper = true
          current.scene.add(skelHelper)
          current.skeletonHelper = skelHelper
        }
        current.mixer?.stopAllAction()
        current.mixer = gltf.animations?.length ? new THREE.AnimationMixer(root) : null
        current.clips = gltf.animations ?? []
        current.activeClipName = null
        if (current.volumeActive) {
          initVolumeBounds(current, selectedIdRef.current)
          current.volumeHelper.visible = true
          current.volumeFillMesh.visible = true
          current.transform.attach(current.volumeProxy)
          current.transform.setMode(current.volumeMode)
          current.transform.enabled = true
          refreshVolumeSelection(current, selectedIdRef.current, true)
        }
        onNodesChange(nodes)
        return nodes
      } finally { urls.forEach((url) => URL.revokeObjectURL(url)) }
    },
    clearImported() {
      const current = runtime.current
      if (!current) return
      resetViewportSelectionAndHelpers(current)
      current.dissolves.clear()
      current.pivots.clear()
      current.nodes = []
      current.initialTransforms.clear()
      current.asset = null
      current.controls.target.set(0, 0, 0)
      current.camera.position.set(4.6, 3.6, 6.8)
      current.controls.update()
      current.scene.children.filter((child) => child.userData.forgeImported).forEach((child) => {
        current.scene.remove(child)
        child.traverse((item) => {
          const id = item.userData.forgeId
          if (id) current.objects.delete(id)
        })
        disposeObjectTree(child)
      })
    },
    getTransform(id) {
      const object = runtime.current?.objects.get(id)
      return object ? readTransform(object) : null
    },
    getTransforms() {
      const result: Record<string, ObjectTransform> = {}
      for (const [id, object] of runtime.current?.objects ?? []) result[id] = readTransform(object)
      return result
    },
    setTransform(id, value) {
      const object = runtime.current?.objects.get(id)
      if (!object) return
      object.position.set(...value.position)
      object.rotation.set(...value.rotation)
      object.scale.set(...value.scale)
    },
    setVisible(id, visible) { const object = runtime.current?.objects.get(id); if (object) object.visible = visible },
    getNodes() {
      const current = runtime.current
      if (!current) return null
      return readImportedNodes(current)
    },
    getProjectSnapshot() {
      const current = runtime.current
      if (!current) return null
      const nodes = readImportedNodes(current)
      return { nodes, files: current.asset?.files ?? [], resourcePaths: current.asset?.resourcePaths ?? [], assetKey: current.asset?.assetKey ?? '' }
    },
    frameObject(id) {
      const current = runtime.current
      const object = current?.objects.get(id)
      if (!current || !object) return
      const bounds = new THREE.Box3().setFromObject(object)
      if (bounds.isEmpty()) return
      const size = bounds.getSize(new THREE.Vector3())
      const center = bounds.getCenter(new THREE.Vector3())
      const radius = Math.max(size.length() * 0.5, 0.5)
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(current.camera.fov * 0.5)) * 1.2
      const direction = current.camera.position.clone().sub(current.controls.target).normalize()
      current.controls.target.copy(center)
      current.camera.position.copy(center).addScaledVector(direction, distance)
      current.controls.update()
    },
    resetTransform(id) {
      const current = runtime.current
      const object = current?.objects.get(id)
      if (current) current.initialTransforms ??= new Map()
      const initial = current?.initialTransforms.get(id)
      if (!object || !initial) return
      current?.pivots.reset(id)
      object.position.set(...initial.position)
      object.rotation.set(...initial.rotation)
      object.scale.set(...initial.scale)
    },
    getObjectStats(id) {
      const object = runtime.current?.objects.get(id)
      if (!object) return null
      let meshCount = 0
      let vertexCount = 0
      let triangleCount = 0
      const materials = new Set<THREE.Material>()
      object.traverse((child) => {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh || !mesh.geometry) return
        meshCount++
        const position = mesh.geometry.getAttribute('position')
        const elementCount = mesh.geometry.index?.count ?? position?.count ?? 0
        vertexCount += position?.count ?? 0
        triangleCount += Math.floor(elementCount / 3) * ((mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1)
        for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) materials.add(material)
      })
      const bounds = new THREE.Box3().setFromObject(object)
      const size = bounds.isEmpty() ? new THREE.Vector3() : bounds.getSize(new THREE.Vector3())
      return { meshCount, vertexCount, triangleCount, materialCount: materials.size, dimensions: [size.x, size.y, size.z] }
    },
    setWireframe(enabled) {
      const current = runtime.current
      if (!current) return
      if (enabled) {
        for (const root of current.scene.children.filter((child) => child.userData.forgeImported)) root.traverse((child) => {
          const mesh = child as THREE.Mesh
          for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
            const wireMaterial = material as THREE.Material & { wireframe?: boolean }
            if (!current.wireframeMaterials.has(material)) current.wireframeMaterials.set(material, wireMaterial.wireframe)
            if ('wireframe' in wireMaterial) wireMaterial.wireframe = true
          }
        })
      } else {
        for (const [material, original] of current.wireframeMaterials) {
          const wireMaterial = material as THREE.Material & { wireframe?: boolean }
          if ('wireframe' in wireMaterial) wireMaterial.wireframe = original ?? false
        }
        current.wireframeMaterials.clear()
      }
    },
    setEffects(effects, time) {
      const current = runtime.current
      if (current) current.dissolves.update(current.objects, effects, time)
    },
    getPivot(id) { return runtime.current?.pivots.get(id) ?? [0, 0, 0] },
    getPivots() { return runtime.current?.pivots.snapshot() ?? {} },
    setPivot(id, pivot, preservePose = true) {
      const current = runtime.current
      const object = current?.objects.get(id)
      if (!current || !object || !current.pivots.apply(id, object, pivot, preservePose)) return false
      return true
    },
    setPivotFromLastHit(id) {
      const current = runtime.current
      const hit = current?.lastHit
      if (!current || !hit || hit.id !== id) return null
      const existing = current.pivots.get(id)
      const pivot: PivotPoint = [hit.point[0] + existing[0], hit.point[1] + existing[1], hit.point[2] + existing[2]]
      const object = current.objects.get(id)
      if (!object || !current.pivots.apply(id, object, pivot, true)) return null
      return pivot
    },
    splitSelectedMesh(id, mode) {
      const current = runtime.current
      const object = current?.objects.get(id) as THREE.Mesh | undefined
      if (!current || !object?.isMesh) return null
      const result = mode === 'islands' ? splitMeshByConnectedIslands(object) : splitMeshByMaterialGroups(object)
      if (!result.parts.length) return null

      const parent = object.parent ?? current.scene
      const group = new THREE.Group()
      group.name = object.name || 'SplitGroup'
      group.userData.forgeId = id
      group.position.copy(object.position)
      group.rotation.copy(object.rotation)
      group.scale.copy(object.scale)

      parent.add(group)
      parent.remove(object)
      current.objects.set(id, group)
      current.initialTransforms.set(id, readTransform(group))

      const newNodes: SceneNode[] = []
      for (const part of result.parts) {
        const partId = part.userData.forgeId as string
        group.add(part)
        current.objects.set(partId, part)
        current.initialTransforms.set(partId, readTransform(part))
        newNodes.push({ id: partId, name: part.name, type: 'Mesh', visible: part.visible, parent: id })
      }

      const updatedNodes = current.nodes.map((node) => (node.id === id ? { ...node, type: 'Group' } : node))
      current.nodes = [...updatedNodes, ...newNodes]
      onNodesChange(current.nodes)
      if (newNodes[0]) onSelectMany([newNodes[0].id], false)
      return current.nodes
    },
    applyEnvironmentPreset(presetId) {
      const current = runtime.current
      const preset = ENVIRONMENT_PRESETS[presetId]
      if (!current || !preset) return
      current.scene.background = new THREE.Color(preset.manifest.background)
      current.scene.fog = preset.manifest.fog ? new THREE.Fog(preset.manifest.fog.color, preset.manifest.fog.near, preset.manifest.fog.far) : null
      const lightsGroup = current.objects.get('lights')
      if (lightsGroup) {
        while (lightsGroup.children.length) lightsGroup.remove(lightsGroup.children[0])
        for (const lightDef of preset.manifest.lights) {
          if (lightDef.type === 'hemisphere') {
            lightsGroup.add(new THREE.HemisphereLight(lightDef.color, lightDef.groundColor ?? '#222', lightDef.intensity))
          } else if (lightDef.type === 'directional') {
            const dir = new THREE.DirectionalLight(lightDef.color, lightDef.intensity)
            if (lightDef.position) dir.position.set(...lightDef.position)
            lightsGroup.add(dir)
          } else if (lightDef.type === 'ambient') {
            lightsGroup.add(new THREE.AmbientLight(lightDef.color, lightDef.intensity))
          } else if (lightDef.type === 'point') {
            const pt = new THREE.PointLight(lightDef.color, lightDef.intensity)
            if (lightDef.position) pt.position.set(...lightDef.position)
            lightsGroup.add(pt)
          }
        }
      }
    },
    getCameraPose() {
      const current = runtime.current
      if (!current) return null
      return {
        position: tuple(current.camera.position),
        target: tuple(current.controls.target),
        fov: current.camera.fov,
      }
    },
    setVolumeBoxMode(mode) {
      const current = runtime.current
      if (!current) return
      current.volumeMode = mode
      current.volumeActive = true
      if (!current.volumeInitialized) initVolumeBounds(current, selectedIdRef.current)
      current.volumeHelper.visible = true
      current.volumeFillMesh.visible = true
      current.transform.attach(current.volumeProxy)
      current.transform.setMode(mode)
      current.transform.enabled = true
      current.controls.enabled = !current.transform.dragging
      refreshVolumeSelection(current, selectedIdRef.current, true)
    },
    getVolumeSelection() {
      const current = runtime.current
      if (!current) return { meshIds: [], triangleCount: 0, primaryMeshId: null }
      const selection = refreshVolumeSelection(current, selectedIdRef.current, current.volumeActive)
      return {
        meshIds: [...selection.meshIds],
        triangleCount: selection.triangleCount,
        primaryMeshId: selection.primaryMeshId,
      }
    },
    extractBoxSelection() {
      const current = runtime.current
      if (!current) return null
      syncVolumeVisuals(current)
      current.scene.updateMatrixWorld(true)
      const meshIds = selectMeshesInBox(current.objects, current.volumeBox)
      const extractedIds: string[] = []
      const modifiedSourceIds: string[] = []
      const newNodes: SceneNode[] = []
      let extractedCount = 0

      for (const sourceId of meshIds) {
        const sourceObj = current.objects.get(sourceId) as THREE.Mesh | undefined
        if (!sourceObj?.isMesh) continue
        if (current.pivots.get(sourceId).some((value) => Math.abs(value) > 1e-8)) {
          current.pivots.apply(sourceId, sourceObj, [0, 0, 0], true)
          sourceObj.updateWorldMatrix(true, false)
        }
        let triIndices = selectTrianglesInBox(sourceObj, current.volumeBox, 'centroid')
        if (triIndices.length === 0) {
          triIndices = selectTrianglesInBox(sourceObj, current.volumeBox, 'intersects')
        }
        if (triIndices.length === 0) continue

        const isSkinned = Boolean((sourceObj as THREE.SkinnedMesh).isSkinnedMesh)
        let workingMesh: THREE.Mesh = sourceObj
        if (isSkinned) {
          const skinned = sourceObj as THREE.SkinnedMesh
          skinned.updateMatrixWorld(true)
          if (skinned.skeleton) skinned.skeleton.update()
          const bakedGeo = skinned.geometry.clone()
          const posAttr = bakedGeo.getAttribute('position')
          if (posAttr) {
            const v = new THREE.Vector3()
            for (let i = 0; i < posAttr.count; i++) {
              v.fromBufferAttribute(posAttr, i)
              if (typeof skinned.applyBoneTransform === 'function' && skinned.skeleton) {
                try { skinned.applyBoneTransform(i, v) } catch { /* ignore */ }
              }
              posAttr.setXYZ(i, v.x, v.y, v.z)
            }
            posAttr.needsUpdate = true
            bakedGeo.computeBoundingBox()
            bakedGeo.computeBoundingSphere()
          }
          const clonedMaterial = Array.isArray(skinned.material)
            ? skinned.material.map((m) => (m && typeof m.clone === 'function' ? m.clone() : m))
            : skinned.material && typeof skinned.material.clone === 'function'
              ? skinned.material.clone()
              : skinned.material
          workingMesh = new THREE.Mesh(bakedGeo, clonedMaterial)
          workingMesh.name = skinned.name
          workingMesh.position.copy(skinned.position)
          workingMesh.rotation.copy(skinned.rotation)
          workingMesh.quaternion.copy(skinned.quaternion)
          workingMesh.scale.copy(skinned.scale)
          workingMesh.matrix.copy(skinned.matrix)
          workingMesh.matrixWorld.copy(skinned.matrixWorld)
          workingMesh.userData = { ...skinned.userData }
        }

        let idx = 1
        while (current.objects.has(`${sourceId}:extract-${idx}`)) idx++
        const partId = `${sourceId}:extract-${idx}`

        const extracted =
          sliceMeshWithBox(workingMesh, current.volumeBox, {
            name: `${sourceObj.name || 'Part'}_extract_${idx}`,
            forgeId: partId,
          }) ??
          extractTrianglesAsPart(workingMesh, triIndices, {
            name: `${sourceObj.name || 'Part'}_extract_${idx}`,
            forgeId: partId,
          })
        if (!extracted) continue

        if (isSkinned) {
          const origExtracted =
            sliceMeshWithBox(sourceObj, current.volumeBox, {
              name: `${sourceObj.name || 'Part'}_extract_${idx}`,
              forgeId: partId,
            }) ??
            extractTrianglesAsPart(sourceObj, triIndices, {
              name: `${sourceObj.name || 'Part'}_extract_${idx}`,
              forgeId: partId,
            })
          if (origExtracted) {
            sourceObj.geometry = origExtracted.remainingGeometry
          }
        } else {
          sourceObj.geometry = extracted.remainingGeometry
        }
        if (extracted.remainingCount === 0) {
          sourceObj.visible = false
        }
        const parent = sourceObj.parent ?? current.scene
        parent.add(extracted.part)
        current.objects.set(partId, extracted.part)
        current.initialTransforms.set(partId, readTransform(extracted.part))

        const sourceNode = current.nodes.find((node) => node.id === sourceId)
        newNodes.push({
          id: partId,
          name: extracted.part.name,
          type: 'Mesh',
          visible: extracted.part.visible,
          parent: sourceNode?.parent ?? null,
        })

        extractedIds.push(partId)
        modifiedSourceIds.push(sourceId)
        extractedCount += extracted.removedCount
      }

      if (extractedIds.length === 0) return null

      current.nodes = [...current.nodes, ...newNodes]
      onNodesChange(current.nodes)
      onSelectMany(extractedIds, false)
      refreshVolumeSelection(current, extractedIds[0], true)

      return { extractedIds, modifiedSourceIds, extractedCount }
    },
    captureSceneSnapshot(includeGeometry = false) {
      const current = runtime.current
      if (!current) return null
      const transforms: Record<string, ObjectTransform> = {}
      const visibility: Record<string, boolean> = {}
      const geometrySnapshot: Record<string, THREE.BufferGeometry> = {}
      const shouldCloneGeo = includeGeometry || current.objects.size <= 150
      for (const [id, obj] of current.objects) {
        transforms[id] = readTransform(obj)
        visibility[id] = obj.visible
        if (shouldCloneGeo && (obj as THREE.Mesh).isMesh && (obj as THREE.Mesh).geometry) {
          geometrySnapshot[id] = (obj as THREE.Mesh).geometry.clone()
        }
      }
      return {
        nodes: current.nodes.map((n) => ({ ...n })),
        transforms,
        visibility,
        pivots: current.pivots.snapshot(),
        geometrySnapshot,
      }
    },
    restoreSceneSnapshot(snapshot) {
      const current = runtime.current
      if (!current) return
      const validIds = new Set(snapshot.nodes.map((n) => n.id))
      for (const [id, obj] of [...current.objects.entries()]) {
        if (id !== 'lights' && !id.endsWith(':root') && !validIds.has(id)) {
          obj.parent?.remove(obj)
          current.objects.delete(id)
        }
      }
      if (snapshot.geometrySnapshot) {
        for (const [id, geo] of Object.entries(snapshot.geometrySnapshot)) {
          const obj = current.objects.get(id) as THREE.Mesh | undefined
          if (obj?.isMesh && geo instanceof THREE.BufferGeometry) {
            obj.geometry = geo.clone()
          }
        }
      }
      for (const [id, t] of Object.entries(snapshot.transforms)) {
        const obj = current.objects.get(id)
        if (obj) {
          obj.position.set(...t.position)
          obj.rotation.set(...t.rotation)
          obj.scale.set(...t.scale)
        }
      }
      for (const [id, vis] of Object.entries(snapshot.visibility)) {
        const obj = current.objects.get(id)
        if (obj) obj.visible = vis
      }
      for (const [id, piv] of Object.entries(snapshot.pivots)) {
        const obj = current.objects.get(id)
        if (obj) current.pivots.apply(id, obj, piv, false)
      }
      current.nodes = snapshot.nodes.map((n) => ({ ...n }))
      onNodesChange(current.nodes)
    },
    addSceneCamera(name) {
      const current = runtime.current
      if (!current) return null
      let idx = 1
      while (current.objects.has(`camera:${idx}`)) idx++
      const camId = `camera:${idx}`
      const camName = name || `Camera_${idx}`

      const camGroup = new THREE.Group()
      camGroup.name = camName
      camGroup.userData.forgeId = camId
      camGroup.userData.forgeCamera = true
      camGroup.position.copy(current.camera.position)
      camGroup.quaternion.copy(current.camera.quaternion)

      const bodyGeo = new THREE.BoxGeometry(0.32, 0.22, 0.42)
      const lensGeo = new THREE.ConeGeometry(0.18, 0.28, 4)
      lensGeo.rotateX(Math.PI / 2)
      lensGeo.translate(0, 0, -0.32)
      const camMat = new THREE.MeshBasicMaterial({ color: '#b7f36b', wireframe: true })
      const bodyMesh = new THREE.Mesh(bodyGeo, camMat)
      const lensMesh = new THREE.Mesh(lensGeo, camMat)
      bodyMesh.userData.forgeId = camId
      lensMesh.userData.forgeId = camId
      camGroup.add(bodyMesh, lensMesh)

      current.scene.add(camGroup)
      current.objects.set(camId, camGroup)
      current.initialTransforms.set(camId, readTransform(camGroup))
      const newNode: SceneNode = { id: camId, name: camName, type: 'Camera', visible: true, parent: null }
      current.nodes = [...current.nodes, newNode]
      onNodesChange(current.nodes)
      onSelectMany([camId], false)
      return newNode
    },
    setActivePovCamera(id) {
      const current = runtime.current
      if (!current) return
      if (!id) return
      const camObj = current.objects.get(id)
      if (!camObj) return
      camObj.updateWorldMatrix(true, false)
      const worldPos = new THREE.Vector3()
      const worldQuat = new THREE.Quaternion()
      camObj.getWorldPosition(worldPos)
      camObj.getWorldQuaternion(worldQuat)
      current.camera.position.copy(worldPos)
      const forward = new THREE.Vector3(0, 0, -4).applyQuaternion(worldQuat)
      current.controls.target.copy(worldPos).add(forward)
      current.controls.update()
    },
    applyVolumePreset(preset) {
      const current = runtime.current
      if (!current) return
      const bounds = computeTargetBounds(current, selectedIdRef.current)
      if (bounds.isEmpty()) return
      const center = bounds.getCenter(new THREE.Vector3())
      const size = bounds.getSize(new THREE.Vector3())
      const sx = Math.max(0.25, size.x * 1.08)
      const sy = Math.max(0.25, size.y * 1.08)
      const sz = Math.max(0.25, size.z * 1.08)

      if (preset === 'top') {
        current.volumeProxy.position.set(center.x, center.y + size.y * 0.26, center.z)
        current.volumeProxy.scale.set(sx, Math.max(0.2, size.y * 0.52), sz)
      } else if (preset === 'bottom') {
        current.volumeProxy.position.set(center.x, center.y - size.y * 0.26, center.z)
        current.volumeProxy.scale.set(sx, Math.max(0.2, size.y * 0.52), sz)
      } else if (preset === 'left') {
        current.volumeProxy.position.set(center.x - size.x * 0.26, center.y, center.z)
        current.volumeProxy.scale.set(Math.max(0.2, size.x * 0.52), sy, sz)
      } else if (preset === 'right') {
        current.volumeProxy.position.set(center.x + size.x * 0.26, center.y, center.z)
        current.volumeProxy.scale.set(Math.max(0.2, size.x * 0.52), sy, sz)
      } else if (preset === 'center') {
        current.volumeProxy.position.copy(center)
        current.volumeProxy.scale.set(Math.max(0.2, size.x * 0.45), Math.max(0.2, size.y * 0.45), Math.max(0.2, size.z * 0.45))
      } else if (preset === 'lastHit' && current.lastHit) {
        const hitObj = current.objects.get(current.lastHit.id)
        if (hitObj) {
          const worldPt = new THREE.Vector3(...current.lastHit.point).applyMatrix4(hitObj.matrixWorld)
          current.volumeProxy.position.copy(worldPt)
          current.volumeProxy.scale.set(Math.max(0.2, size.x * 0.42), Math.max(0.2, size.y * 0.35), Math.max(0.2, size.z * 0.42))
        }
      }
      current.volumeInitialized = true
      current.volumeActive = true
      current.volumeHelper.visible = true
      current.volumeFillMesh.visible = true
      current.transform.attach(current.volumeProxy)
      current.transform.setMode(current.volumeMode)
      current.transform.enabled = true
      refreshVolumeSelection(current, selectedIdRef.current, true)
    },
    smoothSelectedMesh(id) {
      const current = runtime.current
      if (!current) return 0
      const targetIds = selectedIdsRef.current.length > 1 ? selectedIdsRef.current : [id]
      let totalSmoothed = 0
      for (const tid of targetIds) {
        const obj = current.objects.get(tid) as THREE.Mesh | undefined
        if (obj?.isMesh) {
          totalSmoothed += smoothSpikyMeshEdges(obj, 3)
        }
      }
      return totalSmoothed
    },
    deleteSelectedObjects(ids) {
      const current = runtime.current
      if (!current || !ids.length) return null
      const toDelete = new Set<string>(ids)
      let added = true
      while (added) {
        added = false
        for (const n of current.nodes) {
          if (n.parent && toDelete.has(n.parent) && !toDelete.has(n.id)) {
            toDelete.add(n.id)
            added = true
          }
        }
      }
      for (const id of toDelete) {
        if (id === 'lights' || id.endsWith(':root')) continue
        const obj = current.objects.get(id)
        if (obj) {
          if (current.transform.object === obj) current.transform.detach()
          obj.parent?.remove(obj)
          current.objects.delete(id)
        }
      }
      current.nodes = current.nodes.filter((n) => n.id.endsWith(':root') || !toDelete.has(n.id))
      onNodesChange(current.nodes)
      onSelectMany([], false)
      return current.nodes
    },
    deleteBoxSelection() {
      const current = runtime.current
      if (!current) return null
      syncVolumeVisuals(current)
      current.scene.updateMatrixWorld(true)
      const meshIds = selectMeshesInBox(current.objects, current.volumeBox)
      const modifiedSourceIds: string[] = []
      let deletedCount = 0

      for (const sourceId of meshIds) {
        const sourceObj = current.objects.get(sourceId) as THREE.Mesh | undefined
        if (!sourceObj?.isMesh) continue
        let triIndices = selectTrianglesInBox(sourceObj, current.volumeBox, 'centroid')
        if (triIndices.length === 0) {
          triIndices = selectTrianglesInBox(sourceObj, current.volumeBox, 'intersects')
        }
        if (triIndices.length === 0) continue

        const sliced =
          sliceMeshWithBox(sourceObj, current.volumeBox) ??
          extractTrianglesAsPart(sourceObj, triIndices)
        if (!sliced) continue

        sourceObj.geometry = sliced.remainingGeometry
        sliced.part.geometry.dispose()
        if (sliced.remainingCount === 0) {
          sourceObj.visible = false
        }
        modifiedSourceIds.push(sourceId)
        deletedCount += sliced.removedCount
      }

      if (deletedCount === 0) return null
      refreshVolumeSelection(current, selectedIdRef.current, true)
      return { modifiedSourceIds, deletedCount }
    },
    getAnimationClips() {
      const current = runtime.current
      if (!current) return []
      return current.clips.map((c) => ({ name: c.name || 'Clip', duration: Number(c.duration.toFixed(2)) }))
    },
    setActiveAnimationClip(name, time = 0) {
      const current = runtime.current
      if (!current || !current.mixer) return
      current.mixer.stopAllAction()
      current.activeClipName = name
      if (!name) return
      const clip = current.clips.find((c) => (c.name || 'Clip') === name)
      if (!clip) return
      const action = current.mixer.clipAction(clip)
      action.reset().play()
      current.mixer.setTime(time)
    },
    setSkeletonVisible(visible) {
      const current = runtime.current
      if (!current?.skeletonHelper) return
      current.skeletonHelper.visible = visible
    },
    setFreeformMode(mode) {
      const current = runtime.current
      if (!current) return
      current.freeformMode = mode
    },
    duplicateObject(id) {
      const current = runtime.current
      const source = current?.objects.get(id)
      if (!current || !source) return null
      let idx = 1
      while (current.objects.has(`${id}:copy-${idx}`)) idx++
      const cloneRootId = `${id}:copy-${idx}`

      source.updateWorldMatrix(true, true)
      const sourceBounds = new THREE.Box3().setFromObject(source)
      const worldSize = sourceBounds.isEmpty() ? new THREE.Vector3(1, 1, 1) : sourceBounds.getSize(new THREE.Vector3())
      const worldOffset = Math.max(0.75, worldSize.x * 1.25)

      let cloned: THREE.Object3D
      if ((source as THREE.SkinnedMesh).isSkinnedMesh) {
        const skinned = source as THREE.SkinnedMesh
        if (skinned.skeleton) skinned.skeleton.update()
        const bakedGeo = skinned.geometry.clone()
        const posAttr = bakedGeo.getAttribute('position')
        if (posAttr) {
          const v = new THREE.Vector3()
          for (let i = 0; i < posAttr.count; i++) {
            v.fromBufferAttribute(posAttr, i)
            if (typeof skinned.applyBoneTransform === 'function' && skinned.skeleton) {
              try { skinned.applyBoneTransform(i, v) } catch { /* ignore */ }
            }
            posAttr.setXYZ(i, v.x, v.y, v.z)
          }
          posAttr.needsUpdate = true
          bakedGeo.computeBoundingBox()
          bakedGeo.computeBoundingSphere()
        }
        const mat = Array.isArray(skinned.material) ? skinned.material.map((m) => m.clone()) : skinned.material.clone()
        cloned = new THREE.Mesh(bakedGeo, mat)
        cloned.position.copy(skinned.position)
        cloned.rotation.copy(skinned.rotation)
        cloned.quaternion.copy(skinned.quaternion)
        cloned.scale.copy(skinned.scale)
      } else {
        cloned = source.clone(true)
      }
      cloned.name = `${source.name || 'Object'}_copy_${idx}`

      const parent = source.parent ?? current.scene
      parent.add(cloned)
      parent.updateWorldMatrix(true, false)
      const worldPos = source.getWorldPosition(new THREE.Vector3())
      worldPos.x += worldOffset
      if (parent !== current.scene) {
        parent.worldToLocal(worldPos)
      }
      cloned.position.copy(worldPos)
      cloned.updateMatrixWorld(true)

      const newNodes: SceneNode[] = []
      const sourceNode = current.nodes.find((n) => n.id === id)
      const registerClone = (obj: THREE.Object3D, forgeId: string, parentId: string | null) => {
        obj.userData = { ...obj.userData, forgeId }
        const mesh = obj as THREE.Mesh
        if (mesh.isMesh && mesh.geometry && obj !== cloned) {
          mesh.geometry = mesh.geometry.clone()
        }
        current.objects.set(forgeId, obj)
        current.initialTransforms.set(forgeId, readTransform(obj))
        newNodes.push({
          id: forgeId,
          name: obj.name || obj.type,
          type: mesh.isMesh ? 'Mesh' : obj.type,
          visible: obj.visible,
          parent: parentId,
        })
        obj.children.forEach((child, childIdx) => {
          registerClone(child, `${forgeId}.${childIdx}`, forgeId)
        })
      }

      registerClone(cloned, cloneRootId, sourceNode?.parent ?? null)
      current.nodes = [...current.nodes, ...newNodes]
      onNodesChange(current.nodes)
      onSelectMany([cloneRootId], false)
      return current.nodes
    },
    snapObjectToGround(id) {
      const current = runtime.current
      const obj = current?.objects.get(id)
      if (!current || !obj) return null
      obj.updateWorldMatrix(true, true)
      const bounds = new THREE.Box3().setFromObject(obj)
      if (bounds.isEmpty()) return null
      const deltaY = -bounds.min.y
      if (obj.parent && obj.parent !== current.scene) {
        const worldPos = new THREE.Vector3()
        obj.getWorldPosition(worldPos)
        worldPos.y += deltaY
        obj.parent.worldToLocal(worldPos)
        obj.position.copy(worldPos)
      } else {
        obj.position.y += deltaY
      }
      obj.updateMatrixWorld(true)
      return readTransform(obj)
    },
    setParentObject(childId, newParentId) {
      const current = runtime.current
      const childObj = current?.objects.get(childId)
      if (!current || !childObj || childId === newParentId) return null
      const targetParent = newParentId ? current.objects.get(newParentId) : current.scene
      if (!targetParent) return null
      // Prevent circular parenting
      let cursor: THREE.Object3D | null = targetParent
      while (cursor) {
        if (cursor === childObj) return null
        cursor = cursor.parent
      }
      targetParent.attach(childObj)
      childObj.updateMatrixWorld(true)
      current.nodes = current.nodes.map((n) => (n.id === childId ? { ...n, parent: newParentId } : n))
      onNodesChange(current.nodes)
      return current.nodes
    },
    setQuickHingePivot(id, preset) {
      const current = runtime.current
      const obj = current?.objects.get(id) as THREE.Mesh | undefined
      if (!current || !obj?.isMesh || !obj.geometry) return null
      if (preset === 'center') {
        current.pivots.apply(id, obj, [0, 0, 0], true)
        return [0, 0, 0]
      }
      // First reset pivot to geometry center so bounds are measured cleanly
      current.pivots.apply(id, obj, [0, 0, 0], true)
      obj.geometry.computeBoundingBox()
      const bb = obj.geometry.boundingBox
      if (!bb) return null
      const c = bb.getCenter(new THREE.Vector3())
      let pivot: PivotPoint = [c.x, c.y, c.z]
      if (preset === 'top') pivot = [c.x, bb.max.y, c.z]
      else if (preset === 'bottom') pivot = [c.x, bb.min.y, c.z]
      else if (preset === 'left') pivot = [bb.min.x, c.y, c.z]
      else if (preset === 'right') pivot = [bb.max.x, c.y, c.z]
      if (!current.pivots.apply(id, obj, pivot, true)) return null
      return pivot
    },
    alignObjectToTarget(sourceId, targetId) {
      const current = runtime.current
      const sourceObj = current?.objects.get(sourceId)
      const targetObj = current?.objects.get(targetId)
      if (!current || !sourceObj || !targetObj || sourceId === targetId) return null
      targetObj.updateWorldMatrix(true, true)
      const targetBounds = new THREE.Box3().setFromObject(targetObj)
      const worldCenter = targetBounds.isEmpty()
        ? targetObj.getWorldPosition(new THREE.Vector3())
        : targetBounds.getCenter(new THREE.Vector3())
      if (sourceObj.parent && sourceObj.parent !== current.scene) {
        sourceObj.parent.updateWorldMatrix(true, false)
        sourceObj.parent.worldToLocal(worldCenter)
      }
      sourceObj.position.copy(worldCenter)
      sourceObj.updateMatrixWorld(true)
      return readTransform(sourceObj)
    },
    attachFpsCameraToNode(targetId) {
      const current = runtime.current
      const targetObj = current?.objects.get(targetId)
      if (!current || !targetObj) return null
      let idx = 1
      while (current.objects.has(`camera:fps-${idx}`)) idx++
      const camId = `camera:fps-${idx}`
      const camName = `FPS_POV_${idx}`

      const camGroup = new THREE.Group()
      camGroup.name = camName
      camGroup.userData.forgeId = camId
      camGroup.userData.forgeCamera = true

      targetObj.updateWorldMatrix(true, true)
      const bounds = new THREE.Box3().setFromObject(targetObj)
      const size = bounds.isEmpty() ? new THREE.Vector3(0.4, 0.4, 0.4) : bounds.getSize(new THREE.Vector3())
      camGroup.position.set(0, Math.max(0.15, size.y * 0.45), 0.12)

      const bodyGeo = new THREE.BoxGeometry(0.18, 0.12, 0.22)
      const lensGeo = new THREE.ConeGeometry(0.1, 0.16, 4)
      lensGeo.rotateX(Math.PI / 2)
      lensGeo.translate(0, 0, -0.18)
      const camMat = new THREE.MeshBasicMaterial({ color: '#78a6ff', wireframe: true })
      const bodyMesh = new THREE.Mesh(bodyGeo, camMat)
      const lensMesh = new THREE.Mesh(lensGeo, camMat)
      bodyMesh.userData.forgeId = camId
      lensMesh.userData.forgeId = camId
      camGroup.add(bodyMesh, lensMesh)

      targetObj.add(camGroup)
      camGroup.updateMatrixWorld(true)
      current.objects.set(camId, camGroup)
      current.initialTransforms.set(camId, readTransform(camGroup))
      const newNode: SceneNode = { id: camId, name: camName, type: 'Camera', visible: true, parent: targetId }
      current.nodes = [...current.nodes, newNode]
      onNodesChange(current.nodes)

      const worldPos = new THREE.Vector3()
      const worldQuat = new THREE.Quaternion()
      camGroup.getWorldPosition(worldPos)
      camGroup.getWorldQuaternion(worldQuat)
      current.camera.position.copy(worldPos)
      const forward = new THREE.Vector3(0, 0, -4).applyQuaternion(worldQuat)
      current.controls.target.copy(worldPos).add(forward)
      current.controls.update()
      onSelectMany([camId], false)
      return newNode
    },
    setMeshSurfacePreset(id, preset) {
      const current = runtime.current
      const obj = current?.objects.get(id) as THREE.Mesh | undefined
      if (!current || !obj?.isMesh || !obj.material) return false
      const applyToMat = (mat: THREE.Material) => {
        const m = mat.clone() as THREE.MeshStandardMaterial
        if (preset === 'mirror') {
          if ('metalness' in m) m.metalness = 1.0
          if ('roughness' in m) m.roughness = 0.02
          m.transparent = false
          m.opacity = 1.0
        } else if (preset === 'glass') {
          if ('metalness' in m) m.metalness = 0.1
          if ('roughness' in m) m.roughness = 0.08
          m.transparent = true
          m.opacity = 0.36
        } else {
          if ('metalness' in m) m.metalness = 0.2
          if ('roughness' in m) m.roughness = 0.65
          m.transparent = false
          m.opacity = 1.0
        }
        m.needsUpdate = true
        return m
      }
      obj.material = Array.isArray(obj.material) ? obj.material.map(applyToMat) : applyToMat(obj.material)
      return true
    },
    stepUniversalInputs(keys, toggledKeys, dt, bindings) {
      const current = runtime.current
      if (!current) return
      const gamepads = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : []
      const activePad = Array.from(gamepads ?? []).find((gp): gp is Gamepad => Boolean(gp && gp.connected)) ?? null
      const deadzone = (val: number) => (Math.abs(val) < 0.08 ? 0 : val)

      const readInputSignal = (input: string): { analog: number; active: boolean; toggled: boolean } => {
        const code = input.toLowerCase()
        if (code.startsWith('gp:axis:')) {
          const axisIdx = Number(code.replace('gp:axis:', ''))
          const raw = activePad && activePad.axes[axisIdx] !== undefined ? deadzone(activePad.axes[axisIdx]) : 0
          return { analog: raw, active: Math.abs(raw) > 0, toggled: raw > 0.5 }
        }
        if (code.startsWith('gp:btn:')) {
          const btnIdx = Number(code.replace('gp:btn:', ''))
          const btn = activePad?.buttons[btnIdx]
          const val = btn ? btn.value : 0
          return { analog: val, active: Boolean(btn?.pressed || val > 0.1), toggled: Boolean(btn?.pressed) }
        }
        const held = keys.has(code)
        const toggled = toggledKeys.has(code)
        return { analog: held ? 1 : 0, active: held, toggled }
      }

      for (const b of bindings) {
        const obj = current.objects.get(b.targetId)
        if (!obj) continue
        const signal = readInputSignal(b.input)
        const spd = b.speed || 1
        const ax = b.axis || 'y'

        if (b.action === 'translate' && signal.active) {
          const dir = new THREE.Vector3(ax === 'x' ? 1 : 0, ax === 'y' ? 1 : 0, ax === 'z' ? 1 : 0).applyQuaternion(obj.quaternion)
          obj.position.addScaledVector(dir, 2.5 * spd * signal.analog * dt)
          obj.updateMatrixWorld(true)
        } else if (b.action === 'rotate' && signal.active) {
          obj.rotation[ax] += 2.0 * spd * signal.analog * dt
          obj.updateMatrixWorld(true)
        } else if (b.action === 'spin' && signal.active) {
          obj.rotation[ax] += 4.5 * spd * signal.analog * dt
          obj.updateMatrixWorld(true)
        } else if (b.action === 'hinge') {
          const axisIndex = ax === 'x' ? 0 : ax === 'y' ? 1 : 2
          const baseRot = current.initialTransforms.get(b.targetId)?.rotation[axisIndex] ?? 0
          const targetRot = signal.toggled ? baseRot + Math.PI * 0.45 * spd : baseRot
          obj.rotation[ax] += (targetRot - obj.rotation[ax]) * Math.min(1, dt * 8)
          obj.updateMatrixWorld(true)
        } else if (b.action === 'cameraPov' && signal.toggled) {
          obj.updateWorldMatrix(true, false)
          const worldPos = obj.getWorldPosition(new THREE.Vector3())
          const worldQuat = obj.getWorldQuaternion(new THREE.Quaternion())
          current.camera.position.copy(worldPos)
          const forward = new THREE.Vector3(0, 0, -4).applyQuaternion(worldQuat)
          current.controls.target.copy(worldPos).add(forward)
          current.controls.update()
        }
      }
    },
  }), [onNodesChange, onSelectMany])

  useEffect(() => {
    const element = host.current
    if (!element) return
    let disposed = false
    let rendererInitialized = false
    let resizeObserver: ResizeObserver | undefined
    let renderer: THREE.WebGPURenderer | undefined
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#111317')
    scene.fog = new THREE.Fog('#111317', 12, 32)
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
    camera.position.set(4.6, 3.6, 6.8)
    const objects = new Map<string, THREE.Object3D>()
    const dissolves = createDissolveController()
    const pivots = createPivotController()
    const selectionHelper = new THREE.Box3Helper(new THREE.Box3(), '#b7f36b')
    selectionHelper.visible = false
    selectionHelper.userData.forgeEditorHelper = true
    scene.add(selectionHelper)
    const selectionHelpers = new Map<string, THREE.Box3Helper>()
    const selectionProxy = new THREE.Group()
    selectionProxy.name = 'Forge selection transform'
    selectionProxy.userData.forgeEditorHelper = true
    scene.add(selectionProxy)

    const volumeProxy = new THREE.Group()
    volumeProxy.name = 'Forge volume selector'
    volumeProxy.userData.forgeEditorHelper = true
    volumeProxy.position.set(0, 0.75, 0)
    volumeProxy.scale.set(1.2, 1.2, 1.2)
    scene.add(volumeProxy)
    const volumeBox = new THREE.Box3()
    const volumeHelper = new THREE.Box3Helper(volumeBox, '#78a6ff')
    volumeHelper.visible = false
    volumeHelper.userData.forgeEditorHelper = true
    volumeHelper.raycast = () => {}
    scene.add(volumeHelper)
    const volumeFillMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: '#78a6ff',
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    volumeFillMesh.visible = false
    volumeFillMesh.userData.forgeEditorHelper = true
    volumeFillMesh.raycast = () => {}
    scene.add(volumeFillMesh)
    const volumeHighlightMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: '#ffb02e',
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        side: THREE.DoubleSide,
      }),
    )
    volumeHighlightMesh.visible = false
    volumeHighlightMesh.frustumCulled = false
    volumeHighlightMesh.userData.forgeEditorHelper = true
    volumeHighlightMesh.raycast = () => {}
    scene.add(volumeHighlightMesh)

    const studioLights = new THREE.Group()
    studioLights.name = 'Studio_Lights'
    studioLights.userData.forgeId = 'lights'
    scene.add(studioLights)
    objects.set('lights', studioLights)
    const ambient = new THREE.HemisphereLight('#dce9ff', '#242a3b', 2.1)
    studioLights.add(ambient)
    const keyLight = new THREE.DirectionalLight('#fff0d9', 3.5)
    keyLight.position.set(4, 8, 5)
    studioLights.add(keyLight)
    const rimLight = new THREE.DirectionalLight('#617eff', 2.7)
    rimLight.position.set(-5, 3, -4)
    studioLights.add(rimLight)

    const grid = new THREE.GridHelper(20, 40, '#39404e', '#252a34')
    grid.position.y = -0.012
    scene.add(grid)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardNodeMaterial({ color: '#111317', roughness: 0.9 }))
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.03
    floor.receiveShadow = true
    scene.add(floor)

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const getCanvasRect = () => renderer?.domElement.getBoundingClientRect() ?? element.getBoundingClientRect()
    const raycastHits = (event: PointerEvent, current: ViewportRuntime) => {
      const canvasRect = getCanvasRect()
      if (!canvasRect.width || !canvasRect.height) return []
      pointer.x = ((event.clientX - canvasRect.left) / canvasRect.width) * 2 - 1
      pointer.y = -((event.clientY - canvasRect.top) / canvasRect.height) * 2 + 1
      scene.updateMatrixWorld(true)
      return pickAllVisibleMeshes(current.objects, camera, raycaster, pointer)
    }
    const applyPickHit = (hit: THREE.Intersection | null, current: ViewportRuntime, additive: boolean) => {
      if (!hit?.object.userData.forgeId) return false
      const id = hit.object.userData.forgeId as string
      const localPoint = (hit.object as THREE.Mesh).worldToLocal(hit.point.clone())
      current.lastHit = { id, point: tuple(localPoint) }
      if (activeToolRef.current === 'volume' || current.volumeActive) {
        const bounds = computeTargetBounds(current, id)
        const size = bounds.isEmpty() ? new THREE.Vector3(1, 1, 1) : bounds.getSize(new THREE.Vector3())
        current.volumeProxy.position.copy(hit.point)
        current.volumeProxy.scale.set(
          Math.max(0.25, size.x * 0.45),
          Math.max(0.25, size.y * 0.35),
          Math.max(0.25, size.z * 0.45),
        )
        current.volumeInitialized = true
        refreshVolumeSelection(current, id, true)
      }
      onSelect(id, additive)
      return true
    }

    const marquee = document.createElement('div')
    marquee.className = 'selection-marquee'
    marquee.hidden = true
    element.appendChild(marquee)
    let boxGesture: { pointerId: number; startX: number; startY: number; additive: boolean; altKey: boolean; moved: boolean } | null = null
    let clickGesture: { pointerId: number; startX: number; startY: number; additive: boolean } | null = null

    const isMarqueeActive = (current: ViewportRuntime, event?: PointerEvent) =>
      !current.volumeActive &&
      activeToolRef.current === 'select' &&
      (boxSelectRef.current || Boolean(event?.altKey))

    const onPointerDownPick = (event: PointerEvent) => {
      // TransformControls receives the canvas pointer event first, then it bubbles
      // to this host listener. Record click candidates only when not interacting with a gizmo.
      const current = runtime.current
      if (!current || event.button !== 0 || current.transform.dragging || isMarqueeActive(current, event) || boxGesture) return
      if (current.transform.enabled && current.transform.axis !== null) return
      clickGesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        additive: event.shiftKey || event.ctrlKey || event.metaKey,
      }
    }
    const onPointerUpPick = (event: PointerEvent) => {
      if (!clickGesture || event.pointerId !== clickGesture.pointerId) return
      const gesture = clickGesture
      clickGesture = null
      const current = runtime.current
      if (!current || event.button !== 0 || current.transform.dragging || isMarqueeActive(current, event) || boxGesture) return
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >= 4) return
      const hits = raycastHits(event, current)
      const hit = event.altKey ? cycleMeshHit(hits, selectedIdRef.current) : (hits[0] ?? null)
      applyPickHit(hit, current, gesture.additive)
    }
    const onPointerCancelPick = (event: PointerEvent) => {
      if (clickGesture && event.pointerId === clickGesture.pointerId) clickGesture = null
    }
    element.addEventListener('pointerdown', onPointerDownPick)
    element.addEventListener('pointerup', onPointerUpPick)
    element.addEventListener('pointercancel', onPointerCancelPick)

    const startBoxSelect = (event: PointerEvent) => {
      const current = runtime.current
      if (!current || current.volumeActive || activeToolRef.current !== 'select' || (!boxSelectRef.current && !event.altKey) || event.button !== 0) return
      if (current.transform.enabled && current.transform.axis !== null) return
      event.preventDefault()
      event.stopPropagation()
      const rect = element.getBoundingClientRect()
      boxGesture = {
        pointerId: event.pointerId,
        startX: event.clientX - rect.left,
        startY: event.clientY - rect.top,
        additive: event.shiftKey || event.ctrlKey || event.metaKey,
        altKey: event.altKey,
        moved: false,
      }
      element.setPointerCapture(event.pointerId)
      current.controls.enabled = false
      marquee.hidden = true
      marquee.style.left = `${boxGesture.startX}px`
      marquee.style.top = `${boxGesture.startY}px`
      marquee.style.width = '0px'
      marquee.style.height = '0px'
    }
    const moveBoxSelect = (event: PointerEvent) => {
      if (!boxGesture || event.pointerId !== boxGesture.pointerId) return
      const rect = element.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      if (!boxGesture.moved) {
        if (Math.hypot(x - boxGesture.startX, y - boxGesture.startY) < 4) return
        boxGesture.moved = true
        marquee.hidden = false
      }
      marquee.style.left = `${Math.min(x, boxGesture.startX)}px`
      marquee.style.top = `${Math.min(y, boxGesture.startY)}px`
      marquee.style.width = `${Math.abs(x - boxGesture.startX)}px`
      marquee.style.height = `${Math.abs(y - boxGesture.startY)}px`
      marquee.classList.toggle('crossing', x < boxGesture.startX)
    }
    const endBoxSelect = (event: PointerEvent) => {
      if (!boxGesture || event.pointerId !== boxGesture.pointerId) return
      const gesture = boxGesture
      boxGesture = null
      marquee.hidden = true
      if (element.hasPointerCapture?.(event.pointerId)) {
        element.releasePointerCapture(event.pointerId)
      }
      const current = runtime.current
      if (!current) return
      if (event.type === 'pointercancel') {
        current.controls.enabled = activeToolRef.current === 'select' || Boolean(current.volumeActive)
        return
      }
      const elementRect = element.getBoundingClientRect()
      const endX = event.clientX - elementRect.left
      const endY = event.clientY - elementRect.top
      const travel = Math.hypot(endX - gesture.startX, endY - gesture.startY)
      if (travel < 4) {
        const hits = raycastHits(event, current)
        const isAlt = gesture.altKey || event.altKey
        const hit = isAlt ? cycleMeshHit(hits, selectedIdRef.current) : (hits[0] ?? null)
        const picked = applyPickHit(hit, current, gesture.additive)
        if (!picked && !isAlt && !gesture.additive) {
          onSelectMany([], false)
        }
      } else {
        const canvasRect = getCanvasRect()
        const offsetX = elementRect.left - canvasRect.left
        const offsetY = elementRect.top - canvasRect.top
        const minX = Math.min(gesture.startX, endX) + offsetX
        const maxX = Math.max(gesture.startX, endX) + offsetX
        const minY = Math.min(gesture.startY, endY) + offsetY
        const maxY = Math.max(gesture.startY, endY) + offsetY
        const crossing = endX < gesture.startX
        current.scene.updateMatrixWorld(true)
        camera.updateMatrixWorld(true)
        const ids = selectMeshesInRect(current.objects, camera, canvasRect.width, canvasRect.height, { minX, maxX, minY, maxY }, crossing)
        onSelectMany([...new Set(ids)], gesture.additive)
      }
      current.controls.enabled = activeToolRef.current === 'select' || Boolean(current.volumeActive)
    }
    element.addEventListener('pointerdown', startBoxSelect, true)
    element.addEventListener('pointermove', moveBoxSelect)
    element.addEventListener('pointerup', endBoxSelect)
    element.addEventListener('pointercancel', endBoxSelect)

    const lassoSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    lassoSvg.setAttribute('class', 'lasso-overlay')
    const lassoPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
    lassoPoly.setAttribute('fill', 'rgba(183, 243, 107, 0.16)')
    lassoPoly.setAttribute('stroke', '#b7f36b')
    lassoPoly.setAttribute('stroke-width', '1.5')
    lassoPoly.setAttribute('stroke-dasharray', '4 3')
    lassoSvg.appendChild(lassoPoly)
    lassoSvg.style.display = 'none'
    element.appendChild(lassoSvg)

    let lassoGesture: { pointerId: number; points: ScreenPoint[]; mode: 'extract' | 'delete' } | null = null
    const startLasso = (event: PointerEvent) => {
      const current = runtime.current
      if (!current || current.freeformMode === 'off' || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const rect = element.getBoundingClientRect()
      const pt = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      lassoGesture = { pointerId: event.pointerId, points: [pt], mode: current.freeformMode }
      element.setPointerCapture(event.pointerId)
      current.controls.enabled = false
      lassoPoly.setAttribute('stroke', current.freeformMode === 'delete' ? '#f37b7b' : '#b7f36b')
      lassoPoly.setAttribute('fill', current.freeformMode === 'delete' ? 'rgba(243, 123, 123, 0.18)' : 'rgba(183, 243, 107, 0.16)')
      lassoPoly.setAttribute('points', `${pt.x},${pt.y}`)
      lassoSvg.style.display = 'block'
    }
    const moveLasso = (event: PointerEvent) => {
      if (!lassoGesture || event.pointerId !== lassoGesture.pointerId) return
      const rect = element.getBoundingClientRect()
      const pt = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const last = lassoGesture.points[lassoGesture.points.length - 1]
      if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= 4) {
        lassoGesture.points.push(pt)
        lassoPoly.setAttribute('points', lassoGesture.points.map((p) => `${p.x},${p.y}`).join(' '))
      }
    }
    const endLasso = (event: PointerEvent) => {
      if (!lassoGesture || event.pointerId !== lassoGesture.pointerId) return
      const gesture = lassoGesture
      lassoGesture = null
      lassoSvg.style.display = 'none'
      lassoPoly.setAttribute('points', '')
      if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId)
      const current = runtime.current
      if (!current) return
      current.controls.enabled = activeToolRef.current === 'select' || Boolean(current.volumeActive)
      if (gesture.points.length < 3) return
      const canvasRect = getCanvasRect()
      current.scene.updateMatrixWorld(true)
      camera.updateMatrixWorld(true)
      const targetMeshes = selectedIdRef.current && (current.objects.get(selectedIdRef.current) as THREE.Mesh | undefined)?.isMesh
        ? [[selectedIdRef.current, current.objects.get(selectedIdRef.current) as THREE.Mesh] as const]
        : [...current.objects.entries()].filter(([, obj]) => (obj as THREE.Mesh).isMesh && !obj.userData.forgeEditorHelper) as Array<[string, THREE.Mesh]>

      const newNodes: SceneNode[] = []
      const extractedIds: string[] = []
      for (const [sourceId, sourceObj] of targetMeshes) {
        const tris = selectTrianglesInScreenPolygon(sourceObj, camera, canvasRect.width, canvasRect.height, gesture.points)
        if (!tris.length) continue
        let idx = 1
        while (current.objects.has(`${sourceId}:lasso-${idx}`)) idx++
        const partId = `${sourceId}:lasso-${idx}`
        const res = extractTrianglesAsPart(sourceObj, tris, {
          name: `${sourceObj.name || 'Part'}_lasso_${idx}`,
          forgeId: partId,
        })
        if (!res) continue
        sourceObj.geometry = res.remainingGeometry
        if (res.remainingCount === 0) sourceObj.visible = false
        if (gesture.mode === 'extract') {
          const parent = sourceObj.parent ?? current.scene
          parent.add(res.part)
          current.objects.set(partId, res.part)
          current.initialTransforms.set(partId, readTransform(res.part))
          const sourceNode = current.nodes.find((n) => n.id === sourceId)
          newNodes.push({ id: partId, name: res.part.name, type: 'Mesh', visible: true, parent: sourceNode?.parent ?? null })
          extractedIds.push(partId)
        } else {
          res.part.geometry.dispose()
        }
      }
      if (newNodes.length) {
        current.nodes = [...current.nodes, ...newNodes]
        onNodesChange(current.nodes)
        onSelectMany(extractedIds, false)
      }
      current.freeformMode = 'off'
      onTransformCommit?.()
    }
    element.addEventListener('pointerdown', startLasso, true)
    element.addEventListener('pointermove', moveLasso)
    element.addEventListener('pointerup', endLasso)
    element.addEventListener('pointercancel', endLasso)

    void (async () => {
      try {
        renderer = new THREE.WebGPURenderer({ antialias: true, alpha: false })
        await renderer.init()
        rendererInitialized = true
        if (disposed) { renderer.dispose(); return }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        renderer.shadowMap.enabled = true
        renderer.shadowMap.type = THREE.PCFSoftShadowMap
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 1.12
        renderer.setClearColor('#111317')
        element.prepend(renderer.domElement)
        renderer.domElement.className = 'scene-canvas'
        const backend = renderer.backend?.constructor.name ?? 'GPU'
        onRendererChange(backend.toLowerCase().includes('webgpu') ? 'WebGPU' : 'WebGL 2 fallback')
        const controls = new OrbitControls(camera, renderer.domElement)
        controls.target.set(0, 1.05, 0)
        controls.enableDamping = true
        controls.dampingFactor = 0.06
        controls.minDistance = 0.05
        controls.maxDistance = 200
        controls.maxPolarAngle = Math.PI * 0.49
        resizeObserver = new ResizeObserver(([entry]) => {
          if (!entry || !renderer) return
          const { width, height } = entry.contentRect
          if (width <= 0 || height <= 0) return
          camera.aspect = width / height
          camera.updateProjectionMatrix()
          renderer.setSize(width, height, false)
        })
        resizeObserver.observe(element)
        const transform = new TransformControls(camera, renderer.domElement)
        transform.addEventListener('dragging-changed', (event) => {
          const dragging = (event as { value: boolean }).value
          if (dragging) clickGesture = null
          const current = runtime.current
          controls.enabled = !dragging && (activeToolRef.current === 'select' || Boolean(current?.volumeActive))
          if (dragging && current && current.transform.object === current.selectionProxy) {
            current.selectionProxy.updateMatrixWorld(true)
            const objectMatrices = new Map<string, THREE.Matrix4>()
            const selectedSet = new Set(selectedIdsRef.current)
            for (const id of selectedIdsRef.current) {
              const object = current.objects.get(id)
              if (!object) continue
              let ancestor = object.parent
              let selectedAncestor = false
              while (ancestor) {
                if (selectedSet.has(ancestor.userData.forgeId as string)) { selectedAncestor = true; break }
                ancestor = ancestor.parent
              }
              if (!selectedAncestor) { object.updateWorldMatrix(true, false); objectMatrices.set(id, object.matrixWorld.clone()) }
            }
            current.dragStart = { proxyMatrix: current.selectionProxy.matrixWorld.clone(), objectMatrices }
          } else if (!dragging && current && current.transform.object === current.selectionProxy) {
            current.dragStart = null
            const bounds = new THREE.Box3()
            for (const id of selectedIdsRef.current) { const object = current.objects.get(id); if (object) bounds.expandByObject(object) }
            if (!bounds.isEmpty()) current.selectionProxy.position.copy(bounds.getCenter(new THREE.Vector3()))
            current.selectionProxy.rotation.set(0, 0, 0)
            current.selectionProxy.scale.set(1, 1, 1)
            current.selectionProxy.updateMatrixWorld(true)
          } else if (!dragging && current && current.transform.object === current.volumeProxy) {
            refreshVolumeSelection(current, selectedIdRef.current, true)
          }
          if (!dragging && current && current.transform.object !== current.volumeProxy) {
            onTransformCommit?.()
          }
        })
        transform.addEventListener('objectChange', () => {
          const current = runtime.current
          if (!current) return
          if (transform.object === current.volumeProxy) {
            refreshVolumeSelection(current, selectedIdRef.current, true)
            return
          }
          if (transform.object === current.selectionProxy && current.dragStart) {
            current.selectionProxy.updateMatrixWorld(true)
            const delta = current.selectionProxy.matrixWorld.clone().multiply(current.dragStart.proxyMatrix.clone().invert())
            for (const [id, initialWorld] of current.dragStart.objectMatrices) {
              const object = current.objects.get(id)
              if (!object) continue
              const desiredWorld = delta.clone().multiply(initialWorld)
              const parentInverse = object.parent ? object.parent.matrixWorld.clone().invert() : new THREE.Matrix4()
              const local = parentInverse.multiply(desiredWorld)
              const quaternion = new THREE.Quaternion()
              local.decompose(object.position, quaternion, object.scale)
              object.rotation.setFromQuaternion(quaternion, object.rotation.order)
              object.updateMatrixWorld(true)
            }
            const primary = current.objects.get(selectedIdRef.current)
            if (primary) onTransformChange(readTransform(primary))
          } else {
            const selected = transform.object
            if (selected) onTransformChange(readTransform(selected))
          }
        })
        scene.add(transform.getHelper())
        runtime.current = {
          scene,
          camera,
          renderer,
          controls,
          objects,
          nodes: [],
          initialTransforms: new Map(),
          asset: null,
          transform,
          selectionHelper,
          selectionHelpers,
          selectionProxy,
          dragStart: null,
          wireframeMaterials: new Map(),
          dissolves,
          pivots,
          lastHit: null,
          observer: resizeObserver,
          volumeProxy,
          volumeBox,
          volumeHelper,
          volumeFillMesh,
          volumeHighlightMesh,
          volumeMode: 'translate',
          volumeActive: false,
          volumeInitialized: false,
          volumeSelection: { meshIds: [], trianglesByMesh: new Map(), triangleCount: 0, primaryMeshId: null },
          mixer: null,
          clips: [],
          activeClipName: null,
          skeletonHelper: null,
          freeformMode: 'off',
        }
        const initialSelection = objects.get(selectedId)
        if (initialSelection) onTransformChange(readTransform(initialSelection))
        let lastSelectedRefObject: THREE.Object3D | undefined
        let lastSelectedTransformSig = ''
        renderer.setAnimationLoop(() => {
          controls.update()
          const selected = runtime.current?.objects.get(selectedIdRef.current)
          const isHugeNode = selected && (selected.userData.forgeImported || selected.children.length > 40)
          selectionHelper.visible = Boolean(selected && !isHugeNode)
          if (selected && !isHugeNode) {
            const sig = `${selected.position.x.toFixed(3)},${selected.position.y.toFixed(3)},${selected.position.z.toFixed(3)},${selected.rotation.x.toFixed(3)},${selected.rotation.y.toFixed(3)},${selected.rotation.z.toFixed(3)},${selected.scale.x.toFixed(3)}`
            if (selected !== lastSelectedRefObject || sig !== lastSelectedTransformSig || runtime.current?.transform.dragging) {
              lastSelectedRefObject = selected
              lastSelectedTransformSig = sig
              selectionHelper.box.setFromObject(selected)
            }
          }
          if (selectedIdsRef.current.length <= 25) {
            for (const [id, helper] of selectionHelpers) {
              const object = runtime.current?.objects.get(id)
              const skipHuge = object && (object.userData.forgeImported || object.children.length > 40)
              helper.visible = Boolean(object && !skipHuge)
              if (object && !skipHuge && runtime.current?.transform.dragging) helper.box.setFromObject(object)
            }
          }
          if (runtime.current && selectedIdsRef.current.length > 1 && selectedIdsRef.current.length <= 40 && !runtime.current.transform.dragging) {
            const selectionBounds = new THREE.Box3()
            for (const id of selectedIdsRef.current) {
              const object = runtime.current.objects.get(id)
              if (object) selectionBounds.expandByObject(object)
            }
            if (!selectionBounds.isEmpty()) runtime.current.selectionProxy.position.copy(selectionBounds.getCenter(new THREE.Vector3()))
            runtime.current.selectionProxy.rotation.set(0, 0, 0)
            runtime.current.selectionProxy.scale.set(1, 1, 1)
          }
          renderer?.render(scene, camera)
        })
      } catch (error) {
        if (!disposed) {
          onRendererChange('GPU unavailable')
          onRendererError(error instanceof Error ? error.message : 'The GPU renderer could not initialize')
          console.error('Could not initialize the Three.js WebGPU renderer', error)
        }
      }
    })()

    return () => {
      disposed = true
      element.removeEventListener('pointerdown', onPointerDownPick)
      element.removeEventListener('pointerup', onPointerUpPick)
      element.removeEventListener('pointercancel', onPointerCancelPick)
      element.removeEventListener('pointerdown', startBoxSelect, true)
      element.removeEventListener('pointermove', moveBoxSelect)
      element.removeEventListener('pointerup', endBoxSelect)
      element.removeEventListener('pointercancel', endBoxSelect)
      element.removeEventListener('pointerdown', startLasso, true)
      element.removeEventListener('pointermove', moveLasso)
      element.removeEventListener('pointerup', endLasso)
      element.removeEventListener('pointercancel', endLasso)
      marquee.remove()
      lassoSvg.remove()
      resizeObserver?.disconnect()
      if (renderer && rendererInitialized) {
        renderer.setAnimationLoop(null)
        if (runtime.current?.renderer === renderer) {
          runtime.current.dissolves.clear()
          runtime.current.pivots.clear()
          runtime.current.controls.dispose()
          runtime.current.transform.dispose()
          runtime.current = null
        }
        disposeObjectTree(scene)
        renderer.dispose()
      } else disposeObjectTree(scene)
    }
  }, [onSelect, onSelectMany, onRendererChange, onRendererError])

  useEffect(() => {
    const current = runtime.current
    if (!current) return
    const prevActiveTool = prevActiveToolRef.current
    prevActiveToolRef.current = activeTool

    if (activeTool === 'volume') {
      current.volumeActive = true
    } else if (activeTool === 'move' || activeTool === 'rotate' || activeTool === 'scale') {
      current.volumeActive = false
    } else if (prevActiveTool === 'volume' && activeTool === 'select') {
      current.volumeActive = false
    }

    const object = current.objects.get(selectedId)
    const control = current.transform
    const selectedObjects = selectedIds.map((id) => current.objects.get(id)).filter((item): item is THREE.Object3D => Boolean(item))
    if (selectedObjects.length > 1) {
      const bounds = new THREE.Box3()
      for (const item of selectedObjects) bounds.expandByObject(item)
      if (!bounds.isEmpty()) current.selectionProxy.position.copy(bounds.getCenter(new THREE.Vector3()))
      current.selectionProxy.rotation.set(0, 0, 0)
      current.selectionProxy.scale.set(1, 1, 1)
      current.selectionProxy.updateMatrixWorld(true)
    }
    const helper = current.selectionHelper
    if (helper) {
      helper.visible = Boolean(object)
      if (object) helper.box.setFromObject(object)
    }
    const selectedSet = new Set(selectedIds)
    for (const [id, selectedHelper] of current.selectionHelpers) {
      if (selectedSet.has(id)) continue
      current.scene.remove(selectedHelper)
      selectedHelper.geometry.dispose()
      const materials = Array.isArray(selectedHelper.material) ? selectedHelper.material : [selectedHelper.material]
      materials.forEach((material) => material.dispose())
      current.selectionHelpers.delete(id)
    }
    for (const id of selectedSet) {
      if (current.selectionHelpers.has(id)) continue
      const selectedHelper = new THREE.Box3Helper(new THREE.Box3(), '#83a6e9')
      current.selectionHelpers.set(id, selectedHelper)
      current.scene.add(selectedHelper)
    }

    if (current.volumeActive) {
      if (!current.volumeInitialized) initVolumeBounds(current, selectedId)
      current.volumeHelper.visible = true
      current.volumeFillMesh.visible = true
      control.attach(current.volumeProxy)
      control.setMode(current.volumeMode)
      control.enabled = true
      current.controls.enabled = !control.dragging
      refreshVolumeSelection(current, selectedId, true)
    } else {
      current.volumeHelper.visible = false
      current.volumeFillMesh.visible = false
      current.volumeHighlightMesh.visible = false
      if (selectedObjects.length > 1 && activeTool !== 'select') control.attach(current.selectionProxy)
      else if (object && activeTool !== 'select') control.attach(object)
      else control.detach()
      current.controls.enabled = activeTool === 'select'
      control.enabled = activeTool !== 'select'
      if (activeTool === 'move' || activeTool === 'rotate' || activeTool === 'scale') {
        control.setMode(activeTool === 'move' ? 'translate' : activeTool === 'rotate' ? 'rotate' : 'scale')
      }
    }

    if (object) onTransformChange(readTransform(object))
  }, [selectedId, selectedIds, activeTool, onTransformChange])

  return <div ref={host} className="scene-host"><div className="scene-loading"><div className="loading-mark"><CuboidMark /></div><span>Initializing WebGPU viewport</span><small>Preparing renderer and scene</small></div></div>
})

function CuboidMark() { return <span className="cube-glyph">◈</span> }

export default SceneViewport
