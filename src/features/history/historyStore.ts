import { createStore, useStore } from 'zustand'
import type { PivotPoint } from '../../renderer/three/pivots.ts'
import type { ObjectTransform, SceneNode } from '../../SceneViewport.tsx'

export type HistoryKeyframe = {
  id: string
  targetId: string
  time: number
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
}

export type HistorySnapshot = {
  nodes: SceneNode[]
  transforms: Record<string, ObjectTransform>
  visibility: Record<string, boolean>
  pivots: Record<string, PivotPoint>
  frames: HistoryKeyframe[]
  selected: string
  selectedIds: string[]
  geometrySnapshot?: Record<string, unknown>
}

export type HistoryStoreState = {
  past: HistorySnapshot[]
  present: HistorySnapshot | null
  future: HistorySnapshot[]
  canUndo: boolean
  canRedo: boolean
  pushState: (snapshot: HistorySnapshot) => void
  undo: () => HistorySnapshot | null
  redo: () => HistorySnapshot | null
  clear: () => void
}

function cloneVec3(v: [number, number, number]): [number, number, number] {
  return [Number(v[0]), Number(v[1]), Number(v[2])]
}

function cloneSnapshot(snap: HistorySnapshot): HistorySnapshot {
  const transforms: Record<string, ObjectTransform> = {}
  for (const [id, t] of Object.entries(snap.transforms ?? {})) {
    transforms[id] = {
      position: cloneVec3(t.position),
      rotation: cloneVec3(t.rotation),
      scale: cloneVec3(t.scale),
    }
  }
  const pivots: Record<string, PivotPoint> = {}
  for (const [id, p] of Object.entries(snap.pivots ?? {})) {
    pivots[id] = cloneVec3(p)
  }
  return {
    nodes: (snap.nodes ?? []).map((n) => ({ ...n })),
    transforms,
    visibility: { ...(snap.visibility ?? {}) },
    pivots,
    frames: (snap.frames ?? []).map((f) => ({
      ...f,
      position: cloneVec3(f.position),
      rotation: cloneVec3(f.rotation),
      scale: cloneVec3(f.scale),
    })),
    selected: snap.selected ?? '',
    selectedIds: [...(snap.selectedIds ?? [])],
    ...(snap.geometrySnapshot !== undefined ? { geometrySnapshot: { ...snap.geometrySnapshot } } : {}),
  }
}

function disposeGeometrySnapshots(snapshots: Array<HistorySnapshot | null>) {
  const seen = new Set<unknown>()
  for (const snap of snapshots) {
    if (!snap?.geometrySnapshot || typeof snap.geometrySnapshot !== 'object') continue
    for (const val of Object.values(snap.geometrySnapshot)) {
      if (val && typeof val === 'object' && !seen.has(val)) {
        seen.add(val)
        const disposable = val as { dispose?: () => void }
        if (typeof disposable.dispose === 'function') {
          disposable.dispose()
        }
      }
    }
  }
}

export function createHistoryStore() {
  return createStore<HistoryStoreState>((set, get) => ({
    past: [],
    present: null,
    future: [],
    canUndo: false,
    canRedo: false,
    pushState(snapshot) {
      const cloned = cloneSnapshot(snapshot)
      const { past, present } = get()
      const nextPast = present !== null ? [...past, present] : [...past]
      set({
        past: nextPast,
        present: cloned,
        future: [],
        canUndo: nextPast.length > 0,
        canRedo: false,
      })
    },
    undo() {
      const { past, present, future } = get()
      if (past.length === 0 || present === null) return null
      const prev = past[past.length - 1]
      const nextPast = past.slice(0, -1)
      const nextFuture = [present, ...future]
      set({
        past: nextPast,
        present: prev,
        future: nextFuture,
        canUndo: nextPast.length > 0,
        canRedo: nextFuture.length > 0,
      })
      return cloneSnapshot(prev)
    },
    redo() {
      const { past, present, future } = get()
      if (future.length === 0 || present === null) return null
      const [next, ...restFuture] = future
      const nextPast = [...past, present]
      set({
        past: nextPast,
        present: next,
        future: restFuture,
        canUndo: nextPast.length > 0,
        canRedo: restFuture.length > 0,
      })
      return cloneSnapshot(next)
    },
    clear() {
      const { past, present, future } = get()
      disposeGeometrySnapshots([...past, present, ...future])
      set({
        past: [],
        present: null,
        future: [],
        canUndo: false,
        canRedo: false,
      })
    },
  }))
}

const defaultStore = createHistoryStore()

export const useHistoryStore = Object.assign(
  <T = HistoryStoreState>(selector?: (state: HistoryStoreState) => T): T =>
    useStore(defaultStore, selector ?? ((s) => s as unknown as T)),
  {
    getState: defaultStore.getState,
    setState: defaultStore.setState,
    subscribe: defaultStore.subscribe,
  }
)

export function shouldIgnoreHistoryShortcut(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as { tagName?: unknown; isContentEditable?: unknown; contentEditable?: unknown }
  if (el.isContentEditable === true || el.contentEditable === 'true' || el.contentEditable === '') {
    return true
  }
  if (typeof el.tagName === 'string') {
    const tag = el.tagName.toUpperCase()
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true
  }
  return false
}

export function matchHistoryShortcut(event: {
  key?: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  target?: unknown
}): 'undo' | 'redo' | null {
  if (!event || event.altKey) return null
  if (event.target && shouldIgnoreHistoryShortcut(event.target)) return null
  const mod = Boolean(event.ctrlKey || event.metaKey)
  if (!mod || typeof event.key !== 'string') return null
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && !event.shiftKey) return 'redo'
  return null
}
