import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Box, ChevronDown, ChevronRight, Code2, Cuboid, ExternalLink,
  Download, Eye, EyeOff, FilePlus2, FolderOpen, Grid2X2, Layers3,
  Maximize2, Move3D, MousePointer2, Pause, Play,
  Plus, Redo2, Rotate3D, RotateCcw, Scan, Search, Sparkles, SquareDashed, Trash2, Triangle, Undo2, Upload, Video, X,
} from 'lucide-react'
import type { ObjectStats, ObjectTransform, SceneNode, ViewportApi } from './SceneViewport'
import { selectMany as mergeSelection, selectOne as toggleSelection } from './features/selection/selectionState'
import { dissolveProgress, isSceneEffect, isSurfaceEffect, type SceneEffect, type SurfaceEffect } from './features/effects/dissolve'
import { createDefaultManifest, type EnvironmentPresetId } from './domain/sceneManifest'
import { generateR3FComponent, patchR3FFile } from './export/r3f/r3fCodegen'
import { buildExportZipEntries, buildProjectData, generateRuntimeJs, resolveExportAssetPath } from './export/forgeExporter'
import { matchHistoryShortcut, shouldIgnoreHistoryShortcut, useHistoryStore } from './features/history/historyStore'

const SceneViewport = lazy(() => import('./SceneViewport'))

type Keyframe = { id: string; targetId: string; time: number; position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }
const initialNodes: SceneNode[] = []
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'scene'
const resourcePath = (file: File) => (file.webkitRelativePath || file.name).replaceAll('\\', '/').split('/').filter((part) => part && part !== '.' && part !== '..').join('/')
const mixFrame = (frames: Keyframe[], time: number): Keyframe | null => {
  if (!frames.length) return null
  const before = [...frames].reverse().find((frame) => frame.time <= time)
  const after = frames.find((frame) => frame.time > time)
  if (!before) return after ?? null
  if (!after) return before
  const ratio = (time - before.time) / (after.time - before.time)
  const mix = (a: [number, number, number], b: [number, number, number]) => a.map((value, index) => value + (b[index] - value) * ratio) as [number, number, number]
  return { ...before, time, position: mix(before.position, after.position), rotation: mix(before.rotation, after.rotation), scale: mix(before.scale, after.scale) }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isVec3 = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number' && Number.isFinite(item))
const isTransform = (value: unknown): value is ObjectTransform => isRecord(value) && isVec3(value.position) && isVec3(value.rotation) && isVec3(value.scale)
const isSafeAssetPath = (path: unknown): path is string => typeof path === 'string' && path.startsWith('assets/') && !path.includes('\\') && path.split('/').every((part) => part && part !== '.' && part !== '..')
const validateProject = (value: unknown): value is { format: string; version: number; name: string; duration: number; assets: { key: string; path: string; resources: string[] }[]; nodes: SceneNode[]; objects: Record<string, ObjectTransform>; tracks: Keyframe[]; effects?: SceneEffect[]; pivots?: Record<string, [number, number, number]> } => {
  if (!isRecord(value) || value.format !== 'forge-scene' || value.version !== 1 || typeof value.name !== 'string') return false
  if (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 3600) return false
  const projectDuration = value.duration
  if (!Array.isArray(value.assets) || value.assets.length > 1 || !Array.isArray(value.nodes) || !Array.isArray(value.tracks)) return false
  if (value.effects !== undefined && (!Array.isArray(value.effects) || !value.effects.every(isSceneEffect))) return false
  if (value.pivots !== undefined && (!isRecord(value.pivots) || !Object.values(value.pivots).every(isVec3))) return false
  if (!value.assets.every((asset) => isRecord(asset) && typeof asset.key === 'string' && /^[a-zA-Z0-9_-]+$/.test(asset.key) && isSafeAssetPath(asset.path) && Array.isArray(asset.resources) && asset.resources.length > 0 && asset.resources.includes(asset.path) && new Set(asset.resources).size === asset.resources.length && asset.resources.every(isSafeAssetPath))) return false
  if (!value.nodes.every((node) => isRecord(node) && typeof node.id === 'string' && typeof node.name === 'string' && typeof node.type === 'string' && typeof node.visible === 'boolean' && (typeof node.parent === 'string' || node.parent === null))) return false
  const nodeIds = new Set(value.nodes.map((node) => (node as SceneNode).id))
  if (nodeIds.size !== value.nodes.length || value.nodes.some((node) => (node as SceneNode).parent !== null && !nodeIds.has((node as SceneNode).parent!))) return false
  const nodeById = new Map(value.nodes.map((node) => [(node as SceneNode).id, node as SceneNode]))
  for (const node of nodeById.values()) {
    const visited = new Set<string>([node.id])
    let parent = node.parent
    while (parent) {
      if (visited.has(parent)) return false
      visited.add(parent)
      parent = nodeById.get(parent)?.parent ?? null
    }
  }
  if (!isRecord(value.objects) || !Object.entries(value.objects).every(([id, transform]) => nodeIds.has(id) && isTransform(transform))) return false
  if (value.assets.length === 0 && (value.nodes.length !== 0 || Object.keys(value.objects).length !== 0 || value.tracks.length !== 0)) return false
  const effects = (value.effects ?? []) as SceneEffect[]
  const effectChannels = new Set<string>()
  for (const effect of effects) {
    const channel = effect.kind === 'particles' ? 'particles' : 'surface'
    const key = `${effect.targetId}:${channel}`
    if (effectChannels.has(key)) return false
    effectChannels.add(key)
  }
  const trackIds = new Set<string>()
  return value.tracks.every((track) => {
    if (!isRecord(track) || typeof track.id !== 'string' || trackIds.has(track.id) || typeof track.targetId !== 'string' || !nodeIds.has(track.targetId) || typeof track.time !== 'number' || !Number.isFinite(track.time) || track.time < 0 || track.time > projectDuration || !isVec3(track.position) || !isVec3(track.rotation) || !isVec3(track.scale)) return false
    trackIds.add(track.id)
    return true
  }) && effects.every((effect) => nodeIds.has(effect.targetId) && nodeById.get(effect.targetId)?.type === 'Mesh' && effect.endTime <= projectDuration)
    && Object.entries(isRecord(value.pivots) ? value.pivots : {}).every(([id]) => nodeIds.has(id) && nodeById.get(id)?.type === 'Mesh')
}
const runtimeSource = `import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as TSL from 'three/tsl';

const project = __FORGE_PROJECT__;
const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#111317');
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(4, 3, 6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x252a35, 2));
const key = new THREE.DirectionalLight(0xffffff, 3);
key.position.set(4, 7, 5);
scene.add(key);
const objects = new Map();
const effectMaterials = new Map();
const effectParticles = [];
const makeDissolveMaterial = (source, effect, geometry) => {
  const material = new THREE.MeshPhysicalNodeMaterial();
  const blockedProperties = new Set(['id', 'uuid', 'type', 'version', 'userData', '_listeners', 'needsUpdate']);
  for (const key of Object.keys(source)) {
    if (blockedProperties.has(key) || !(key in material)) continue;
    material[key] = key === 'userData' ? JSON.parse(JSON.stringify(source[key] ?? {})) : source[key];
  }
  const progress = TSL.uniform(0);
  const width = TSL.uniform(effect.edgeWidth);
  const seed = (effect.seed >>> 0) / 0xffffffff * 64;
  const sample = TSL.positionLocal.mul(3).add(TSL.vec3(seed, seed * 1.7, seed * 2.3));
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox ?? new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  const size = bounds.getSize(new THREE.Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
  const span = Math.max(size.getComponent(axis), 1e-5);
  const minimum = bounds.min.getComponent(axis);
  const position = axis === 0 ? TSL.positionLocal.x : axis === 1 ? TSL.positionLocal.y : TSL.positionLocal.z;
  const sweep = position.sub(minimum).div(span).clamp(0, 1);
  const noisySweep = sweep.add(TSL.mx_noise_float(sample).mul(0.08)).clamp(0, 1);
  const edge = TSL.float(1).sub(sweep.sub(progress).abs().smoothstep(0, width));
  material.opacityNode = noisySweep.smoothstep(progress.sub(width), progress.add(width));
  material.alphaTestNode = TSL.float(0.5);
  const glow = effect.kind === 'burn' ? TSL.color(effect.flameColor).mul(2.5) : TSL.color(effect.edgeColor);
  material.emissiveNode = TSL.emissive.add(glow.mul(edge));
  material.userData.forgeEffectProgress = progress;
  material.userData.forgeEffectWidth = width;
  return material;
};
for (const asset of project.assets) {
  const gltf = await new GLTFLoader().loadAsync('./' + asset.path);
  const root = gltf.scene;
  root.userData.forgeId = asset.key + ':root';
  const savedRoot = project.nodes.find((node) => node.id === root.userData.forgeId);
  if (savedRoot) root.visible = savedRoot.visible;
  root.traverse((object) => {
    if (object === root) return;
    const path = [];
    let node = object;
    while (node.parent && node.parent !== root) { path.unshift(node.parent.children.indexOf(node)); node = node.parent; }
    path.unshift(root.children.indexOf(node));
    object.userData.forgeId = asset.key + ':' + path.join('.');
    const saved = project.nodes.find((node) => node.id === object.userData.forgeId);
    if (saved) object.visible = saved.visible;
    const transform = project.objects?.[object.userData.forgeId];
    if (transform) { object.position.fromArray(transform.position); object.rotation.set(...transform.rotation); object.scale.fromArray(transform.scale); }
    objects.set(object.userData.forgeId, object);
  });
  const rootTransform = project.objects?.[root.userData.forgeId];
  if (rootTransform) { root.position.fromArray(rootTransform.position); root.rotation.set(...rootTransform.rotation); root.scale.fromArray(rootTransform.scale); }
  objects.set(root.userData.forgeId, root);
  scene.add(root);
}
for (const [id, pivot] of Object.entries(project.pivots ?? {})) {
  const object = objects.get(id);
  if (!object?.isMesh) continue;
  object.geometry = object.geometry.clone();
  object.geometry.translate(-pivot[0], -pivot[1], -pivot[2]);
}
const makeParticles = (mesh, effect) => {
  const source = mesh.geometry.getAttribute('position');
  if (!source?.count) return;
  let seed = effect.seed >>> 0;
  const random = () => { seed += 0x6D2B79F5; let next = seed; next = Math.imul(next ^ (next >>> 15), next | 1); next ^= next + Math.imul(next ^ (next >>> 7), next | 61); return ((next ^ (next >>> 14)) >>> 0) / 4294967296; };
  const count = effect.particleCount;
  const positions = new Float32Array(count * 3), velocities = new Float32Array(count * 3), phases = new Float32Array(count);
  const point = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    point.fromBufferAttribute(source, Math.floor(random() * source.count)); positions.set([point.x, point.y, point.z], i * 3);
    const velocity = new THREE.Vector3(random() * 2 - 1, 0.25 + random() * 0.9, random() * 2 - 1).normalize().multiplyScalar(0.22 + random() * 0.5);
    velocities.set([velocity.x, velocity.y, velocity.z], i * 3); phases[i] = random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('forgeVelocity', new THREE.Float32BufferAttribute(velocities, 3));
  geometry.setAttribute('forgePhase', new THREE.Float32BufferAttribute(phases, 1));
  const material = new THREE.PointsNodeMaterial({ size: effect.particleSize, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const timeNode = TSL.uniform(0), activeNode = TSL.uniform(0);
  const phase = TSL.attribute('forgePhase'), life = TSL.fract(phase.add(timeNode.mul(0.72)));
  const velocity = TSL.attribute('forgeVelocity', 'vec3'), sway = life.mul(6).add(phase).sin().mul(0.08);
  material.positionNode = TSL.positionLocal.add(velocity.mul(life)).add(TSL.vec3(sway, life.mul(0.8), sway.mul(0.65)));
  material.colorNode = TSL.color(effect.color).mul(TSL.float(0.7).add(life.mul(0.8)));
  material.opacityNode = activeNode.mul(TSL.smoothstep(0, 0.12, life)).mul(TSL.float(1).sub(TSL.smoothstep(0.82, 1, life)));
  material.needsUpdate = true;
  const points = new THREE.Points(geometry, material); points.frustumCulled = false; mesh.add(points);
  effectParticles.push({ effect, points, timeNode, activeNode });
};
for (const effect of project.effects ?? []) {
  const target = objects.get(effect.targetId);
  if (!target) continue;
  if (effect.kind === 'particles') { if (target.isMesh) makeParticles(target, effect); continue; }
  const materials = [];
  if (target.isMesh) {
    const object = target;
    const sources = Array.isArray(object.material) ? object.material : [object.material];
    const replacements = sources.map((source) => makeDissolveMaterial(source, effect, target.geometry));
    object.material = Array.isArray(object.material) ? replacements : replacements[0];
    materials.push(...replacements);
  }
  effectMaterials.set(effect.targetId, { effect, materials });
}
const tracks = project.tracks ?? [];
renderer.setAnimationLoop(render);
function render() {
  const time = (performance.now() / 1000) % project.duration;
  controls.update();
  const targets = new Set(tracks.map((track) => track.targetId));
  for (const id of targets) {
    const object = objects.get(id);
    const keys = tracks.filter((track) => track.targetId === id).sort((a, b) => a.time - b.time);
    if (!object || !keys.length) continue;
    const before = [...keys].reverse().find((track) => track.time <= time) ?? keys[0];
    const after = keys.find((track) => track.time > time) ?? before;
    const amount = after === before ? 0 : (time - before.time) / (after.time - before.time);
    for (const field of ['position', 'rotation', 'scale']) {
      object[field].fromArray(before[field].map((value, index) => value + (after[field][index] - value) * amount));
    }
  }
  for (const { effect, materials } of effectMaterials.values()) {
    const progress = time <= effect.startTime ? 0 : time >= effect.endTime ? 1 : (time - effect.startTime) / (effect.endTime - effect.startTime);
    for (const material of materials) {
      material.userData.forgeEffectProgress.value = progress;
      material.userData.forgeEffectWidth.value = effect.edgeWidth;
    }
  }
  for (const system of effectParticles) {
    system.timeNode.value = time - system.effect.startTime;
    system.activeNode.value = time >= system.effect.startTime && time <= system.effect.endTime ? 1 : 0;
  }
  renderer.render(scene, camera);
}
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
`

const createRuntimeSource = (project: unknown) => runtimeSource.replace('__FORGE_PROJECT__', JSON.stringify(project, null, 2))
void createRuntimeSource

function App() {
  const viewport = useRef<ViewportApi>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const appendFileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const nodeRowRefs = useRef(new Map<string, HTMLDivElement>())
  const timeRef = useRef(0)
  const [nodes, setNodes] = useState(initialNodes)
  const [selected, setSelected] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectionRef = useRef({ selected: '', ids: [] as string[] })
  selectionRef.current = { selected, ids: selectedIds }
  const [activeTool, setActiveTool] = useState<'select' | 'move' | 'rotate' | 'scale' | 'volume'>('select')
  const [boxSelect, setBoxSelect] = useState(false)
  const [envPreset, setEnvPreset] = useState<EnvironmentPresetId>('studio')
  const [xrEnabled, setXrEnabled] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [volumeBoxMode, setVolumeBoxModeState] = useState<'translate' | 'scale'>('translate')
  const [skeletonVisible, setSkeletonVisibleState] = useState(false)
  const [embeddedClips, setEmbeddedClips] = useState<Array<{ name: string; duration: number }>>([])
  const [activeClip, setActiveClip] = useState('')
  const [freeformMode, setFreeformModeState] = useState<'off' | 'extract' | 'delete'>('off')
  const [liveSyncActive, setLiveSyncActive] = useState(false)
  const [fps, setFps] = useState(60)
  const [activePovId, setActivePovId] = useState('')
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [loopMode, setLoopMode] = useState<'loop' | 'pingpong' | 'once'>('loop')
  const [gameSimActive, setGameSimActive] = useState(false)
  const [codeDrawerOpen, setCodeDrawerOpen] = useState(false)
  const [motionAxis, setMotionAxis] = useState<'x' | 'y' | 'z'>('x')
  const [keyBindings, setKeyBindings] = useState<Array<{ id: string; targetId: string; input: string; axis: 'x' | 'y' | 'z'; action: 'translate' | 'rotate' | 'hinge' | 'spin' | 'cameraPov' | 'playTimeline'; speed: number }>>([])
  const [newBindInput, setNewBindInput] = useState('w')
  const [newBindAxis, setNewBindAxis] = useState<'x' | 'y' | 'z'>('z')
  const [newBindAction, setNewBindAction] = useState<'translate' | 'rotate' | 'hinge' | 'spin' | 'cameraPov' | 'playTimeline'>('translate')
  const [newBindSpeed, setNewBindSpeed] = useState(1)
  const [connectedGamepad, setConnectedGamepad] = useState('')
  const gameKeysRef = useRef(new Set<string>())
  const toggledKeysRef = useRef(new Set<string>())
  const liveFileHandleRef = useRef<{ name?: string; getFile?: () => Promise<File>; createWritable?: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }> } | null>(null)
  const { canUndo, canRedo, pushState, undo, redo, clear: clearHistory } = useHistoryStore()

  useEffect(() => {
    let framesCount = 0
    let lastTime = performance.now()
    let rafId = 0
    const measureFps = (now: number) => {
      framesCount++
      if (now - lastTime >= 1000) {
        setFps(Math.min(240, Math.round((framesCount * 1000) / (now - lastTime))))
        framesCount = 0
        lastTime = now
      }
      rafId = requestAnimationFrame(measureFps)
    }
    rafId = requestAnimationFrame(measureFps)
    return () => cancelAnimationFrame(rafId)
  }, [])
  const [wireframe, setWireframe] = useState(false)
  const [objectStats, setObjectStats] = useState<ObjectStats | null>(null)
  const [transform, setTransform] = useState({ position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] })
  const [pivot, setPivotValue] = useState<[number, number, number]>([0, 0, 0])
  const [frames, setFrames] = useState<Keyframe[]>([])
  const [effects, setEffects] = useState<SceneEffect[]>([])
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(8)
  const [rendererLabel, setRendererLabel] = useState('Starting GPU…')
  const [rendererError, setRendererError] = useState('')
  const [toast, setToast] = useState('')
  const [projectName, setProjectName] = useState('Untitled scene')
  const [assetFiles, setAssetFiles] = useState<File[]>([])
  const [assetResourcePaths, setAssetResourcePaths] = useState<string[]>([])
  const [assetKey, setAssetKey] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(() => new Set())
  const selectedNode = nodes.find((node) => node.id === selected)
  const normalizedQuery = searchQuery.trim().toLowerCase()
  const matchingNodeIds = new Set(nodes.filter((node) => !normalizedQuery || node.name.toLowerCase().includes(normalizedQuery)).map((node) => node.id))
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  for (const id of [...matchingNodeIds]) {
    let parent = nodesById.get(id)?.parent
    while (parent && !matchingNodeIds.has(parent)) { matchingNodeIds.add(parent); parent = nodesById.get(parent)?.parent ?? null }
  }
  const visibleNodes = nodes.filter((node) => matchingNodeIds.has(node.id))
  const renderTreeNode = (node: SceneNode, depth = 0): ReactNode => {
    const children = visibleNodes.filter((item) => item.parent === node.id)
    const collapsed = collapsedNodes.has(node.id)
    return <div key={node.id}>
      <div ref={(element) => { if (element) nodeRowRefs.current.set(node.id, element); else nodeRowRefs.current.delete(node.id) }} className={`tree-row ${depth ? 'child' : ''} ${selectedIds.includes(node.id) ? 'selected' : ''}`} style={{ paddingLeft: 7 + depth * 14 }} onClick={(event) => selectNode(node.id, event.shiftKey || event.ctrlKey || event.metaKey)}>
        {children.length ? <button className="tree-expand" onClick={(event) => { event.stopPropagation(); setCollapsedNodes((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next }) }}>{collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button> : <span className="tree-expand-spacer" />}
        <Box size={depth ? 14 : 15} className={`tree-icon ${children.length ? 'group-icon' : ''}`} />
        <span>{node.name}</span>
        <button className="tree-eye" onClick={(event) => { event.stopPropagation(); toggleVisibility(node) }} title="Toggle visibility">{node.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
      </div>
      {!collapsed && children.map((child) => renderTreeNode(child, depth + 1))}
    </div>
  }

  const announce = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2600)
  }, [])

  useEffect(() => { folderInput.current?.setAttribute('webkitdirectory', '') }, [])

  useEffect(() => {
    if (!selected) { setObjectStats(null); return }
    setObjectStats(viewport.current?.getObjectStats(selected) ?? null)
    setPivotValue(viewport.current?.getPivot(selected) ?? [0, 0, 0])
    nodeRowRefs.current.get(selected)?.scrollIntoView({ block: 'nearest' })
  }, [selected, nodes])

  useEffect(() => { viewport.current?.setWireframe(wireframe) }, [wireframe, nodes])
  useEffect(() => { viewport.current?.setEffects(effects, time) }, [effects, time, nodes])

  useEffect(() => {
    let frame = 0
    let attempts = 0
    let cancelled = false
    const syncLiveScene = () => {
      if (cancelled) return
      const snapshot = viewport.current?.getProjectSnapshot()
      if (snapshot) {
        const { nodes: liveNodes } = snapshot
        setNodes(liveNodes)
        if (snapshot.assetKey && snapshot.files.length) {
          setAssetFiles(snapshot.files)
          setAssetResourcePaths(snapshot.resourcePaths)
          setAssetKey(snapshot.assetKey)
          const model = snapshot.files.find((file) => /\.(glb|gltf)$/i.test(file.name))
          if (model) setProjectName(model.name.replace(/\.(glb|gltf)$/i, ''))
        } else if (liveNodes[0]) setProjectName(liveNodes[0].name)
        if (!liveNodes.some((node) => node.id === selected)) {
          const nextId = liveNodes[0]?.id ?? ''
          setSelected(nextId)
          setSelectedIds(nextId ? [nextId] : [])
          selectionRef.current = { selected: nextId, ids: nextId ? [nextId] : [] }
          const nextTransform = nextId ? viewport.current?.getTransform(nextId) : null
          if (nextTransform) setTransform(nextTransform)
        }
        return
      }
      if (attempts++ < 300) frame = window.requestAnimationFrame(syncLiveScene)
    }
    frame = window.requestAnimationFrame(syncLiveScene)
    return () => { cancelled = true; window.cancelAnimationFrame(frame) }
  }, [])

  const commitHistorySnapshot = useCallback((overrideNodes?: SceneNode[], overrideFrames?: Keyframe[]) => {
    const snap = viewport.current?.captureSceneSnapshot?.()
    if (!snap) return
    pushState({
      nodes: overrideNodes ?? snap.nodes,
      transforms: snap.transforms,
      visibility: snap.visibility,
      pivots: snap.pivots,
      frames: overrideFrames ?? frames,
      selected: selectionRef.current.selected,
      selectedIds: selectionRef.current.ids,
      geometrySnapshot: snap.geometrySnapshot,
    })
  }, [frames, pushState])

  const handleUndo = useCallback(() => {
    const prev = undo()
    if (!prev) return
    viewport.current?.restoreSceneSnapshot?.(prev)
    setNodes(prev.nodes)
    setFrames(prev.frames)
    setSelected(prev.selected)
    setSelectedIds(prev.selectedIds)
    selectionRef.current = { selected: prev.selected, ids: prev.selectedIds }
    const nextTransform = prev.selected ? prev.transforms[prev.selected] ?? viewport.current?.getTransform(prev.selected) : null
    if (nextTransform) setTransform(nextTransform)
    if (prev.selected) setPivotValue(prev.pivots[prev.selected] ?? [0, 0, 0])
    announce('Undid last action')
  }, [undo, announce])

  const handleRedo = useCallback(() => {
    const next = redo()
    if (!next) return
    viewport.current?.restoreSceneSnapshot?.(next)
    setNodes(next.nodes)
    setFrames(next.frames)
    setSelected(next.selected)
    setSelectedIds(next.selectedIds)
    selectionRef.current = { selected: next.selected, ids: next.selectedIds }
    const nextTransform = next.selected ? next.transforms[next.selected] ?? viewport.current?.getTransform(next.selected) : null
    if (nextTransform) setTransform(nextTransform)
    if (next.selected) setPivotValue(next.pivots[next.selected] ?? [0, 0, 0])
    announce('Redid action')
  }, [redo, announce])

  useEffect(() => {
    const onGamepadConnected = (e: GamepadEvent) => {
      setConnectedGamepad(e.gamepad.id)
      announce(`Controller connected: ${e.gamepad.id}`)
    }
    const onGamepadDisconnected = () => {
      setConnectedGamepad('')
      announce('Controller disconnected')
    }
    window.addEventListener('gamepadconnected', onGamepadConnected)
    window.addEventListener('gamepaddisconnected', onGamepadDisconnected)
    return () => {
      window.removeEventListener('gamepadconnected', onGamepadConnected)
      window.removeEventListener('gamepaddisconnected', onGamepadDisconnected)
    }
  }, [announce])

  useEffect(() => {
    if (!gameSimActive) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (shouldIgnoreHistoryShortcut(e.target)) return
      const k = e.key.toLowerCase()
      gameKeysRef.current.add(k)
      if (toggledKeysRef.current.has(k)) toggledKeysRef.current.delete(k)
      else toggledKeysRef.current.add(k)

      for (const b of keyBindings) {
        if (b.input.toLowerCase() === k && b.action === 'playTimeline') {
          setPlaying((p) => !p)
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      gameKeysRef.current.delete(e.key.toLowerCase())
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    let raf = 0
    let prev = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000)
      prev = now
      const viewportBindings = keyBindings.filter((b): b is typeof b & { action: Exclude<typeof b.action, 'playTimeline'> } => b.action !== 'playTimeline')
      viewport.current?.stepUniversalInputs?.(gameKeysRef.current, toggledKeysRef.current, dt, viewportBindings)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      cancelAnimationFrame(raf)
      gameKeysRef.current.clear()
    }
  }, [gameSimActive, keyBindings])

  const duplicateSelection = useCallback(() => {
    if (!selectionRef.current.selected) return
    const updated = viewport.current?.duplicateObject?.(selectionRef.current.selected)
    if (updated) {
      setNodes(updated)
      setActiveTool('move')
      commitHistorySnapshot(updated)
      announce('Duplicated object (Ctrl+D) — drag Move arrows to place it in the world')
    }
  }, [commitHistorySnapshot, announce])

  const applyUniversalMotion = useCallback((kind: 'oscillate' | 'hinge' | 'impulse' | 'spin' | 'float' | 'damping') => {
    const targetId = selectionRef.current.selected
    if (!targetId) return
    const base = viewport.current?.getTransform(targetId) ?? transform
    const [px, py, pz] = base.position
    const [rx, ry, rz] = base.rotation
    const [sx, sy, sz] = base.scale
    const deg = (d: number) => (d * Math.PI) / 180
    const axIdx = motionAxis === 'x' ? 0 : motionAxis === 'y' ? 1 : 2
    const rotWith = (deltaRad: number): [number, number, number] => {
      const r: [number, number, number] = [rx, ry, rz]
      r[axIdx] += deltaRad
      return r
    }
    const posWith = (deltaPos: number): [number, number, number] => {
      const p: [number, number, number] = [px, py, pz]
      p[axIdx] += deltaPos
      return p
    }

    let generated: Keyframe[] = []
    if (kind === 'oscillate') {
      // Universal cyclic wave (limb stride, wing flap, tail wag, pendulum, breathing)
      generated = [
        { id: crypto.randomUUID(), targetId, time: 0, position: [px, py, pz], rotation: rotWith(-deg(30)), scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 0.5, position: [px, py, pz], rotation: rotWith(deg(30)), scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 1.0, position: [px, py, pz], rotation: rotWith(-deg(30)), scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 1.5, position: [px, py, pz], rotation: rotWith(deg(30)), scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 2.0, position: [px, py, pz], rotation: rotWith(-deg(30)), scale: [sx, sy, sz] },
      ]
    } else if (kind === 'hinge') {
      // Universal 90-degree joint / hinge swing & return
      generated = [
        { id: crypto.randomUUID(), targetId, time: 0, position: [px, py, pz], rotation: [rx, ry, rz], scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 1.0, position: [px, py, pz], rotation: rotWith(deg(85)), scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 2.0, position: [px, py, pz], rotation: [rx, ry, rz], scale: [sx, sy, sz] },
      ]
    } else if (kind === 'impulse') {
      // Universal spring impulse / bounce / recoil / pounce on selected axis
      generated = [
        { id: crypto.randomUUID(), targetId, time: 0, position: [px, py, pz], rotation: [rx, ry, rz], scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 0.2, position: posWith(-0.08), rotation: rotWith(-deg(18)), scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 0.55, position: posWith(0.03), rotation: rotWith(deg(6)), scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 1.0, position: [px, py, pz], rotation: [rx, ry, rz], scale: [sx, sy, sz] },
      ]
    } else if (kind === 'spin') {
      // Universal 360-degree continuous spin on selected axis
      generated = [
        { id: crypto.randomUUID(), targetId, time: 0, position: [px, py, pz], rotation: [rx, ry, rz], scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 2.0, position: [px, py, pz], rotation: rotWith(Math.PI * 2), scale: [sx, sy, sz] },
      ]
    } else if (kind === 'float') {
      // Universal smooth hover / bob / idle breathing along selected axis
      generated = [
        { id: crypto.randomUUID(), targetId, time: 0, position: [px, py, pz], rotation: [rx, ry, rz], scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 1.2, position: posWith(0.18), rotation: rotWith(deg(4)), scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 2.4, position: [px, py, pz], rotation: [rx, ry, rz], scale: [sx, sy, sz] },
      ]
    } else if (kind === 'damping') {
      // Universal acceleration / deceleration inertia tilt curve
      generated = [
        { id: crypto.randomUUID(), targetId, time: 0, position: [px, py, pz], rotation: [rx, ry, rz], scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 0.6, position: posWith(0.4), rotation: rotWith(-deg(8)), scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 1.4, position: posWith(1.1), rotation: rotWith(deg(10)), scale: [sx, sy, sz] },
        { id: crypto.randomUUID(), targetId, time: 2.2, position: posWith(1.3), rotation: [rx, ry, rz], scale: [sx, sy, sz] },
      ]
    }

    const nextFrames = [...frames.filter((f) => f.targetId !== targetId), ...generated].sort((a, b) => a.time - b.time)
    setFrames(nextFrames)
    setTime(0)
    timeRef.current = 0
    setPlaying(true)
    commitHistorySnapshot(undefined, nextFrames)
    announce(`Generated ${kind} motion curve on ${motionAxis.toUpperCase()} axis (${generated.length} keyframes)`)
  }, [transform, frames, motionAxis, commitHistorySnapshot, announce])

  const deleteSelection = useCallback(() => {
    const targets = selectionRef.current.ids.length ? selectionRef.current.ids : (selectionRef.current.selected ? [selectionRef.current.selected] : [])
    if (!targets.length) return
    const updated = viewport.current?.deleteSelectedObjects?.(targets)
    if (updated) {
      setNodes(updated)
      setSelected('')
      setSelectedIds([])
      selectionRef.current = { selected: '', ids: [] }
      commitHistorySnapshot(updated)
      announce(`Deleted ${targets.length} object(s) — press Ctrl+Z to undo`)
    }
  }, [commitHistorySnapshot, announce])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreHistoryShortcut(event.target)) return
      const action = matchHistoryShortcut(event)
      if (action === 'undo') {
        event.preventDefault()
        handleUndo()
      } else if (action === 'redo') {
        event.preventDefault()
        handleRedo()
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        deleteSelection()
      } else if (event.key.toLowerCase() === 'd' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        duplicateSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleUndo, handleRedo, deleteSelection])

  const updateTransform = (group: 'position' | 'rotation' | 'scale', index: number, value: number) => {
    setTransform((current) => {
      const next = { ...current, [group]: [...current[group]] as [number, number, number] }
      next[group][index] = value
      viewport.current?.setTransform(selected, next)
      return next
    })
    commitHistorySnapshot()
  }

  const selectNode = useCallback((id: string, additive = false) => {
    const selection = toggleSelection({ primary: selectionRef.current.selected, ids: selectionRef.current.ids }, id, additive)
    selectionRef.current = { selected: selection.primary, ids: selection.ids }
    setSelectedIds(selection.ids)
    setSelected(selection.primary)
    const next = selection.primary ? viewport.current?.getTransform(selection.primary) : null
    if (next) setTransform(next)
  }, [])

  const selectMany = useCallback((ids: string[], additive: boolean) => {
    const selection = mergeSelection({ primary: selectionRef.current.selected, ids: selectionRef.current.ids }, ids, additive)
    selectionRef.current = { selected: selection.primary, ids: selection.ids }
    setSelectedIds(selection.ids)
    setSelected(selection.primary)
    const next = selection.primary ? viewport.current?.getTransform(selection.primary) : null
    if (next) setTransform(next)
  }, [])

  const seek = useCallback((nextTime: number) => {
    timeRef.current = nextTime
    setTime(nextTime)
    if (activeClip) {
      viewport.current?.setActiveAnimationClip?.(activeClip, nextTime)
    }
    const targetIds = new Set(frames.map((item) => item.targetId))
    for (const targetId of targetIds) {
      const frame = mixFrame(frames.filter((item) => item.targetId === targetId).sort((a, b) => a.time - b.time), nextTime)
      if (frame) viewport.current?.setTransform(targetId, { position: frame.position, rotation: frame.rotation, scale: frame.scale })
    }
    if (activePovId) {
      viewport.current?.setActivePovCamera?.(activePovId)
    }
    const selectedFrame = mixFrame(frames.filter((item) => item.targetId === selected).sort((a, b) => a.time - b.time), nextTime)
    if (selectedFrame) setTransform({ position: selectedFrame.position, rotation: selectedFrame.rotation, scale: selectedFrame.scale })
  }, [frames, selected])

  const addKeyframe = () => {
    if (!selectedNode) return
    const targets = selectedIds.length ? selectedIds : [selected]
    const keyframes = targets.flatMap((targetId) => {
      const targetTransform = viewport.current?.getTransform(targetId)
      return targetTransform ? [{ id: crypto.randomUUID(), targetId, time, ...targetTransform }] : []
    })
    const nextFrames = [...frames.filter((frame) => !targets.includes(frame.targetId) || Math.abs(frame.time - time) > 0.001), ...keyframes].sort((a, b) => a.time - b.time)
    setFrames(nextFrames)
    commitHistorySnapshot(undefined, nextFrames)
    announce(`${keyframes.length} keyframe${keyframes.length === 1 ? '' : 's'} added at ${time.toFixed(2)}s`)
  }

  const loadFile = async (file?: File, resources: File[] = file ? [file] : [], append = false) => {
    if (!file) return
    if (!/\.(glb|gltf)$/i.test(file.name)) { announce('Choose a .glb or .gltf file'); return }
    if (file.size > 100 * 1024 * 1024) { announce('Model files must be 100 MB or smaller'); return }
    if (resources.reduce((total, resource) => total + resource.size, 0) > 150 * 1024 * 1024) { announce('Model and dependency files must total 150 MB or less'); return }
    if (resources.filter((resource) => /\.(glb|gltf)$/i.test(resource.name)).length > 1) { announce('Select one GLB/glTF model and its companion files'); return }
    try {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      const key = `model-${Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
      const imported = await viewport.current?.loadModel(file, key, resources, resources.map(resourcePath), append)
      if (!imported) return
      if (!append) clearHistory()
      const nextNodes = [...initialNodes, ...imported]
      setNodes(nextNodes)
      if (!append) {
        setFrames([])
        setEffects([])
        setPlaying(false)
        setProjectName(file.name.replace(/\.(glb|gltf)$/i, ''))
        setAssetFiles(resources)
        setAssetResourcePaths(resources.map(resourcePath))
        setAssetKey(key)
      }
      const clips = viewport.current?.getAnimationClips?.() ?? []
      setEmbeddedClips(clips)
      if (!append) {
        setActiveClip('')
        setSkeletonVisibleState(false)
      }
      const newlySelected = imported[imported.length - 1]?.id ?? imported[0]?.id
      if (newlySelected) selectNode(newlySelected)
      if (append) setActiveTool('move')
      commitHistorySnapshot(nextNodes, append ? frames : [])
      announce(append ? `Added ${file.name} into current 3D world!` : (clips.length ? `${file.name} imported (${clips.length} animation clip(s) found)` : `${file.name} imported`))
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not load this model')
    }
  }

  const toggleVisibility = (node: SceneNode) => {
    const visible = !node.visible
    const nextNodes = nodes.map((item) => item.id === node.id ? { ...item, visible } : item)
    setNodes(nextNodes)
    viewport.current?.setVisible(node.id, visible)
    commitHistorySnapshot(nextNodes)
  }

  const addSurfaceEffect = (kind: 'dissolve' | 'burn') => {
    if (!selectedNode || selectedNode.type !== 'Mesh') return
    const existing = effects.find((effect) => effect.targetId === selected && isSurfaceEffect(effect))
    if (existing) {
      setEffects((current) => current.filter((effect) => effect !== existing))
      announce(`${existing.kind === 'burn' ? 'Burn' : 'Dissolve'} removed`)
      return
    }
    const startTime = Math.min(time, Math.max(0, duration - 0.1))
    const common = { targetId: selected, startTime, endTime: duration, edgeColor: kind === 'burn' ? '#ff7a27' : '#b7f36b', edgeWidth: 0.08, seed: Math.floor(Math.random() * 0xffffffff) }
    const effect: SurfaceEffect = kind === 'burn' ? { ...common, kind, flameColor: '#ffb02e' } : { ...common, kind }
    setEffects((current) => [...current.filter((item) => item.targetId !== selected || !isSurfaceEffect(item)), effect])
    announce(`${kind === 'burn' ? 'Burn' : 'Dissolve'} added. Scrub the timeline to preview it.`)
  }
  const addParticles = () => {
    if (!selectedNode || selectedNode.type !== 'Mesh') return
    const existing = effects.find((effect) => effect.targetId === selected && effect.kind === 'particles')
    if (existing) {
      setEffects((current) => current.filter((effect) => effect !== existing))
      announce('Particles removed')
      return
    }
    const startTime = Math.min(time, Math.max(0, duration - 0.1))
    setEffects((current) => [...current, { kind: 'particles', targetId: selected, startTime, endTime: duration, color: '#ff9b36', particleCount: 256, particleSize: 14, seed: Math.floor(Math.random() * 0xffffffff) }])
    announce('GPU particle effect added')
  }
  const updateEffect = (kind: SceneEffect['kind'], changes: Partial<SceneEffect>) => {
    setEffects((current) => current.map((effect) => effect.targetId === selected && (effect.kind ?? 'dissolve') === kind ? { ...effect, ...changes } as SceneEffect : effect))
  }

  const createProjectData = () => {
    return buildProjectData({
      projectName,
      duration,
      assetKey,
      assetFiles,
      assetResourcePaths,
      nodes,
      transforms: viewport.current?.getTransforms() ?? {},
      frames,
      effects,
      pivots: viewport.current?.getPivots() ?? {},
      cameraPose: viewport.current?.getCameraPose() ?? undefined,
      envPreset,
      xrEnabled,
    })
  }

  const buildCurrentManifest = useCallback(() => {
    const resolved = assetFiles.length ? resolveExportAssetPath(assetFiles, assetResourcePaths, projectName) : { manifestAssetPath: `./assets/${slug(projectName || 'model')}.glb` }
    const manifest = createDefaultManifest(projectName || 'ForgeScene', resolved.manifestAssetPath)
    const cam = viewport.current?.getCameraPose()
    if (cam) {
      manifest.camera.position = cam.position
      manifest.camera.target = cam.target
      manifest.camera.fov = cam.fov
    }
    manifest.environment.preset = envPreset
    manifest.environment.xrEnabled = xrEnabled
    const transforms = viewport.current?.getTransforms() ?? {}
    const pivots = viewport.current?.getPivots() ?? {}
    manifest.nodes = nodes.map((n) => {
      const t = transforms[n.id] ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
      return { forgeId: n.id, name: n.name, parentId: n.parent, type: n.type, visible: n.visible, pivot: pivots[n.id], ...t }
    })
    manifest.keyframes = frames
    manifest.loopMode = loopMode
    return manifest
  }, [assetFiles, assetResourcePaths, projectName, envPreset, xrEnabled, nodes, frames, loopMode])

  const formatSyncedOutput = useCallback((fileName: string | undefined, existingText: string, manifest: ReturnType<typeof buildCurrentManifest>) => {
    const lower = (fileName ?? '').toLowerCase()
    if (lower.endsWith('.json')) {
      return JSON.stringify(manifest, null, 2)
    }
    if (lower.endsWith('.js')) {
      try {
        return generateRuntimeJs(createProjectData())
      } catch {
        return `// Forge 3D Scene Config\nexport const FORGE_MANIFEST = ${JSON.stringify(manifest, null, 2)};\n`
      }
    }
    return existingText.trim() ? patchR3FFile(existingText, manifest) : generateR3FComponent(manifest)
  }, [])

  const triggerLiveCodeSync = useCallback(async () => {
    try {
      const manifest = buildCurrentManifest()
      const r3fCode = generateR3FComponent(manifest)
      if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'forge:syncManifest', manifest, r3fCode }, '*')
      }
      const win = window as unknown as { showSaveFilePicker?: (opts: unknown) => Promise<typeof liveFileHandleRef.current> }
      if (!liveFileHandleRef.current && typeof win.showSaveFilePicker === 'function') {
        liveFileHandleRef.current = await win.showSaveFilePicker({
          suggestedName: `${slug(projectName || 'ForgeScene')}.tsx`,
          types: [
            { description: 'React Three Fiber (.tsx)', accept: { 'text/typescript': ['.tsx'] } },
            { description: 'Vanilla Three.js Module (.js)', accept: { 'text/javascript': ['.js'] } },
            { description: 'Universal Scene Manifest (.json)', accept: { 'application/json': ['.json'] } },
          ],
        })
      }
      if (liveFileHandleRef.current?.createWritable) {
        let existingText = ''
        let targetName = liveFileHandleRef.current.name
        if (liveFileHandleRef.current.getFile) {
          try {
            const existingFile = await liveFileHandleRef.current.getFile()
            targetName = existingFile.name
            existingText = await existingFile.text()
          } catch { /* new file */ }
        }
        const output = formatSyncedOutput(targetName, existingText, manifest)
        const writable = await liveFileHandleRef.current.createWritable()
        await writable.write(output)
        await writable.close()
        setLiveSyncActive(true)
        announce(`Live synced scene, camera & animations to ${targetName || 'code file'}!`)
        return
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(r3fCode)
        setLiveSyncActive(true)
        announce('Copied live R3F (.tsx) code to clipboard & notified IDE')
      }
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Live sync cancelled')
    }
  }, [buildCurrentManifest, formatSyncedOutput, projectName, announce])

  useEffect(() => {
    if (!liveSyncActive || !liveFileHandleRef.current?.createWritable) return
    const timer = window.setTimeout(async () => {
      try {
        const manifest = buildCurrentManifest()
        let existingText = ''
        let targetName = liveFileHandleRef.current?.name
        if (liveFileHandleRef.current?.getFile) {
          const existingFile = await liveFileHandleRef.current.getFile()
          targetName = existingFile.name
          existingText = await existingFile.text()
        }
        const output = formatSyncedOutput(targetName, existingText, manifest)
        const writable = await liveFileHandleRef.current!.createWritable!()
        await writable.write(output)
        await writable.close()
      } catch { /* ignore background sync error */ }
    }, 350)
    return () => window.clearTimeout(timer)
  }, [liveSyncActive, buildCurrentManifest, formatSyncedOutput])
  const saveR3FCode = () => {
    try {
      const project = createProjectData()
      const resolved = resolveExportAssetPath(assetFiles, assetResourcePaths, projectName)
      const manifest = createDefaultManifest(projectName || 'ForgeScene', resolved.manifestAssetPath)
      const cam = viewport.current?.getCameraPose()
      if (cam) {
        manifest.camera.position = cam.position
        manifest.camera.target = cam.target
        manifest.camera.fov = cam.fov
      }
      manifest.environment.preset = envPreset
      manifest.environment.xrEnabled = xrEnabled
      const transforms = viewport.current?.getTransforms() ?? {}
      const pivots = viewport.current?.getPivots() ?? {}
      manifest.nodes = project.nodes.map((n) => {
        const t = transforms[n.id] ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
        return { forgeId: n.id, name: n.name, parentId: n.parent, type: n.type, visible: n.visible, pivot: pivots[n.id], ...t }
      })
      manifest.keyframes = frames
      const code = generateR3FComponent(manifest)
      downloadBlob(new Blob([code], { type: 'text/plain;charset=utf-8' }), `${slug(projectName || 'ForgeScene')}.tsx`)
      setExportMenuOpen(false)
      announce('Exported React Three Fiber (.tsx)')
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not export R3F component')
    }
  }

  const saveRuntimeCode = async () => {
    try {
      const project = createProjectData()
      downloadBlob(new Blob([generateRuntimeJs(project)], { type: 'text/javascript;charset=utf-8' }), `${slug(projectName)}.forge.js`)
      setExportMenuOpen(false)
      announce('Three.js animation module (.forge.js) exported. Keep its assets/ folder paths beside it.')
    } catch (error) { announce(error instanceof Error ? error.message : 'Could not export Three.js code') }
  }

  const saveProject = async () => {
    let project: ReturnType<typeof createProjectData>
    try { project = createProjectData() }
    catch (error) { announce(error instanceof Error ? error.message : 'Could not save this project'); return }
    try {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      const entries = buildExportZipEntries({
        projectName,
        duration,
        assetKey,
        assetFiles,
        assetResourcePaths,
        nodes,
        transforms: viewport.current?.getTransforms() ?? {},
        frames,
        effects,
        pivots: viewport.current?.getPivots() ?? {},
        cameraPose: viewport.current?.getCameraPose() ?? undefined,
        envPreset,
        xrEnabled,
      })
      for (const entry of entries) {
        zip.file(entry.path, entry.content as string | File)
      }
      void project
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      downloadBlob(blob, `${slug(projectName)}.forge.zip`)
      setExportMenuOpen(false)
      announce('Portable project (.forge.zip) saved')
    } catch (error) { announce(error instanceof Error ? error.message : 'Could not create project export') }
  }

  const openProject = async (file?: File) => {
    if (!file) return
    if (file.size > 150 * 1024 * 1024) { announce('Project files must be 150 MB or smaller'); return }
    try {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(file)
      const projectFile = zip.file('project.json')
      if (!projectFile) throw new Error('This archive does not contain project.json')
      const project: unknown = JSON.parse(await projectFile.async('text'))
      if (isRecord(project) && Array.isArray(project.assets)) {
        project.objects ??= {}
        project.assets = project.assets.map((asset) => isRecord(asset) && typeof asset.path === 'string' ? { ...asset, resources: asset.resources ?? [asset.path] } : asset)
      }
      if (!validateProject(project)) throw new Error('Unsupported or invalid Forge project file')
      const projectNodes = project.nodes
      if (!viewport.current) throw new Error('The 3D viewport is still starting. Try opening the project again in a moment.')
      let loadedNodes: SceneNode[] = []
      let loadedFiles: File[] = []
      let loadedResourcePaths: string[] = []
      let loadedKey = ''
      if (project.assets[0]) {
        const modelPath = project.assets[0].path
        if (!zip.file(modelPath) || !/\.(glb|gltf)$/i.test(modelPath)) throw new Error('The project model asset is missing or has an unsupported format')
        const resourcePaths = project.assets[0].resources?.length ? project.assets[0].resources : [modelPath]
        for (const path of resourcePaths) {
          const entry = zip.file(path)
          if (!entry) throw new Error(`Project asset is missing: ${path}`)
          const blob = await entry.async('blob')
          if (blob.size > 100 * 1024 * 1024) throw new Error('An embedded project asset exceeds the 100 MB limit')
          loadedFiles.push(new File([blob], path.split('/').pop() ?? 'asset.bin', { type: path === modelPath ? (modelPath.toLowerCase().endsWith('.gltf') ? 'model/gltf+json' : 'model/gltf-binary') : blob.type }))
          loadedResourcePaths.push(path.replace(/^assets\//, ''))
        }
        if (loadedFiles.reduce((total, resource) => total + resource.size, 0) > 150 * 1024 * 1024) throw new Error('Embedded project assets total more than 150 MB')
        const modelIndex = resourcePaths.indexOf(modelPath)
        loadedFiles = [loadedFiles[modelIndex], ...loadedFiles.filter((_, index) => index !== modelIndex)]
        loadedResourcePaths = [loadedResourcePaths[modelIndex], ...loadedResourcePaths.filter((_, index) => index !== modelIndex)]
        loadedKey = project.assets[0].key
        loadedNodes = await viewport.current.loadModel(loadedFiles[0], loadedKey, loadedFiles, loadedResourcePaths)
        for (const node of loadedNodes) {
          const saved = projectNodes.find((item) => item.id === node.id)
          if (saved) viewport.current?.setVisible(node.id, saved.visible)
        }
        for (const [id, value] of Object.entries(project.objects ?? {})) viewport.current?.setTransform(id, value)
        for (const [id, value] of Object.entries(project.pivots ?? {})) viewport.current?.setPivot(id, value, false)
      } else {
        viewport.current.clearImported()
        setSelected('')
        setSelectedIds([])
        selectionRef.current = { selected: '', ids: [] }
        setTransform({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
      }
      setNodes([...initialNodes, ...loadedNodes.map((node) => ({ ...node, visible: projectNodes.find((item) => item.id === node.id)?.visible ?? node.visible }))])
      setFrames(project.tracks)
      setEffects(project.effects ?? [])
      setProjectName(project.name || 'Untitled scene')
      setDuration(project.duration)
      setAssetFiles(loadedFiles)
      setAssetResourcePaths(loadedResourcePaths)
      setAssetKey(loadedKey)
      setTime(0)
      timeRef.current = 0
      if (loadedNodes[0]) selectNode(loadedNodes[0].id)
      announce('Project opened')
    } catch (error) { announce(error instanceof Error ? error.message : 'Could not open project') }
  }

  const filteredFrames = frames.filter((frame) => frame.targetId === selected)
  const framePositions = useMemo(() => filteredFrames.map((frame) => ({ ...frame, left: `${(frame.time / duration) * 100}%` })), [filteredFrames, duration])

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const toolButtons = [
    { id: 'select' as const, icon: MousePointer2, label: 'Select' },
    { id: 'move' as const, icon: Move3D, label: 'Move' },
    { id: 'rotate' as const, icon: Rotate3D, label: 'Rotate' },
    { id: 'scale' as const, icon: Box, label: 'Scale' },
    { id: 'volume' as const, icon: Scan, label: '3D Box Volume Selector' },
  ]

  useEffect(() => {
    if (!playing) return
    let frameId = 0
    let previous = performance.now()
    let elapsed = timeRef.current
    const tick = (now: number) => {
      const delta = ((now - previous) / 1000) * playbackSpeed
      previous = now
      if (elapsed + delta >= duration) {
        if (loopMode === 'once') {
          seek(duration)
          setPlaying(false)
          return
        }
        elapsed = 0
      } else {
        elapsed += delta
      }
      seek(elapsed)
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [playing, duration, seek, playbackSpeed, loopMode])

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Cuboid size={17} strokeWidth={1.8} /></div><span>forge</span><span className="brand-tag">BETA</span><div className="top-divider" /></div>
      <button className="project-title" onClick={() => { const name = window.prompt('Project name', projectName); if (name?.trim()) setProjectName(name.trim()) }}><span>{projectName}</span><ChevronDown size={14} /></button>
      <div className="save-status"><span className="status-dot" /> Local session</div>
      <div className="top-actions">
        <button className="icon-button topbar-pill" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={handleUndo}><Undo2 size={14} /><span>Undo</span></button>
        <button className="icon-button topbar-pill" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!canRedo} onClick={handleRedo}><Redo2 size={14} /><span>Redo</span></button>
        <button className={`icon-button topbar-pill ${codeDrawerOpen ? 'chosen' : ''}`} title="Add selected object, camera, and keybindings into your code" aria-label="Add to Code" onClick={() => setCodeDrawerOpen((v) => !v)}><Plus size={14} /><span>Add to Code</span></button>
        <button className={`icon-button topbar-pill ${liveSyncActive ? 'chosen' : ''}`} title="Live sync scene, camera, and cuts directly to your .tsx/.js/.json code file" aria-label="Sync Code" onClick={() => { void triggerLiveCodeSync() }}><Code2 size={14} /><span>{liveSyncActive ? 'Live Synced' : 'Sync Code'}</span></button>
        <button className="icon-button" title="Open project" aria-label="Open project" onClick={() => projectInput.current?.click()}><FolderOpen size={16} /></button>
        <div className="export-dropdown">
          <button className="icon-button topbar-pill" title="Export scene" aria-label="Export" aria-expanded={exportMenuOpen} onClick={() => setExportMenuOpen((open) => !open)}><Download size={14} /><span>Export</span><ChevronDown size={13} /></button>
          {exportMenuOpen && <div className="export-menu" role="menu">
            <button role="menuitem" onClick={saveR3FCode}><span>React Three Fiber</span><strong>.tsx</strong></button>
            <button role="menuitem" onClick={() => { void saveRuntimeCode() }}><span>Three.js Runtime</span><strong>.forge.js</strong></button>
            <button role="menuitem" onClick={() => { void saveProject() }}><span>Project Archive</span><strong>.forge.zip</strong></button>
          </div>}
        </div>
      </div>
    </header>

    <div className="workspace">
      <aside className="left-rail"><div className="rail-group"><button className="rail-button active" title="Scene hierarchy"><Layers3 size={18} /></button><button className="rail-button" title="Import 3D asset" onClick={() => fileInput.current?.click()}><Box size={18} /></button><button className="rail-button" title="Open saved project (.forge.zip)" onClick={() => projectInput.current?.click()}>< Code2 size={18} /></button></div></aside>

      <aside className="scene-panel panel">
        <div className="panel-heading"><div><span className="eyebrow">PROJECT</span><h1>Scene</h1></div></div>
        <div className="scene-search"><Search size={14} /><input placeholder="Find an object..." value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} /></div>
        <div className="tree-toolbar"><span>HIERARCHY <span className="muted-count">{nodes.length}</span></span><div style={{ display: 'flex', gap: 4 }}><button className="icon-button small" title="Add Scene Camera (for cinematics & POV)" aria-label="Add Scene Camera" onClick={() => { const camNode = viewport.current?.addSceneCamera?.(); if (camNode) { commitHistorySnapshot(); announce(`${camNode.name} added at current view`) } }}><Video size={14} /></button><button className="icon-button small" title="Import model" onClick={() => fileInput.current?.click()}><Plus size={16} /></button></div></div>
        <div className="scene-tree">
          {visibleNodes.filter((node) => !node.parent || !nodes.some((parent) => parent.id === node.parent)).map((root) => renderTreeNode(root))}
          {nodes.length === 0 && <div className="empty-tree">Import a GLB or glTF model to populate the hierarchy.</div>}
          {nodes.length > 0 && visibleNodes.length === 0 && <div className="empty-tree">No objects match “{searchQuery}”.</div>}
        </div>
        <div className="panel-bottom"><div className="assets-label"><span className="eyebrow">ASSETS & WORLD</span><button className="icon-button small" onClick={() => appendFileInput.current?.click()} title="Add another 3D model into the current world"><Plus size={15} /></button></div><button className="asset-drop" onClick={() => fileInput.current?.click()}><div className="asset-icon"><FilePlus2 size={18} /></div><span><strong>Import 3D model</strong><small>GLB or glTF · or Drag & Drop onto viewport</small></span><Upload size={15} /></button><div style={{ display: 'flex', gap: 6, marginTop: 6 }}><button className="effect-action" onClick={() => appendFileInput.current?.click()} title="Add another GLB/glTF model into the current 3D scene without replacing the map">+ Add Model to World</button><button className="effect-action" disabled={!selectedNode} onClick={duplicateSelection} title="Duplicate selected model or part (Ctrl+D)">Duplicate (Ctrl+D)</button></div><button className={`effect-action ${gameSimActive ? 'chosen' : ''}`} style={{ marginTop: 6 }} onClick={() => { const next = !gameSimActive; setGameSimActive(next); if (next) { const summary = keyBindings.length ? keyBindings.map((b) => `[${b.input.toUpperCase()}] → ${nodes.find((n) => n.id === b.targetId)?.name ?? b.targetId} (${b.action} ${b.axis.toUpperCase()})`).join(' · ') : 'Map Keyboard or Gamepad (PS / Xbox / Drone RC) inputs under CONTROLLER & INPUT MAPPING'; announce(`Live Input Test On: ${summary}`) } else announce('Live Input Test Off') }} title="Test mapped Keyboard & Gamepad (PlayStation, Xbox, Drone RC) controls live">{gameSimActive ? '■ Stop Input Test' : `▶ Test Inputs & Gamepad (${keyBindings.length})`}</button><button className="folder-import" onClick={() => folderInput.current?.click()}>Choose a glTF folder with its textures</button></div>
      </aside>

      <section className="center-column">
        <div className="viewport-toolbar">
          <div className="tool-set">
            {toolButtons.map(({ id, icon: Icon, label }) => <button key={id} className={`tool-button ${activeTool === id ? 'chosen' : ''}`} title={label} aria-label={label} onClick={() => { setBoxSelect(false); setActiveTool(id); if (id === 'volume') viewport.current?.setVolumeBoxMode?.(volumeBoxMode) }}><Icon size={16} /></button>)}
            <button className={`tool-button ${boxSelect ? 'chosen' : ''}`} title="2D Marquee Select (or Alt+Drag)" aria-label="2D Marquee Select" aria-pressed={boxSelect} onClick={() => { setActiveTool('select'); setBoxSelect((value) => !value) }}><SquareDashed size={15} /></button>
          </div>
          {activeTool === 'volume' && <>
            <div className="tool-divider" />
            <button className={`tool-button toolbar-select ${volumeBoxMode === 'translate' ? 'chosen' : ''}`} title="Move 3D selection box" onClick={() => { setVolumeBoxModeState('translate'); viewport.current?.setVolumeBoxMode?.('translate') }}>Move 3D Box</button>
            <button className={`tool-button toolbar-select ${volumeBoxMode === 'scale' ? 'chosen' : ''}`} title="Resize 3D selection box" onClick={() => { setVolumeBoxModeState('scale'); viewport.current?.setVolumeBoxMode?.('scale') }}>Resize 3D Box</button>
            <button className="tool-button toolbar-select" title="Extract triangles inside 3D volume box into a new part" onClick={() => { const res = viewport.current?.extractBoxSelection?.(); if (res && res.extractedCount > 0) { setActiveTool('move'); commitHistorySnapshot(); announce(`Extracted ${res.extractedCount} triangles into ${res.extractedIds.length} movable part(s)`) } else announce('Position the 3D Box over mesh geometry to extract triangles') }}>Extract Part</button>
            <button className="tool-button toolbar-select" title="Erase/delete all geometry inside the 3D Box (great for removing unwanted sections of a 3D world)" onClick={() => { const res = viewport.current?.deleteBoxSelection?.(); if (res && res.deletedCount > 0) { commitHistorySnapshot(); announce(`Erased ${res.deletedCount} triangles inside 3D Box — press Ctrl+Z to undo`) } else announce('Position the 3D Box over geometry you want to erase') }}>Erase Box Region</button>
          </>}
          <div className="tool-divider" />
          <button className={`tool-button toolbar-select ${freeformMode === 'extract' ? 'chosen' : ''}`} title="Draw a freehand 2D lasso loop on screen to cut & extract an irregular part" onClick={() => { const next = freeformMode === 'extract' ? 'off' : 'extract'; setFreeformModeState(next); viewport.current?.setFreeformMode?.(next); if (next !== 'off') announce('Freeform Lasso Extract: drag a loop on the model to cut out a part') }}>Lasso Cut</button>
          <button className={`tool-button toolbar-select ${freeformMode === 'delete' ? 'chosen' : ''}`} title="Draw a freehand 2D lasso loop on screen to erase unwanted geometry" onClick={() => { const next = freeformMode === 'delete' ? 'off' : 'delete'; setFreeformModeState(next); viewport.current?.setFreeformMode?.(next); if (next !== 'off') announce('Freeform Lasso Erase: drag a loop on the model to delete that area') }}>Lasso Erase</button>
          {nodes.some((n) => n.type === 'Bone') && <button className={`tool-button toolbar-select ${skeletonVisible ? 'chosen' : ''}`} title="Show 3D Skeleton & Bones for rigging and custom animations" onClick={() => { const next = !skeletonVisible; setSkeletonVisibleState(next); viewport.current?.setSkeletonVisible?.(next); announce(next ? 'Skeleton bones visible — select any Bone in Hierarchy to rotate & keyframe it' : 'Skeleton hidden') }}>Skeleton</button>}
          <div className="tool-divider" />
          <div className="view-select"><Grid2X2 size={15} /> Perspective</div>
          <select aria-label="Environment preset" title="Environment preset" className="tool-button toolbar-select" value={envPreset} onChange={(e) => { const next = e.target.value as EnvironmentPresetId; setEnvPreset(next); viewport.current?.applyEnvironmentPreset(next); announce(`Environment: ${next}`) }}><option value="studio">Studio</option><option value="sunset">Sunset</option><option value="night">Night</option><option value="warehouse">Warehouse</option><option value="xr-stage">XR Stage</option></select>
          <button className={`tool-button toolbar-select ${xrEnabled ? 'chosen' : ''}`} title="Toggle WebXR export support" aria-pressed={xrEnabled} onClick={() => { setXrEnabled((v) => !v); announce(`WebXR export ${!xrEnabled ? 'enabled' : 'disabled'}`) }}>WebXR</button>
          <div className="viewport-right"><span className="gpu-chip" title="Live Frames Per Second">{fps} FPS</span><span className="gpu-chip"><span className="gpu-light" />{rendererLabel}</span><button className={`tool-button ${wireframe ? 'chosen' : ''}`} title="Toggle wireframe" aria-pressed={wireframe} onClick={() => setWireframe((value) => !value)}><Triangle size={15} /></button><button className="tool-button" title="Frame selected object" disabled={!selectedNode} onClick={() => viewport.current?.frameObject(selected)}><Maximize2 size={15} /></button></div>
        </div>
        <div className="viewport-wrap" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }} onDrop={(e) => { e.preventDefault(); const files = Array.from(e.dataTransfer.files ?? []); const model = files.find((f) => /\.(glb|gltf)$/i.test(f.name)); if (model) void loadFile(model, files, nodes.length > 0) }}><Suspense fallback={<div className="scene-host"><div className="scene-loading"><div className="loading-mark">◈</div><span>Loading GPU viewport</span><small>Preparing renderer and scene</small></div></div>}><SceneViewport ref={viewport} selectedId={selected} selectedIds={selectedIds} activeTool={activeTool} boxSelect={boxSelect} onSelect={selectNode} onSelectMany={selectMany} onNodesChange={setNodes} onRendererChange={setRendererLabel} onRendererError={setRendererError} onTransformChange={setTransform} onTransformCommit={() => commitHistorySnapshot()} /></Suspense>{rendererError && <div className="renderer-error"><strong>3D preview unavailable</strong><span>{rendererError}</span><small>Try a browser with WebGPU or WebGL 2 support and enable hardware acceleration.</small></div>}<div className="viewport-caption"><span><span className="live-dot" /> LIVE PREVIEW</span><span>{activeTool === 'volume' ? 'Move or resize the 3D Box · Click Extract Part to split selected triangles' : boxSelect ? 'Drag over parts · Shift adds · right-to-left crosses' : 'Click to select · Alt+Click cycles inner mesh · Drag & drop .glb to add to world'} <i /> Pan: right drag <i /> Zoom: scroll</span></div><div className="viewport-axis"><div className="axis-y">Y</div><div className="axis-x">X</div><div className="axis-z">Z</div></div></div>
        <div className="timeline">
          <div className="timeline-head"><div className="timeline-title"><Video size={16} /><strong>Timeline</strong><span className="timeline-separator" /><span className="duration-button">{duration}s</span><select aria-label="Simulation speed" title="Animation playback speed" className="tool-button toolbar-select" value={String(playbackSpeed)} onChange={(e) => { const spd = Number(e.target.value); setPlaybackSpeed(spd); announce(`Simulation speed: ${spd}x`) }}><option value="0.25">0.25x</option><option value="0.5">0.5x</option><option value="1">1x Speed</option><option value="1.5">1.5x</option><option value="2">2x</option><option value="4">4x</option></select><select aria-label="Loop mode" title="Animation loop mode" className="tool-button toolbar-select" value={loopMode} onChange={(e) => { const mode = e.target.value as 'loop' | 'pingpong' | 'once'; setLoopMode(mode); announce(`Loop mode: ${mode}`) }}><option value="loop">Loop</option><option value="pingpong">Ping-Pong</option><option value="once">Play Once</option></select>{embeddedClips.length > 0 && <select aria-label="Embedded animation clip" title="Play built-in GLB animation clip or author custom keyframes" className="tool-button toolbar-select" value={activeClip} onChange={(e) => { const clipName = e.target.value; setActiveClip(clipName); const found = embeddedClips.find((c) => c.name === clipName); if (found && found.duration > 0) setDuration(Math.max(1, Math.ceil(found.duration))); viewport.current?.setActiveAnimationClip?.(clipName || null, time); announce(clipName ? `Active clip: ${clipName}` : 'Custom keyframe timeline active') }}><option value="">Custom Keyframes</option>{embeddedClips.map((c) => <option key={c.name} value={c.name}>Clip: {c.name} ({c.duration}s)</option>)}</select>}</div><div className="timeline-controls"><button className="icon-button small" title="Previous keyframe" disabled={!filteredFrames.some((frame) => frame.time < time)} onClick={() => { const previous = [...filteredFrames].reverse().find((frame) => frame.time < time); if (previous) seek(previous.time) }}><ChevronDown className="rotate-90" size={15} /></button><button className="play-button" disabled={!selectedNode && !activeClip && frames.length === 0} onClick={() => setPlaying((value) => !value)} title={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}</button><button className="icon-button small" title="Next keyframe" disabled={!filteredFrames.some((frame) => frame.time > time)} onClick={() => { const next = filteredFrames.find((frame) => frame.time > time); if (next) seek(next.time) }}><ChevronDown className="rotate-minus-90" size={15} /></button><span className="time-readout">{time.toFixed(2)} <span>/ {duration.toFixed(2)} s</span></span></div></div>
          <div className="timeline-body"><div className="tracks"><div className="track-name"><ChevronRight size={13} /><span className="track-color" /><span>{selectedNode?.name ?? 'Select an object'}{selectedIds.length > 1 ? ` + ${selectedIds.length - 1}` : ''}</span><button className="track-add" title={`Add keyframe for ${selectedIds.length || 1} selected object(s)`} disabled={!selectedNode} onClick={addKeyframe}><Plus size={14} /></button></div><div className="track-name property"><span className="track-indent-line" /><span className="property-dot position" /><span>Position</span></div><div className="track-name property"><span className="track-indent-line" /><span className="property-dot rotation" /><span>Rotation</span></div><div className="track-name property"><span className="track-indent-line" /><span className="property-dot scale" /><span>Scale</span></div></div>
            <div className="timeline-grid" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); const rect = event.currentTarget.getBoundingClientRect(); seek(Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration))) }} onPointerMove={(event) => { if (event.buttons === 0) return; const rect = event.currentTarget.getBoundingClientRect(); seek(Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration))) }}><div className="ruler">{Array.from({ length: 9 }, (_, index) => <span key={index} style={{ left: `${index * 12.5}%` }}>{index}s</span>)}</div>{[0, 1, 2, 3].map((row) => <div key={row} className="timeline-lane">{row === 0 && framePositions.map((frame) => <button key={frame.id} className="keyframe" style={{ left: frame.left }} title={`${frame.time.toFixed(2)}s keyframe`} onPointerDown={(event) => event.stopPropagation()} onClick={() => seek(frame.time)} />)}</div>)}<div className="playhead" style={{ left: `${(time / duration) * 100}%` }}><span /></div></div>
          </div><div className="timeline-footer"><span>Click timeline to scrub</span><span>{filteredFrames.length} keyframe{filteredFrames.length === 1 ? '' : 's'}</span></div>
        </div>
      </section>

      <aside className="inspector panel"><div className="inspector-heading"><div><span className="eyebrow">INSPECTOR</span><h2>{selectedNode?.name ?? 'No selection'}</h2></div></div>
        {selectedNode ? <><div className="object-meta"><div className="object-type-icon"><Box size={17} /></div><div><strong>{selectedNode.type}</strong><span>Scene object</span></div><button className="visibility-pill" title={selectedNode.visible ? 'Hide object' : 'Show object'} aria-label={selectedNode.visible ? 'Hide object' : 'Show object'} onClick={() => toggleVisibility(selectedNode)}>{selectedNode.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button><button className="icon-button small" title="Delete selected part (Delete key)" aria-label="Delete selected part" onClick={deleteSelection}><Trash2 size={14} /></button></div>
          {selectedNode.type === 'Bone' && <div className="inspector-section pivot-section"><div className="section-title"><span>SKELETON BONE RIGGING</span></div><p className="effect-description">Use Rotate or Move tool to pose this bone, then click + on the Timeline to record custom animations.</p><div className="effect-button-row"><button className="effect-action" onClick={() => { setActiveTool('rotate'); announce(`Rotate gizmo attached to bone ${selectedNode.name}`) }}>Pose Bone (Rotate)</button><button className="effect-action" onClick={() => { const next = !skeletonVisible; setSkeletonVisibleState(next); viewport.current?.setSkeletonVisible?.(next) }}>{skeletonVisible ? 'Hide Skeleton' : 'Show Skeleton'}</button></div></div>}
          <div className="inspector-section"><div className="section-title"><span>TRANSFORM</span><button className="icon-button tiny" title="Reset transform and pivot" aria-label="Reset transform and pivot" onClick={() => { viewport.current?.resetTransform(selected); const initial = viewport.current?.getTransform(selected); if (initial) setTransform(initial); setPivotValue([0, 0, 0]); commitHistorySnapshot() }}><RotateCcw size={14} /></button></div>
            {(['position', 'rotation', 'scale'] as const).map((group) => <div className="vector-control" key={group}><span className="vector-label">{group === 'position' ? 'Position' : group === 'rotation' ? 'Rotation (°)' : 'Scale'}</span><div className="vector-inputs">{transform[group].map((value, index) => <label key={index} className={`vector-cell axis-${'xyz'[index]}`}><span>{'XYZ'[index]}</span><input value={group === 'rotation' ? (value * 180 / Math.PI).toFixed(1) : value.toFixed(2)} type="number" step={group === 'rotation' ? '1' : '0.1'} onChange={(event) => updateTransform(group, index, Number(event.target.value) * (group === 'rotation' ? Math.PI / 180 : 1))} /></label>)}</div></div>)}
            <div className="effect-button-row" style={{ marginTop: 8, marginBottom: 0 }}>
              <button className="effect-action" onClick={duplicateSelection} title="Duplicate this part or model in the 3D world (Ctrl+D)">Duplicate (Ctrl+D)</button>
              <button className="effect-action" onClick={() => { const next = viewport.current?.snapObjectToGround?.(selected); if (next) { setTransform(next); commitHistorySnapshot(); announce('Snapped object to ground floor (Y=0)') } }} title="Drop floating model or part onto the ground floor">Snap to Ground</button>
            </div>
            <div className="effect-button-row" style={{ marginTop: 6, marginBottom: 0 }}>
              <button className="effect-action" onClick={() => { const camNode = viewport.current?.attachFpsCameraToNode?.(selected); if (camNode) { setActivePovId(camNode.id); commitHistorySnapshot(); announce(`Attached ${camNode.name} to ${selectedNode.name} — live First-Person POV active!`) } }} title="Attach a First-Person (FPS) camera to this head, driver seat, or vehicle">+ Attach FPS POV Camera</button>
              {activePovId && <button className="effect-action remove" style={{ marginTop: 0 }} onClick={() => { setActivePovId(''); announce('Exited locked FPS POV camera') }}>Exit FPS POV</button>}
            </div>
            <label className="effect-single-input" style={{ marginTop: 8, marginBottom: 0 }}>Snap / Align Position To Target
              <select aria-label="Snap position to target object" className="tool-button toolbar-select" style={{ width: '100%', height: 26 }} value="" onChange={(e) => { const targetId = e.target.value; if (!targetId) return; const next = viewport.current?.alignObjectToTarget?.(selected, targetId); if (next) { setTransform(next); commitHistorySnapshot(); announce(`Aligned ${selectedNode.name} to ${nodes.find((n) => n.id === targetId)?.name}`) } }}>
                <option value="">Choose target (e.g. Car Seat / Door)...</option>
                {nodes.filter((n) => n.id !== selected).map((n) => <option key={n.id} value={n.id}>{n.name} ({n.type})</option>)}
              </select>
            </label>
            <label className="effect-single-input" style={{ marginTop: 6, marginBottom: 0 }}>Attach / Parent Limb To
              <select aria-label="Attach to parent object" className="tool-button toolbar-select" style={{ width: '100%', height: 26 }} value={selectedNode.parent ?? ''} onChange={(e) => { const nextParent = e.target.value || null; const updated = viewport.current?.setParentObject?.(selected, nextParent); if (updated) { setNodes(updated); commitHistorySnapshot(updated); announce(`Attached ${selectedNode.name} to ${nodes.find((n) => n.id === nextParent)?.name ?? 'World Root'}`) } }}>
                <option value="">World Root</option>
                {nodes.filter((n) => n.id !== selected).map((n) => <option key={n.id} value={n.id}>{n.name} ({n.type})</option>)}
              </select>
            </label>
          </div>
          <div className="inspector-section pivot-section">
            <div className="section-title"><span>CONTROLLER & INPUT MAPPING</span></div>
            <p className="effect-description">Map Keyboard, PlayStation, Xbox, or Drone RC Transmitter sticks/triggers to control {selectedNode.name} on any axis.{connectedGamepad ? ` (${connectedGamepad})` : ''}</p>
            <div className="effect-input-row">
              <label>Input / Controller
                <select aria-label="Binding input" className="tool-button toolbar-select" style={{ width: '100%', height: 26 }} value={newBindInput} onChange={(e) => setNewBindInput(e.target.value)}>
                  <optgroup label="Keyboard">
                    {['w', 'a', 's', 'd', 'e', 'f', 'c', 'q', 'r', 'space', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].map((k) => <option key={k} value={k}>Key: {k.toUpperCase()}</option>)}
                  </optgroup>
                  <optgroup label="Gamepad / Drone RC Sticks (Axes)">
                    <option value="gp:axis:0">Left Stick X (Yaw / Strafe / Roll)</option>
                    <option value="gp:axis:1">Left Stick Y (Throttle / Move / Pitch)</option>
                    <option value="gp:axis:2">Right Stick X (Look / Turn / Aim X)</option>
                    <option value="gp:axis:3">Right Stick Y (Pitch / Look / Aim Y)</option>
                  </optgroup>
                  <optgroup label="PlayStation / Xbox / RC Buttons">
                    <option value="gp:btn:0">Cross (PS) / A (Xbox)</option>
                    <option value="gp:btn:1">Circle (PS) / B (Xbox)</option>
                    <option value="gp:btn:2">Square (PS) / X (Xbox)</option>
                    <option value="gp:btn:3">Triangle (PS) / Y (Xbox)</option>
                    <option value="gp:btn:4">L1 / LB Bumper</option>
                    <option value="gp:btn:5">R1 / RB Bumper</option>
                    <option value="gp:btn:6">L2 / LT Analog Trigger</option>
                    <option value="gp:btn:7">R2 / RT Analog Trigger</option>
                    <option value="gp:btn:12">D-Pad Up</option>
                    <option value="gp:btn:13">D-Pad Down</option>
                    <option value="gp:btn:14">D-Pad Left</option>
                    <option value="gp:btn:15">D-Pad Right</option>
                  </optgroup>
                </select>
              </label>
              <label>Axis
                <select aria-label="Binding axis" className="tool-button toolbar-select" style={{ width: '100%', height: 26 }} value={newBindAxis} onChange={(e) => setNewBindAxis(e.target.value as 'x' | 'y' | 'z')}>
                  <option value="x">X Axis</option>
                  <option value="y">Y Axis</option>
                  <option value="z">Z Axis</option>
                </select>
              </label>
            </div>
            <div className="effect-input-row">
              <label>Behavior
                <select aria-label="Binding action" className="tool-button toolbar-select" style={{ width: '100%', height: 26 }} value={newBindAction} onChange={(e) => setNewBindAction(e.target.value as typeof newBindAction)}>
                  <option value="translate">Translate / Move Along Axis</option>
                  <option value="rotate">Rotate / Turn Around Axis</option>
                  <option value="hinge">Toggle Joint Hinge (±85°)</option>
                  <option value="spin">Continuous Spin / Throttle</option>
                  <option value="cameraPov">Switch to POV Camera</option>
                  <option value="playTimeline">Play / Pause Timeline</option>
                </select>
              </label>
              <label>Sensitivity
                <input aria-label="Binding speed" type="number" step="0.25" min="-10" max="10" value={newBindSpeed} onChange={(e) => setNewBindSpeed(Number(e.target.value) || 1)} />
              </label>
            </div>
            <button className="effect-action" onClick={() => { const binding = { id: crypto.randomUUID(), targetId: selected, input: newBindInput, axis: newBindAxis, action: newBindAction, speed: newBindSpeed }; setKeyBindings((prev) => [...prev.filter((b) => !(b.targetId === selected && b.input === newBindInput && b.axis === newBindAxis)), binding]); announce(`Mapped [${newBindInput.toUpperCase()}] → ${selectedNode.name} (${newBindAction} on ${newBindAxis.toUpperCase()})`) }}>+ Map Input to {selectedNode.name}</button>
            {keyBindings.filter((b) => b.targetId === selected).map((b) => (
              <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, fontSize: 10, color: '#b7f36b' }}>
                <span>[{b.input.toUpperCase()}] → {b.action} ({b.axis.toUpperCase()} · {b.speed}x)</span>
                <button className="icon-button tiny" onClick={() => setKeyBindings((prev) => prev.filter((item) => item.id !== b.id))}><X size={12} /></button>
              </div>
            ))}
          </div>
          <div className="inspector-section pivot-section">
            <div className="section-title"><span>PROCEDURAL MOTION & PHYSICS</span><select aria-label="Motion axis" className="tool-button toolbar-select" style={{ height: 20, minWidth: 58, fontSize: 9 }} value={motionAxis} onChange={(e) => setMotionAxis(e.target.value as 'x' | 'y' | 'z')}><option value="x">Axis: X</option><option value="y">Axis: Y</option><option value="z">Axis: Z</option></select></div>
            <p className="effect-description">Universal motion generators for any limb, creature, joint, rotor, or prop on the selected axis.</p>
            <div className="effect-button-row">
              <button className="effect-action" onClick={() => applyUniversalMotion('oscillate')}>Oscillate / Stride</button>
              <button className="effect-action" onClick={() => applyUniversalMotion('hinge')}>Hinge Swing</button>
              <button className="effect-action" onClick={() => applyUniversalMotion('impulse')}>Impulse / Bounce</button>
            </div>
            <div className="effect-button-row">
              <button className="effect-action" onClick={() => applyUniversalMotion('spin')}>Continuous Spin</button>
              <button className="effect-action" onClick={() => applyUniversalMotion('float')}>Hover / Wave</button>
              <button className="effect-action" onClick={() => applyUniversalMotion('damping')}>Inertia Curve</button>
            </div>
            {selectedNode.type === 'Mesh' && <>
              <div className="effect-subsection-title">SURFACE MATERIAL PRESET</div>
              <div className="effect-button-row" style={{ marginBottom: 0 }}>
                <button className="effect-action" onClick={() => { if (viewport.current?.setMeshSurfacePreset?.(selected, 'mirror')) announce('Applied Reflective / Metallic PBR surface') }}>Reflective / Chrome</button>
                <button className="effect-action" onClick={() => { if (viewport.current?.setMeshSurfacePreset?.(selected, 'glass')) announce('Applied Translucent / Glass PBR surface') }}>Translucent / Glass</button>
                <button className="effect-action" onClick={() => { if (viewport.current?.setMeshSurfacePreset?.(selected, 'default')) announce('Restored Standard Matte PBR surface') }}>Standard Matte</button>
              </div>
            </>}
          </div>
          {selectedNode.type === 'Camera' && <div className="inspector-section pivot-section"><div className="section-title"><span>CAMERA POV & CINEMATICS</span></div><p className="effect-description">Move or rotate this camera with the gizmo and add keyframes on the timeline for cinematic shots.</p><div className="effect-button-row"><button className="effect-action" onClick={() => { viewport.current?.setActivePovCamera?.(selected); announce(`Viewing through ${selectedNode.name}`) }}>Look Through Camera (POV)</button><button className="effect-action" onClick={() => { const pose = viewport.current?.getCameraPose(); if (pose) { announce('Camera aligned to current viewport') } }}>Align to Current View</button></div></div>}
          {selectedNode.type === 'Mesh' && <div className="inspector-section pivot-section"><div className="section-title"><span>PART BREAKING</span></div><p className="effect-description">Click any spot on the model while 3D Box is active to snap the box there, or use a quick slice preset below.</p><div className="effect-button-row"><button className="effect-action" onClick={() => { const updated = viewport.current?.splitSelectedMesh(selected, 'islands'); if (updated) { setNodes(updated); commitHistorySnapshot(updated); announce('Split mesh into loose parts') } else announce('Mesh is already a single connected part — use 3D Box to slice') }}>Split Loose Parts</button><button className="effect-action" onClick={() => { const updated = viewport.current?.splitSelectedMesh(selected, 'materials'); if (updated) { setNodes(updated); commitHistorySnapshot(updated); announce('Split mesh by material groups') } else announce('Mesh has only one material group') }}>Split by Material</button></div><div className="effect-button-row"><button className="effect-action" onClick={() => { setBoxSelect(false); setActiveTool('volume'); viewport.current?.setVolumeBoxMode?.(volumeBoxMode); viewport.current?.applyVolumePreset?.('top'); announce('3D Box snapped to Top Half — click anywhere on mesh to snap box to that spot') }}>3D Box Selector</button><button className="effect-action" onClick={() => { const res = viewport.current?.extractBoxSelection?.(); if (res && res.extractedCount > 0) { setActiveTool('move'); commitHistorySnapshot(); announce(`Clean-sliced ${res.extractedCount} triangles into new movable part`) } else announce('Enable 3D Box Selector and position it over triangles first') }}>Extract 3D Box Part</button></div><div className="effect-button-row"><button className="effect-action" onClick={() => { setActiveTool('volume'); viewport.current?.applyVolumePreset?.('top'); announce('3D Box: Top Half') }}>Top Half</button><button className="effect-action" onClick={() => { setActiveTool('volume'); viewport.current?.applyVolumePreset?.('bottom'); announce('3D Box: Bottom Half') }}>Bottom Half</button><button className="effect-action" onClick={() => { setActiveTool('volume'); viewport.current?.applyVolumePreset?.('left'); announce('3D Box: Left Half') }}>Left</button><button className="effect-action" onClick={() => { setActiveTool('volume'); viewport.current?.applyVolumePreset?.('right'); announce('3D Box: Right Half') }}>Right</button></div><div className="effect-button-row"><button className="effect-action" onClick={() => { const count = viewport.current?.smoothSelectedMesh?.(selected) ?? 0; if (count > 0) { commitHistorySnapshot(); announce('Smoothed spiky boundary edges on selected mesh') } else announce('No jagged open boundary edges found on this mesh') }}>Smooth Spiky Edges</button><button className="effect-action remove" style={{ marginTop: 0 }} onClick={() => { const res = viewport.current?.deleteBoxSelection?.(); if (res && res.deletedCount > 0) { commitHistorySnapshot(); announce(`Erased ${res.deletedCount} triangles inside 3D Box`) } else deleteSelection() }}>Delete / Erase Part</button></div></div>}
          {selectedNode.type === 'Mesh' && <div className="inspector-section pivot-section"><div className="section-title"><span>PIVOT & JOINT HINGE</span></div><p className="effect-description">Move the part’s origin to its shoulder, elbow, or door hinge before animating rotation.</p><div className="effect-button-row"><button className="effect-action" onClick={() => { const p = viewport.current?.setQuickHingePivot?.(selected, 'top'); if (p) { setPivotValue(p); const t = viewport.current?.getTransform(selected); if (t) setTransform(t); commitHistorySnapshot(); announce('Joint pivot set to Top (Shoulder / Hip)') } }}>Shoulder / Top</button><button className="effect-action" onClick={() => { const p = viewport.current?.setQuickHingePivot?.(selected, 'bottom'); if (p) { setPivotValue(p); const t = viewport.current?.getTransform(selected); if (t) setTransform(t); commitHistorySnapshot(); announce('Joint pivot set to Bottom (Base / Foot)') } }}>Base / Bottom</button><button className="effect-action" onClick={() => { const p = viewport.current?.setQuickHingePivot?.(selected, 'left'); if (p) { setPivotValue(p); const t = viewport.current?.getTransform(selected); if (t) setTransform(t); commitHistorySnapshot(); announce('Joint pivot set to Left Hinge') } }}>Left Hinge</button><button className="effect-action" onClick={() => { const p = viewport.current?.setQuickHingePivot?.(selected, 'right'); if (p) { setPivotValue(p); const t = viewport.current?.getTransform(selected); if (t) setTransform(t); commitHistorySnapshot(); announce('Joint pivot set to Right Hinge') } }}>Right Hinge</button></div><button className="effect-action" onClick={() => { const next = viewport.current?.setPivotFromLastHit(selected); if (next) { setPivotValue(next); const updated = viewport.current?.getTransform(selected); if (updated) setTransform(updated); commitHistorySnapshot(); announce('Pivot moved to the last clicked point') } else announce('Click the mesh surface first, then set its pivot') }}>Set from last clicked surface</button><div className="vector-control pivot-control"><span className="vector-label">Local point</span><div className="vector-inputs">{pivot.map((value, index) => <label key={index} className={`vector-cell axis-${'xyz'[index]}`}><span>{'XYZ'[index]}</span><input aria-label={`Pivot ${'XYZ'[index]}`} type="number" step="0.05" value={value.toFixed(2)} onChange={(event) => { const next = [...pivot] as [number, number, number]; next[index] = Number(event.target.value); if (viewport.current?.setPivot(selected, next)) { setPivotValue(next); const updated = viewport.current?.getTransform(selected); if (updated) setTransform(updated); commitHistorySnapshot() } }} /></label>)}</div></div><button className="effect-action remove" disabled={pivot.every((value) => Math.abs(value) < 1e-8)} onClick={() => { viewport.current?.setPivot(selected, [0, 0, 0]); setPivotValue([0, 0, 0]); const updated = viewport.current?.getTransform(selected); if (updated) setTransform(updated); commitHistorySnapshot() }}>Reset pivot</button></div>}
          {objectStats && <div className="inspector-section geometry-section"><div className="section-title"><span>GEOMETRY</span></div><div className="geometry-grid"><span>Meshes</span><strong>{objectStats.meshCount.toLocaleString()}</strong><span>Vertices</span><strong>{objectStats.vertexCount.toLocaleString()}</strong><span>Triangles</span><strong>{objectStats.triangleCount.toLocaleString()}</strong><span>Materials</span><strong>{objectStats.materialCount.toLocaleString()}</strong><span>Bounds</span><strong>{objectStats.dimensions.map((value) => value.toFixed(2)).join(' × ')}</strong></div></div>}
          {selectedNode.type === 'Mesh' && <div className="inspector-section effect-section">
            <div className="section-title"><span>VISUAL EFFECTS</span></div>
            {(() => {
              const surface = effects.find((item): item is SurfaceEffect => item.targetId === selected && isSurfaceEffect(item))
              const particles = effects.find((item): item is Extract<SceneEffect, { kind: 'particles' }> => item.targetId === selected && item.kind === 'particles')
              const timing = (effect: SceneEffect) => <div className="effect-input-row"><label>Start (s)<input aria-label={`${effect.kind ?? 'dissolve'} start`} type="number" min="0" max={Math.max(0, effect.endTime - 0.05)} step="0.05" value={effect.startTime} onChange={(event) => updateEffect(effect.kind ?? 'dissolve', { startTime: Math.max(0, Math.min(Number(event.target.value), effect.endTime - 0.05)) })} /></label><label>End (s)<input aria-label={`${effect.kind ?? 'dissolve'} end`} type="number" min={effect.startTime + 0.05} max={duration} step="0.05" value={effect.endTime} onChange={(event) => updateEffect(effect.kind ?? 'dissolve', { endTime: Math.max(effect.startTime + 0.05, Math.min(duration, Number(event.target.value))) })} /></label></div>
              return <>
                {surface ? <>
                  <div className="effect-progress"><span>{surface.kind === 'burn' ? 'Burn progress' : 'Dissolve progress'}</span><strong>{Math.round(dissolveProgress(surface, time) * 100)}%</strong></div>
                  {timing(surface)}
                  <div className="effect-input-row"><label>Edge color<input className="effect-color" type="color" value={surface.edgeColor} onChange={(event) => updateEffect(surface.kind ?? 'dissolve', { edgeColor: event.target.value })} /></label><label>Edge width<input aria-label="Effect edge width" type="number" min="0.005" max="0.25" step="0.005" value={surface.edgeWidth} onChange={(event) => updateEffect(surface.kind ?? 'dissolve', { edgeWidth: Math.max(0.005, Math.min(0.25, Number(event.target.value))) })} /></label></div>
                  {surface.kind === 'burn' && <label className="effect-single-input">Flame color<input className="effect-color" type="color" value={surface.flameColor} onChange={(event) => updateEffect('burn', { flameColor: event.target.value })} /></label>}
                  <button className="effect-action remove" onClick={() => setEffects((current) => current.filter((effect) => effect !== surface))}>Remove {surface.kind === 'burn' ? 'burn' : 'dissolve'}</button>
                </> : <>
                  <p className="effect-description">Animate this part into a time-based surface effect.</p>
                  <div className="effect-button-row"><button className="effect-action" disabled={!!surface} onClick={() => addSurfaceEffect('dissolve')}>Add dissolve</button><button className="effect-action" disabled={!!surface} onClick={() => addSurfaceEffect('burn')}>Add burn</button></div>
                </>}
                {particles ? <>
                  <div className="effect-subsection-title">PARTICLES</div>{timing(particles)}
                  <div className="effect-input-row"><label>Color<input className="effect-color" type="color" value={particles.color} onChange={(event) => updateEffect('particles', { color: event.target.value })} /></label><label>Count<input aria-label="Particle count" type="number" min="16" max="2048" step="16" value={particles.particleCount} onChange={(event) => updateEffect('particles', { particleCount: Math.max(16, Math.min(2048, Number(event.target.value))) })} /></label></div>
                  <label className="effect-single-input">Point size<input aria-label="Particle point size" type="number" min="1" max="24" step="0.5" value={particles.particleSize} onChange={(event) => updateEffect('particles', { particleSize: Math.max(1, Math.min(24, Number(event.target.value))) })} /></label>
                  <button className="effect-action remove" onClick={addParticles}>Remove particles</button>
                </> : <><div className="effect-subsection-title">PARTICLES</div><p className="effect-description">Emit deterministic GPU-rendered particles from this mesh.</p><button className="effect-action" onClick={addParticles}>Add particles</button></>}
              </>
            })()}
          </div>}
          <div className="inspector-tip"><Sparkles size={15} /><span>Animate this object by moving the playhead and adding a keyframe.</span></div></> : <div className="inspector-empty">Select an object in the scene hierarchy.</div>}
      </aside>
    </div>
    <footer className="statusbar"><div><span className="status-green" /> Ready <span className="status-divider" /> {nodes.length} objects</div><div className="status-right"><span>WebGPU workspace</span><span className="status-divider" /><a href="https://threejs.org/docs/" target="_blank" rel="noreferrer">Three.js Docs <ExternalIcon /></a></div></footer>
    <input ref={fileInput} type="file" multiple accept=".glb,.gltf,model/gltf-binary,model/gltf+json,image/*" hidden onChange={(event) => { const resources = Array.from(event.target.files ?? []); const model = resources.find((file) => /\.(glb|gltf)$/i.test(file.name)); void loadFile(model, resources, false); event.currentTarget.value = '' }} />
    <input ref={appendFileInput} type="file" multiple accept=".glb,.gltf,model/gltf-binary,model/gltf+json,image/*" hidden onChange={(event) => { const resources = Array.from(event.target.files ?? []); const model = resources.find((file) => /\.(glb|gltf)$/i.test(file.name)); void loadFile(model, resources, true); event.currentTarget.value = '' }} />
    <input ref={folderInput} type="file" multiple hidden onChange={(event) => { const resources = Array.from(event.target.files ?? []); const model = resources.find((resource) => /\.(glb|gltf)$/i.test(resource.name)); void loadFile(model, resources); event.currentTarget.value = '' }} />
    <input ref={projectInput} type="file" accept=".forge,.zip,application/zip" hidden onChange={(event) => { void openProject(event.target.files?.[0]); event.currentTarget.value = '' }} />
    {codeDrawerOpen && <div className="renderer-error" style={{ width: 'min(680px, calc(100% - 40px))', maxHeight: '78vh', overflow: 'auto', zIndex: 30, background: '#16181d', borderColor: '#353b2d', color: '#e5e7eb' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>+ Add to Code — Live Scene & Game Controller Snippet ({projectName})</strong>
        <button className="icon-button small" onClick={() => setCodeDrawerOpen(false)}><X size={14} /></button>
      </div>
      <span style={{ color: '#9ca3af', fontSize: 11 }}>Includes your current camera pose, split/extracted parts, transforms, animations, and playable WASD / E (Door) / F (Enter Car) / C (FPS POV) bindings:</span>
      <pre style={{ margin: '6px 0', padding: 10, borderRadius: 6, background: '#0f1115', color: '#b7f36b', fontSize: 10, maxHeight: '46vh', overflow: 'auto', fontFamily: "'DM Mono', monospace" }}>{generateR3FComponent(buildCurrentManifest())}</pre>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="effect-action" onClick={async () => { const code = generateR3FComponent(buildCurrentManifest()); await navigator.clipboard?.writeText(code); announce('Copied R3F (.tsx) code snippet to clipboard!') }}>Copy .tsx to Clipboard</button>
        <button className="effect-action" onClick={() => { void triggerLiveCodeSync(); setCodeDrawerOpen(false) }}>Inject & Link to Code File (.tsx / .js / .json)</button>
      </div>
    </div>}
    {toast && <div className="toast"><span className="status-dot" />{toast}<button onClick={() => setToast('')}><X size={14} /></button></div>}
  </main>
}

function ExternalIcon() { return <ExternalLink size={11} /> }

export default App
