/**
 * Geometry for the profile-grid planner. Pure functions, no DOM, so the
 * on-screen cells, the drag gestures and the PNG export agree exactly.
 *
 * A draft sits in its cell in one of two ways:
 *  - fill:  the image covers the cell (Instagram's own grid crop). `zoom`
 *           ≥ 1 scales past cover; `panX/panY` ∈ [-1, 1] slide the crop
 *           window across the overflow (0 = centred, -1 = left/top edge).
 *  - inset: the image is contained, scaled down by `insetScale`, on a
 *           flat matte. `panX/panY` ∈ [-1, 1] slide it across the free
 *           space (0 = centred, -1 = against the left/top edge).
 */

export type DraftMode = 'fill' | 'inset'

export interface Placement {
  mode: DraftMode
  zoom: number
  panX: number
  panY: number
  insetScale: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const ZOOM_MIN = 1
export const ZOOM_MAX = 4
export const INSET_MIN = 0.2
export const INSET_MAX = 1

export const DEFAULT_PLACEMENT: Placement = {
  mode: 'fill',
  zoom: 1,
  panX: 0,
  panY: 0,
  insetScale: 0.8,
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Where to draw an image of `imgW×imgH` inside a `cellW×cellH` cell. */
export function placeImage(imgW: number, imgH: number, cellW: number, cellH: number, p: Placement): Rect {
  if (imgW <= 0 || imgH <= 0 || cellW <= 0 || cellH <= 0) return { x: 0, y: 0, w: cellW, h: cellH }
  if (p.mode === 'inset') {
    const s = Math.min(cellW / imgW, cellH / imgH) * clamp(p.insetScale, INSET_MIN, INSET_MAX)
    const w = imgW * s
    const h = imgH * s
    const fx = cellW - w
    const fy = cellH - h
    return { x: (fx / 2) * (1 + clamp(p.panX, -1, 1)), y: (fy / 2) * (1 + clamp(p.panY, -1, 1)), w, h }
  }
  const s = Math.max(cellW / imgW, cellH / imgH) * clamp(p.zoom, ZOOM_MIN, ZOOM_MAX)
  const w = imgW * s
  const h = imgH * s
  const ox = w - cellW
  const oy = h - cellH
  return { x: -(ox / 2) * (1 + clamp(p.panX, -1, 1)), y: -(oy / 2) * (1 + clamp(p.panY, -1, 1)), w, h }
}

/**
 * Pan after dragging the pointer by (dx, dy) cell pixels: the image follows
 * the pointer in both modes. Axes with no room to move stay put.
 */
export function panBy(
  imgW: number, imgH: number, cellW: number, cellH: number, p: Placement, dx: number, dy: number,
): { panX: number; panY: number } {
  const r = placeImage(imgW, imgH, cellW, cellH, { ...p, panX: 0, panY: 0 })
  if (p.mode === 'inset') {
    const hx = (cellW - r.w) / 2
    const hy = (cellH - r.h) / 2
    return {
      panX: hx > 0.5 ? clamp(p.panX + dx / hx, -1, 1) : 0,
      panY: hy > 0.5 ? clamp(p.panY + dy / hy, -1, 1) : 0,
    }
  }
  const hx = (r.w - cellW) / 2
  const hy = (r.h - cellH) / 2
  return {
    panX: hx > 0.5 ? clamp(p.panX - dx / hx, -1, 1) : 0,
    panY: hy > 0.5 ? clamp(p.panY - dy / hy, -1, 1) : 0,
  }
}

/** One wheel notch scales by ~6 %; returns the patch for the active mode. */
export function wheelScale(p: Placement, deltaY: number): Partial<Placement> {
  const f = Math.exp(-deltaY * 0.0012)
  return p.mode === 'inset'
    ? { insetScale: clamp(p.insetScale * f, INSET_MIN, INSET_MAX) }
    : { zoom: clamp(p.zoom * f, ZOOM_MIN, ZOOM_MAX) }
}

export interface GridCellRef<T> {
  kind: 'pinned' | 'draft' | 'live'
  item: T
}

/**
 * Profile order as Instagram shows it: pinned posts first (max 3), then the
 * planned drafts (newest at the top), then the remaining published posts
 * newest first. Hidden posts drop out.
 */
export function profileOrder<D, L extends { id: string }>(
  drafts: D[], live: L[], pinnedIds: string[], hiddenIds: string[],
): GridCellRef<D | L>[] {
  const hidden = new Set(hiddenIds)
  const byId = new Map(live.map((l) => [l.id, l]))
  const pins = pinnedIds.filter((id) => byId.has(id) && !hidden.has(id)).slice(0, 3)
  const pinSet = new Set(pins)
  return [
    ...pins.map((id) => ({ kind: 'pinned' as const, item: byId.get(id)! })),
    ...drafts.map((d) => ({ kind: 'draft' as const, item: d })),
    ...live.filter((l) => !pinSet.has(l.id) && !hidden.has(l.id)).map((l) => ({ kind: 'live' as const, item: l })),
  ]
}

/** Move the element at `from` to index `to` (returns a new array). */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= arr.length) return arr
  const out = arr.slice()
  const [x] = out.splice(from, 1)
  out.splice(clamp(to, 0, out.length), 0, x!)
  return out
}
