import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultManifest } from '../src/domain/sceneManifest.ts'
import {
  applyEasing,
  resolveLoopTime,
  sampleNodeTrack,
  sampleAllNodeTracks,
  sampleCameraTrack,
  useTimelineStore,
} from '../src/features/animation/timelineStore.ts'
import {
  WEBXR_EYE_HEIGHT_METERS,
  ENVIRONMENT_PRESETS,
  isEnvironmentPresetId,
  getEnvironmentPreset,
  listEnvironmentPresets,
  createEnvironmentManifest,
  isWithinFloorBounds,
  clampPositionToFloorBounds,
  createXRCameraPose,
} from '../src/features/environment/environmentPresets.ts'

test('applyEasing evaluates linear, easeIn, easeOut, easeInOut, and step curves', () => {
  assert.equal(applyEasing(-0.5, 'linear'), 0)
  assert.equal(applyEasing(1.5, 'linear'), 1)
  assert.equal(applyEasing(Number.NaN, 'linear'), 0)
  assert.equal(applyEasing(0.5, 'linear'), 0.5)

  assert.equal(applyEasing(0.5, 'easeIn'), 0.25)
  assert.equal(applyEasing(0.5, 'easeOut'), 0.75)

  assert.equal(applyEasing(0.25, 'easeInOut'), 0.125)
  assert.equal(applyEasing(0.5, 'easeInOut'), 0.5)
  assert.equal(applyEasing(0.75, 'easeInOut'), 0.875)

  assert.equal(applyEasing(0, 'step'), 0)
  assert.equal(applyEasing(0.999, 'step'), 0)
  assert.equal(applyEasing(1, 'step'), 1)
})

test('resolveLoopTime handles once, loop, and pingpong modes', () => {
  assert.deepEqual(resolveLoopTime(1.5, 4, 'once'), { time: 1.5, finished: false })
  assert.deepEqual(resolveLoopTime(4, 4, 'once'), { time: 4, finished: true })
  assert.deepEqual(resolveLoopTime(6, 4, 'once'), { time: 4, finished: true })

  assert.deepEqual(resolveLoopTime(5.5, 4, 'loop'), { time: 1.5, finished: false })
  assert.deepEqual(resolveLoopTime(8, 4, 'loop'), { time: 0, finished: false })

  assert.deepEqual(resolveLoopTime(3, 4, 'pingpong'), { time: 3, finished: false })
  assert.deepEqual(resolveLoopTime(5, 4, 'pingpong'), { time: 3, finished: false })
  assert.deepEqual(resolveLoopTime(8, 4, 'pingpong'), { time: 0, finished: false })

  assert.deepEqual(resolveLoopTime(2, 0, 'once'), { time: 0, finished: true })
})

test('sampleNodeTrack interpolates unsorted keyframes across easing modes and multiple targets', () => {
  const keyframes = [
    {
      id: 'k2',
      targetId: 'arm',
      time: 2,
      position: [10, 0, 0],
      rotation: [0, Math.PI, 0],
      scale: [2, 2, 2],
      easing: 'linear',
    },
    {
      id: 'k1',
      targetId: 'arm',
      time: 0,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      easing: 'easeIn',
    },
    {
      id: 'k3',
      targetId: 'base',
      time: 0,
      position: [0, 1, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      easing: 'step',
    },
    {
      id: 'k4',
      targetId: 'base',
      time: 2,
      position: [0, 5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ]

  assert.equal(sampleNodeTrack(keyframes, 'missing', 1), null)

  // Before first keyframe clamps to first
  assert.deepEqual(sampleNodeTrack(keyframes, 'arm', -1), {
    targetId: 'arm',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  })

  // Midpoint with easeIn (t=0.5 => alpha=0.25)
  const armMid = sampleNodeTrack(keyframes, 'arm', 1)
  assert.ok(armMid)
  assert.deepEqual(armMid.position, [2.5, 0, 0])
  assert.deepEqual(armMid.scale, [1.25, 1.25, 1.25])

  // Step easing holds start value until end time
  const allMid = sampleAllNodeTracks(keyframes, 1.5)
  assert.deepEqual(allMid.base.position, [0, 1, 0])

  const allEnd = sampleAllNodeTracks(keyframes, 2.5)
  assert.deepEqual(allEnd.base.position, [0, 5, 0])
})

test('sampleCameraTrack interpolates camera position, target, and fov', () => {
  const cameraKeyframes = [
    {
      id: 'cam-0',
      time: 0,
      position: [0, 2, 10],
      target: [0, 0, 0],
      fov: 40,
      easing: 'linear',
    },
    {
      id: 'cam-1',
      time: 4,
      position: [4, 6, 2],
      target: [2, 1, 0],
      fov: 60,
    },
  ]

  const mid = sampleCameraTrack(cameraKeyframes, 2)
  assert.deepEqual(mid, {
    position: [2, 4, 6],
    target: [1, 0.5, 0],
    fov: 50,
  })
})

test('useTimelineStore manages playback, loop modes, keyframes, camera tracks, and manifest loading', () => {
  useTimelineStore.getState().reset()

  const store = useTimelineStore.getState()
  store.setDuration(2)
  store.setLoopMode('once')
  store.upsertKeyframe({
    id: 'n1',
    targetId: 'rotor',
    time: 0,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    easing: 'linear',
  })
  store.upsertKeyframe({
    id: 'n2',
    targetId: 'rotor',
    time: 2,
    position: [0, 4, 0],
    rotation: [0, 2, 0],
    scale: [1, 1, 1],
  })
  store.upsertCameraKeyframe({
    id: 'c1',
    time: 0,
    position: [0, 1.6, 5],
    target: [0, 1, 0],
    fov: 45,
  })
  store.upsertCameraKeyframe({
    id: 'c2',
    time: 2,
    position: [2, 1.6, 5],
    target: [0, 1, 0],
    fov: 55,
  })

  store.play()
  store.advance(1)
  assert.equal(useTimelineStore.getState().currentTime, 1)
  assert.deepEqual(useTimelineStore.getState().sampleNode('rotor')?.position, [0, 2, 0])
  assert.deepEqual(useTimelineStore.getState().sampleCamera()?.fov, 50)

  // Advancing past duration in 'once' mode stops playback at duration
  store.advance(2)
  assert.equal(useTimelineStore.getState().currentTime, 2)
  assert.equal(useTimelineStore.getState().playing, false)

  // Pingpong mode bounces back
  store.setLoopMode('pingpong')
  store.seek(0)
  store.play()
  store.advance(3)
  assert.equal(useTimelineStore.getState().currentTime, 1)
  assert.equal(useTimelineStore.getState().playing, true)

  // Manifest loading resets time and loads keyframes
  const manifest = createDefaultManifest('TestScene', './test.glb')
  manifest.loopMode = 'loop'
  manifest.keyframes = [
    {
      id: 'm1',
      targetId: 'cube',
      time: 0,
      position: [1, 2, 3],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ]
  store.loadFromManifest(manifest)
  assert.equal(useTimelineStore.getState().currentTime, 0)
  assert.equal(useTimelineStore.getState().keyframes.length, 1)
  assert.equal(useTimelineStore.getState().cameraKeyframes.length, 0)
  useTimelineStore.getState().reset()
})

test('environmentPresets provides all 5 presets matching sceneManifest with 1.6m WebXR eye-height and floor bounds', () => {
  assert.equal(WEBXR_EYE_HEIGHT_METERS, 1.6)

  const presets = listEnvironmentPresets()
  assert.deepEqual(
    presets.map((p) => p.id),
    ['studio', 'sunset', 'night', 'warehouse', 'xr-stage']
  )

  for (const preset of presets) {
    assert.equal(isEnvironmentPresetId(preset.id), true)
    assert.equal(preset.xrStage.eyeHeight, 1.6)
    assert.equal(preset.xrStage.spawnPosition[1], 1.6)
    assert.ok(preset.manifest.lights.length > 0)
    assert.ok(preset.floorBounds.width > 0 && preset.floorBounds.depth > 0)
  }
  assert.equal(isEnvironmentPresetId('unknown'), false)

  // Studio preset matches default manifest environment
  const defaultEnv = createDefaultManifest().environment
  assert.deepEqual(getEnvironmentPreset('studio').manifest, defaultEnv)

  // XR Stage preset enables WebXR and bounded-floor
  const xrStage = getEnvironmentPreset('xr-stage')
  assert.equal(xrStage.manifest.xrEnabled, true)
  assert.equal(xrStage.xrStage.referenceSpace, 'bounded-floor')

  // createEnvironmentManifest returns an isolated clone
  const cloned = createEnvironmentManifest('sunset', { exposure: 1.25 })
  cloned.lights[0].intensity = 99
  assert.notEqual(ENVIRONMENT_PRESETS.sunset.manifest.lights[0].intensity, 99)
  assert.equal(cloned.exposure, 1.25)

  // Floor bounds & eye-height helpers
  const bounds = xrStage.floorBounds
  assert.equal(isWithinFloorBounds([0, 1.6, 0], bounds), true)
  assert.equal(isWithinFloorBounds([10, 1.6, 0], bounds), false)
  assert.deepEqual(clampPositionToFloorBounds([10, 0.2, -10], bounds), [
    bounds.maxX,
    1.6,
    bounds.minZ,
  ])
  assert.deepEqual(createXRCameraPose(bounds), {
    position: [0, 1.6, 3],
    target: [0, 1.6, 0],
  })
})
