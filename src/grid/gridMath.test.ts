import { describe, expect, it } from 'vitest'
import { DEFAULT_PLACEMENT, moveItem, panBy, placeImage, profileOrder, wheelScale } from './gridMath'

const fill = { ...DEFAULT_PLACEMENT, mode: 'fill' as const }
const inset = { ...DEFAULT_PLACEMENT, mode: 'inset' as const, insetScale: 0.5 }

describe('placeImage', () => {
  it('covers a 3:4 cell with a 16:9 image, centred', () => {
    const r = placeImage(1600, 900, 300, 400, fill)
    expect(r.h).toBeCloseTo(400)
    expect(r.w).toBeCloseTo(711.11, 1)
    expect(r.x).toBeCloseTo(-(711.11 - 300) / 2, 1)
    expect(r.y).toBeCloseTo(0)
  })

  it('pans to the crop edges at ±1', () => {
    expect(placeImage(1600, 900, 300, 400, { ...fill, panX: -1 }).x).toBeCloseTo(0)
    const right = placeImage(1600, 900, 300, 400, { ...fill, panX: 1 })
    expect(right.x + right.w).toBeCloseTo(300)
  })

  it('zoom scales past cover', () => {
    expect(placeImage(300, 400, 300, 400, { ...fill, zoom: 2 }).w).toBeCloseTo(600)
  })

  it('insets on the matte, contained and scaled', () => {
    const r = placeImage(1600, 900, 300, 400, inset)
    expect(r.w).toBeCloseTo(150)
    expect(r.h).toBeCloseTo(84.375)
    expect(r.x).toBeCloseTo(75)
    expect(r.y).toBeCloseTo((400 - 84.375) / 2)
  })

  it('never returns an invalid rect for empty images', () => {
    expect(placeImage(0, 0, 300, 400, fill)).toEqual({ x: 0, y: 0, w: 300, h: 400 })
  })
})

describe('panBy', () => {
  it('fill: dragging right reveals the left of the image', () => {
    const { panX, panY } = panBy(1600, 900, 300, 400, fill, 50, 0)
    expect(panX).toBeLessThan(0)
    expect(panY).toBe(0) // no vertical overflow
    const r = placeImage(1600, 900, 300, 400, { ...fill, panX, panY })
    const r0 = placeImage(1600, 900, 300, 400, fill)
    expect(r.x - r0.x).toBeCloseTo(50)
  })

  it('inset: the image follows the pointer and stops at the edge', () => {
    const { panX } = panBy(1600, 900, 300, 400, inset, 30, 0)
    const r = placeImage(1600, 900, 300, 400, { ...inset, panX })
    expect(r.x).toBeCloseTo(105)
    expect(panBy(1600, 900, 300, 400, inset, 9999, 0).panX).toBe(1)
  })
})

describe('wheelScale', () => {
  it('zooms in on wheel up and clamps', () => {
    expect(wheelScale(fill, -100).zoom!).toBeGreaterThan(1)
    expect(wheelScale(fill, 100).zoom).toBe(1)
    expect(wheelScale(inset, 100).insetScale!).toBeLessThan(0.5)
  })
})

describe('profileOrder', () => {
  const live = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  it('puts pins first, then drafts, then the rest, skipping hidden', () => {
    const order = profileOrder([{ id: 'x' }], live, ['c'], ['b'])
    expect(order.map((c) => `${c.kind}:${c.item.id}`)).toEqual(['pinned:c', 'draft:x', 'live:a', 'live:d'])
  })
  it('caps pins at three and ignores unknown ids', () => {
    const order = profileOrder([], live, ['zz', 'a', 'b', 'c', 'd'], [])
    expect(order.filter((c) => c.kind === 'pinned').map((c) => c.item.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('moveItem', () => {
  it('moves without mutating', () => {
    const a = [1, 2, 3, 4]
    expect(moveItem(a, 0, 2)).toEqual([2, 3, 1, 4])
    expect(a).toEqual([1, 2, 3, 4])
  })
})
