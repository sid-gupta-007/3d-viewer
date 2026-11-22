import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three/webgpu'
import {
  createHistoryStore,
  matchHistoryShortcut,
  shouldIgnoreHistoryShortcut,
  useHistoryStore,
} from '../src/features/history/historyStore.ts'

function sampleSnap(selected = 'm:0', x = 0) {
  return {
    nodes: [{ id: 'm:0', name: 'Body', type: 'Mesh', visible: true, parent: 'm:root' }],
    transforms: { 'm:0': { position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    visibility: { 'm:0': true },
    pivots: {},
    frames: [],
    selected,
    selectedIds: [selected],
  }
}

test('createHistoryStore and useHistoryStore push, undo, redo, and clear cleanly', () => {
  const store = createHistoryStore()
  assert.equal(store.getState().undo(), null)
  assert.equal(store.getState().redo(), null)

  store.getState().pushState(sampleSnap('m:0', 1))
  store.getState().pushState(sampleSnap('m:0', 5))
  assert.equal(store.getState().canUndo, true)
  assert.deepEqual(store.getState().undo()?.transforms['m:0'].position, [1, 0, 0])
  assert.equal(store.getState().canRedo, true)
  assert.deepEqual(store.getState().redo()?.transforms['m:0'].position, [5, 0, 0])

  const geo = new THREE.BoxGeometry(1, 1, 1)
  let disposed = false
  const orig = geo.dispose.bind(geo)
  geo.dispose = () => {
    disposed = true
    orig()
  }
  useHistoryStore.getState().pushState({ ...sampleSnap(), geometrySnapshot: { g: geo } })
  useHistoryStore.getState().clear()
  assert.equal(disposed, true)
})

test('matchHistoryShortcut and shouldIgnoreHistoryShortcut handle keyboard events', () => {
  assert.equal(matchHistoryShortcut({ key: 'z', ctrlKey: true }), 'undo')
  assert.equal(matchHistoryShortcut({ key: 'Z', metaKey: true, shiftKey: true }), 'redo')
  assert.equal(matchHistoryShortcut({ key: 'y', ctrlKey: true }), 'redo')
  assert.equal(matchHistoryShortcut({ key: 'z', ctrlKey: true, altKey: true }), null)
  assert.equal(shouldIgnoreHistoryShortcut({ tagName: 'INPUT' }), true)
  assert.equal(shouldIgnoreHistoryShortcut({ tagName: 'SELECT' }), true)
  assert.equal(shouldIgnoreHistoryShortcut({ tagName: 'DIV' }), false)
})
