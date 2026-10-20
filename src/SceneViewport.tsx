import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { selectMeshesInRect } from './features/selection/viewportSelection'
import { pickClosestVisibleMesh } from './features/selection/pickMesh'
import type { SceneEffect } from './features/effects/dissolve'
import { createDissolveController } from './renderer/three/dissolve'
import { createPivotController, type PivotPoint } from './renderer/three/pivots'

export type SceneNode = { id: string; name: string; type: string; visible: boolean; parent: string | null }
export type ObjectTransform = { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }
export type ObjectStats = { meshCount: number; vertexCount: number; triangleCount: number; materialCount: number; dimensions: [number, number, number] }
export type ViewportApi = {
  loadModel: (file: File, assetKey?: string, resources?: File[], resourcePaths?: string[]) => Promise<SceneNode[]>
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
}
type Props = {
  selectedId: string
  selectedIds: string[]
  activeTool: 'select' | 'move' | 'rotate' | 'scale'
  boxSelect: boolean
  onSelect: (id: string, additive: boolean) => void
  onSelectMany: (ids: string[], additive: boolean) => void
  onNodesChange: (nodes: SceneNode[]) => void
  onRendererChange: (name: string) => void
  onRendererError: (message: string) => void
  onTransformChange: (transform: ObjectTransform) => void
}
type ViewportRuntime = { scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGPURenderer; controls: OrbitControls; objects: Map<string, THREE.Object3D>; nodes: SceneNode[]; initialTransforms: Map<string, ObjectTransform>; asset: { files: File[]; resourcePaths: string[]; assetKey: string } | null; transform: TransformControls; selectionHelper: THREE.Box3Helper; selectionHelpers: Map<string, THREE.Box3Helper>; selectionProxy: THREE.Group; dragStart: { proxyMatrix: THREE.Matrix4; objectMatrices: Map<string, THREE.Matrix4> } | null; wireframeMaterials: Map<THREE.Material, boolean | undefined>; dissolves: ReturnType<typeof createDissolveController>; pivots: ReturnType<typeof createPivotController>; lastHit: { id: string; point: PivotPoint } | null; observer: ResizeObserver }

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

const SceneViewport = forwardRef<ViewportApi, Props>(function SceneViewport({ selectedId, selectedIds, activeTool, boxSelect, onSelect, onSelectMany, onNodesChange, onRendererChange, onRendererError, onTransformChange }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const activeToolRef = useRef(activeTool)
  activeToolRef.current = activeTool
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds
  const boxSelectRef = useRef(boxSelect)
  boxSelectRef.current = boxSelect
  const runtime = useRef<ViewportRuntime | null>(null)

  useImperativeHandle(ref, () => ({
    async loadModel(file, assetKey, resources = [file], resourcePaths = []) {
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
        const gltf = await new GLTFLoader(manager).loadAsync(fileUrl)
        const root = gltf.scene
        const key = assetKey ?? `model-${file.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`
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
          if (extent > 0) root.scale.multiplyScalar(2.2 / extent)
          root.updateMatrixWorld(true)
          const normalizedBounds = new THREE.Box3().setFromObject(root)
          const center = normalizedBounds.getCenter(new THREE.Vector3())
          const ground = normalizedBounds.min.y
          root.position.x -= center.x
          root.position.y -= ground
          root.position.z -= center.z
          root.updateMatrixWorld(true)
          const framedBounds = new THREE.Box3().setFromObject(root)
          const framedSize = framedBounds.getSize(new THREE.Vector3())
          const target = framedBounds.getCenter(new THREE.Vector3())
          current.controls.target.copy(target)
          const radius = Math.max(framedSize.length() * 0.5, 0.5)
          const distance = radius / Math.sin(THREE.MathUtils.degToRad(current.camera.fov * 0.5)) * 1.2
          const direction = current.camera.position.clone().sub(current.controls.target).normalize()
          current.camera.position.copy(target).addScaledVector(direction, distance)
          current.controls.update()
        }
        current.initialTransforms.clear()
        for (const [id, object] of current.objects) if (object.userData.forgeImported || object.userData.forgeId?.startsWith(`${key}:`)) current.initialTransforms.set(id, readTransform(object))
        current.asset = { files: sourceFiles, resourcePaths: sourceFiles.map((resource, index) => resourcePaths[index] || resource.webkitRelativePath || resource.name), assetKey: key }
        current.nodes = nodes
        onNodesChange(nodes)
        return nodes
      } finally { urls.forEach((url) => URL.revokeObjectURL(url)) }
    },
    clearImported() {
      const current = runtime.current
      if (!current) return
      current.dissolves.clear()
      current.pivots.clear()
      current.nodes = []
      current.initialTransforms.clear()
      current.asset = null
      current.transform.detach()
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
  }), [onNodesChange])

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
    scene.add(selectionHelper)
    const selectionHelpers = new Map<string, THREE.Box3Helper>()
    const selectionProxy = new THREE.Group()
    selectionProxy.name = 'Forge selection transform'
    selectionProxy.userData.forgeEditorHelper = true
    scene.add(selectionProxy)

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
    const pickVisibleMesh = (event: PointerEvent, current: ViewportRuntime) => {
      const canvasRect = renderer?.domElement.getBoundingClientRect() ?? element.getBoundingClientRect()
      if (!canvasRect.width || !canvasRect.height) return null
      pointer.x = ((event.clientX - canvasRect.left) / canvasRect.width) * 2 - 1
      pointer.y = -((event.clientY - canvasRect.top) / canvasRect.height) * 2 + 1
      scene.updateMatrixWorld(true)
      return pickClosestVisibleMesh(current.objects, camera, raycaster, pointer)
    }
    const pick = (event: PointerEvent) => {
      // TransformControls receives the canvas pointer event first, then it bubbles
      // to this host listener. Do not raycast/select during gizmo interactions.
      const current = runtime.current
      if (!current || event.button !== 0 || current.transform.dragging || boxSelectRef.current) return
      // In transform modes, clicks on a gizmo handle belong to TransformControls;
      // clicks on model geometry still select that mesh from the viewport.
      if (activeToolRef.current !== 'select' && current.transform.axis !== null) return
      const hit = pickVisibleMesh(event, current)
      if (hit?.object.userData.forgeId) {
        const id = hit.object.userData.forgeId as string
        const localPoint = (hit.object as THREE.Mesh).worldToLocal(hit.point.clone())
        current.lastHit = { id, point: tuple(localPoint) }
        onSelect(id, event.shiftKey || event.ctrlKey || event.metaKey)
      }
    }
    element.addEventListener('pointerdown', pick)

    const marquee = document.createElement('div')
    marquee.className = 'selection-marquee'
    marquee.hidden = true
    element.appendChild(marquee)
    let boxGesture: { pointerId: number; startX: number; startY: number; additive: boolean } | null = null
    const startBoxSelect = (event: PointerEvent) => {
      if (!boxSelectRef.current || activeToolRef.current !== 'select' || event.button !== 0 || !runtime.current) return
      event.preventDefault()
      event.stopPropagation()
      const rect = element.getBoundingClientRect()
      boxGesture = { pointerId: event.pointerId, startX: event.clientX - rect.left, startY: event.clientY - rect.top, additive: event.shiftKey || event.ctrlKey || event.metaKey }
      element.setPointerCapture(event.pointerId)
      runtime.current.controls.enabled = false
      marquee.hidden = false
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
      const elementRect = element.getBoundingClientRect()
      const endX = event.clientX - elementRect.left
      const endY = event.clientY - elementRect.top
      const minX = Math.min(gesture.startX, endX)
      const maxX = Math.max(gesture.startX, endX)
      const minY = Math.min(gesture.startY, endY)
      const maxY = Math.max(gesture.startY, endY)
      const crossing = endX < gesture.startX
      const current = runtime.current
      if (current) {
        const ids: string[] = []
        if (maxX - minX < 4 && maxY - minY < 4) {
          const hit = pickVisibleMesh(event, current)
          if (hit?.object.userData.forgeId) {
            const id = hit.object.userData.forgeId as string
            const localPoint = (hit.object as THREE.Mesh).worldToLocal(hit.point.clone())
            current.lastHit = { id, point: tuple(localPoint) }
            ids.push(id)
          }
        } else {
          camera.updateMatrixWorld(true)
          ids.push(...selectMeshesInRect(current.objects, camera, elementRect.width, elementRect.height, { minX, maxX, minY, maxY }, crossing))
        }
        onSelectMany([...new Set(ids)], gesture.additive)
        current.controls.enabled = activeToolRef.current === 'select'
      }
    }
    element.addEventListener('pointerdown', startBoxSelect, true)
    element.addEventListener('pointermove', moveBoxSelect)
    element.addEventListener('pointerup', endBoxSelect)
    element.addEventListener('pointercancel', endBoxSelect)

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
        controls.minDistance = 2.8
        controls.maxDistance = 18
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
          controls.enabled = !dragging && activeToolRef.current === 'select'
          const current = runtime.current
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
          }
        })
        transform.addEventListener('objectChange', () => {
          const current = runtime.current
          if (!current) return
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
        runtime.current = { scene, camera, renderer, controls, objects, nodes: [], initialTransforms: new Map(), asset: null, transform, selectionHelper, selectionHelpers, selectionProxy, dragStart: null, wireframeMaterials: new Map(), dissolves, pivots, lastHit: null, observer: resizeObserver }
        const initialSelection = objects.get(selectedId)
        if (initialSelection) onTransformChange(readTransform(initialSelection))
        renderer.setAnimationLoop(() => {
          controls.update()
          const selected = runtime.current?.objects.get(selectedIdRef.current)
          selectionHelper.visible = Boolean(selected)
          if (selected) selectionHelper.box.setFromObject(selected)
          for (const [id, helper] of selectionHelpers) {
            const object = runtime.current?.objects.get(id)
            helper.visible = Boolean(object)
            if (object) helper.box.setFromObject(object)
          }
          if (runtime.current && selectedIdsRef.current.length > 1 && !runtime.current.transform.dragging) {
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
      element.removeEventListener('pointerdown', pick)
      element.removeEventListener('pointerdown', startBoxSelect, true)
      element.removeEventListener('pointermove', moveBoxSelect)
      element.removeEventListener('pointerup', endBoxSelect)
      element.removeEventListener('pointercancel', endBoxSelect)
      marquee.remove()
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
    if (selectedObjects.length > 1 && activeTool !== 'select') control.attach(current.selectionProxy)
    else if (object && activeTool !== 'select') control.attach(object)
    else control.detach()
  }, [selectedId, selectedIds, activeTool])

  useEffect(() => {
    const current = runtime.current
    if (!current) return
    const selected = current.objects.get(selectedId)
    if (!selected) return
    current.controls.enabled = activeTool === 'select'
    current.transform.enabled = activeTool !== 'select'
    current.transform.setMode(activeTool === 'move' ? 'translate' : activeTool === 'rotate' ? 'rotate' : 'scale')
    onTransformChange(readTransform(selected))
  }, [selectedId, selectedIds, activeTool, onTransformChange])

  return <div ref={host} className="scene-host"><div className="scene-loading"><div className="loading-mark"><CuboidMark /></div><span>Initializing WebGPU viewport</span><small>Preparing renderer and scene</small></div></div>
})

function CuboidMark() { return <span className="cube-glyph">◈</span> }

export default SceneViewport
