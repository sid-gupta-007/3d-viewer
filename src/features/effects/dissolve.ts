export type EffectTiming = { targetId: string; startTime: number; endTime: number; seed: number }
export type DissolveEffect = EffectTiming & {
  kind?: 'dissolve'
  edgeColor: string
  edgeWidth: number
}
export type BurnEffect = EffectTiming & {
  kind: 'burn'
  edgeColor: string
  edgeWidth: number
  flameColor: string
}
export type ParticleEffect = EffectTiming & {
  kind: 'particles'
  color: string
  particleCount: number
  particleSize: number
}
export type SceneEffect = DissolveEffect | BurnEffect | ParticleEffect

export type SurfaceEffect = DissolveEffect | BurnEffect

export function effectSeedOffset(seed: number) {
  return ((seed >>> 0) / 0xffffffff) * 64
}

export function dissolveProgress(effect: EffectTiming, time: number) {
  if (time <= effect.startTime) return 0
  if (time >= effect.endTime) return 1
  return (time - effect.startTime) / (effect.endTime - effect.startTime)
}

export function isDissolveEffect(value: unknown): value is DissolveEffect {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const effect = value as Record<string, unknown>
  return (effect.kind === undefined || effect.kind === 'dissolve')
    && typeof effect.targetId === 'string'
    && typeof effect.startTime === 'number' && Number.isFinite(effect.startTime) && effect.startTime >= 0
    && typeof effect.endTime === 'number' && Number.isFinite(effect.endTime) && effect.endTime > effect.startTime
    && typeof effect.edgeColor === 'string' && /^#[\da-f]{6}$/i.test(effect.edgeColor)
    && typeof effect.edgeWidth === 'number' && Number.isFinite(effect.edgeWidth) && effect.edgeWidth >= 0.005 && effect.edgeWidth <= 0.25
    && typeof effect.seed === 'number' && Number.isInteger(effect.seed) && effect.seed >= 0 && effect.seed <= 0xffffffff
}

export function isBurnEffect(value: unknown): value is BurnEffect {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const effect = value as Record<string, unknown>
  return effect.kind === 'burn'
    && typeof effect.targetId === 'string' && typeof effect.startTime === 'number' && Number.isFinite(effect.startTime) && effect.startTime >= 0
    && typeof effect.endTime === 'number' && Number.isFinite(effect.endTime) && effect.endTime > effect.startTime
    && typeof effect.edgeColor === 'string' && /^#[\da-f]{6}$/i.test(effect.edgeColor)
    && typeof effect.flameColor === 'string' && /^#[\da-f]{6}$/i.test(effect.flameColor)
    && typeof effect.edgeWidth === 'number' && Number.isFinite(effect.edgeWidth) && effect.edgeWidth >= 0.005 && effect.edgeWidth <= 0.25
    && typeof effect.seed === 'number' && Number.isInteger(effect.seed) && effect.seed >= 0 && effect.seed <= 0xffffffff
}

export function isParticleEffect(value: unknown): value is ParticleEffect {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const effect = value as Record<string, unknown>
  return effect.kind === 'particles'
    && typeof effect.targetId === 'string' && typeof effect.startTime === 'number' && Number.isFinite(effect.startTime) && effect.startTime >= 0
    && typeof effect.endTime === 'number' && Number.isFinite(effect.endTime) && effect.endTime > effect.startTime
    && typeof effect.color === 'string' && /^#[\da-f]{6}$/i.test(effect.color)
    && typeof effect.particleCount === 'number' && Number.isInteger(effect.particleCount) && effect.particleCount >= 16 && effect.particleCount <= 2048
    && typeof effect.particleSize === 'number' && Number.isFinite(effect.particleSize) && effect.particleSize >= 1 && effect.particleSize <= 24
    && typeof effect.seed === 'number' && Number.isInteger(effect.seed) && effect.seed >= 0 && effect.seed <= 0xffffffff
}

export function isSceneEffect(value: unknown): value is SceneEffect {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const effect = value as Record<string, unknown>
    if (effect.kind === 'burn') return isBurnEffect(value)
    if (effect.kind === 'particles') return isParticleEffect(value)
  }
  return isDissolveEffect(value)
}

export function isSurfaceEffect(effect: SceneEffect): effect is SurfaceEffect {
  return effect.kind !== 'particles'
}
