import { DEFAULT_PLACEMENT, placeImage, type Placement } from './gridMath'

export interface ExportCell {
  url: string | null
  placement?: Placement & { natW: number; natH: number; matte: string }
}

async function load(url: string): Promise<HTMLImageElement | null> {
  const img = new Image()
  img.src = url
  try { await img.decode(); return img } catch { return null }
}

/**
 * The planned grid as one PNG, drawn with the same geometry as the screen:
 * 1080 px wide (Instagram's own column width ×3), `rows` rows deep.
 */
export async function renderGridPng(opts: {
  cells: ExportCell[]
  aspect: number // cell height / width
  rows: number
  background: string
  empty: string
  mattes: Record<string, string>
}): Promise<Blob | null> {
  const W = 1080
  const gap = 4
  const cw = (W - gap * 2) / 3
  const ch = cw * opts.aspect
  const cells = opts.cells.slice(0, opts.rows * 3)
  const rows = Math.ceil(cells.length / 3)
  if (!rows) return null
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = Math.round(rows * ch + (rows - 1) * gap)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = opts.background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const images = await Promise.all(cells.map((c) => (c.url ? load(c.url) : Promise.resolve(null))))
  cells.forEach((c, i) => {
    const x = (i % 3) * (cw + gap)
    const y = Math.floor(i / 3) * (ch + gap)
    const img = images[i]
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, cw, ch)
    ctx.clip()
    if (!img) {
      ctx.fillStyle = opts.empty
      ctx.fillRect(x, y, cw, ch)
    } else {
      const p = c.placement ?? { ...DEFAULT_PLACEMENT, natW: img.naturalWidth, natH: img.naturalHeight, matte: 'white' }
      if (p.mode === 'inset') {
        ctx.fillStyle = opts.mattes[p.matte] ?? opts.empty
        ctx.fillRect(x, y, cw, ch)
      }
      const r = placeImage(img.naturalWidth, img.naturalHeight, cw, ch, p)
      ctx.drawImage(img, x + r.x, y + r.y, r.w, r.h)
    }
    ctx.restore()
  })
  return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}
