export type SelectionState = { primary: string; ids: string[] }

export function selectOne(current: SelectionState, id: string, additive: boolean): SelectionState {
  if (!additive) return { primary: id, ids: [id] }
  if (!current.ids.includes(id)) return { primary: id, ids: [...current.ids, id] }
  const ids = current.ids.filter((item) => item !== id)
  return { primary: current.primary === id ? (ids.at(-1) ?? '') : current.primary, ids }
}

export function selectMany(current: SelectionState, ids: string[], additive: boolean): SelectionState {
  const uniqueIds = [...new Set(ids)]
  if (!additive) return { primary: uniqueIds.at(-1) ?? '', ids: uniqueIds }
  const merged = [...new Set([...current.ids, ...uniqueIds])]
  return { primary: uniqueIds.at(-1) ?? current.primary, ids: merged }
}
