import { create } from 'zustand'
import { DEFAULT_PLACEMENT, moveItem, type Placement } from './gridMath'
import { kvDelete, kvGet, kvSet } from './gridPersist'
import { releaseSnapshot, type ProfileSnapshot } from './gridSnapshot'

export type Matte = 'white' | 'black'
export type GridAspect = '3:4' | '1:1'
export type Appearance = 'light' | 'dark'
export type GridSize = 'phone' | 'large'

export interface Draft extends Placement {
  id: string
  name: string
  url: string
  natW: number
  natH: number
  matte: Matte
}

type DraftMeta = Omit<Draft, 'url'>

interface SavedPlan {
  drafts: DraftMeta[]
  pinned: string[]
  hidden: string[]
  aspect: GridAspect
  appearance: Appearance
  size: GridSize
}

interface GridState {
  hydrated: boolean
  snapshot: ProfileSnapshot | null
  drafts: Draft[]
  selectedId: string | null
  pinned: string[]
  hidden: string[]
  aspect: GridAspect
  appearance: Appearance
  size: GridSize

  hydrate: () => Promise<void>
  setSnapshot: (s: ProfileSnapshot | null) => void
  addDrafts: (files: { blob: Blob; name: string }[], at?: number) => Promise<void>
  replaceImage: (id: string, blob: Blob, name: string) => Promise<void>
  updateDraft: (id: string, patch: Partial<Draft>) => void
  removeDraft: (id: string) => void
  moveDraft: (from: number, to: number) => void
  select: (id: string | null) => void
  togglePin: (id: string) => void
  toggleHidden: (id: string) => void
  showAllHidden: () => void
  setView: (patch: Partial<Pick<GridState, 'aspect' | 'appearance' | 'size'>>) => void
}

const uid = () => `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`

async function measure(blob: Blob): Promise<{ url: string; w: number; h: number }> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { url, w: img.naturalWidth, h: img.naturalHeight }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

export const useGridStore = create<GridState>((set, get) => ({
  hydrated: false,
  snapshot: null,
  drafts: [],
  selectedId: null,
  pinned: [],
  hidden: [],
  aspect: '3:4',
  appearance: 'light',
  size: 'phone',

  hydrate: async () => {
    if (get().hydrated) return
    try {
      const plan = await kvGet<SavedPlan>('plan')
      if (plan) {
        const drafts: Draft[] = []
        for (const m of plan.drafts ?? []) {
          const blob = await kvGet<Blob>(`img:${m.id}`)
          if (!blob) continue
          drafts.push({ ...m, url: URL.createObjectURL(blob) })
        }
        set({
          drafts,
          pinned: plan.pinned ?? [],
          hidden: plan.hidden ?? [],
          aspect: plan.aspect ?? '3:4',
          appearance: plan.appearance ?? 'light',
          size: plan.size ?? 'phone',
        })
      }
    } catch {
      // No IndexedDB (or a corrupt plan): start empty, still usable.
    }
    set({ hydrated: true })
  },

  setSnapshot: (s) => {
    const prev = get().snapshot
    if (prev && prev !== s) releaseSnapshot(prev)
    set({ snapshot: s })
  },

  addDrafts: async (files, at = 0) => {
    const added: Draft[] = []
    for (const f of files) {
      try {
        const { url, w, h } = await measure(f.blob)
        const id = uid()
        await kvSet(`img:${id}`, f.blob).catch(() => {})
        added.push({ ...DEFAULT_PLACEMENT, id, name: f.name, url, natW: w, natH: h, matte: 'white' })
      } catch {
        // Not a decodable image — skip it.
      }
    }
    if (!added.length) return
    const drafts = get().drafts.slice()
    drafts.splice(Math.max(0, Math.min(at, drafts.length)), 0, ...added)
    set({ drafts, selectedId: added[0]!.id })
  },

  replaceImage: async (id, blob, name) => {
    const { url, w, h } = await measure(blob)
    await kvSet(`img:${id}`, blob).catch(() => {})
    set({
      drafts: get().drafts.map((d) => {
        if (d.id !== id) return d
        URL.revokeObjectURL(d.url)
        return { ...d, url, natW: w, natH: h, name, panX: 0, panY: 0, zoom: 1 }
      }),
    })
  },

  updateDraft: (id, patch) => set({ drafts: get().drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)) }),

  removeDraft: (id) => {
    const d = get().drafts.find((x) => x.id === id)
    if (d) URL.revokeObjectURL(d.url)
    void kvDelete(`img:${id}`).catch(() => {})
    set({ drafts: get().drafts.filter((x) => x.id !== id), selectedId: get().selectedId === id ? null : get().selectedId })
  },

  moveDraft: (from, to) => set({ drafts: moveItem(get().drafts, from, to) }),

  select: (id) => set({ selectedId: id }),

  togglePin: (id) => {
    const pinned = get().pinned
    set({ pinned: pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id].slice(-3) })
  },

  toggleHidden: (id) => {
    const hidden = get().hidden
    set({ hidden: hidden.includes(id) ? hidden.filter((p) => p !== id) : [...hidden, id] })
  },

  showAllHidden: () => set({ hidden: [] }),

  setView: (patch) => set(patch),
}))

// Persist the plan (not the snapshot) a moment after it settles.
useGridStore.subscribe((s, prev) => {
  if (!s.hydrated) return
  if (s.drafts === prev.drafts && s.pinned === prev.pinned && s.hidden === prev.hidden
    && s.aspect === prev.aspect && s.appearance === prev.appearance && s.size === prev.size) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const st = useGridStore.getState()
    const plan: SavedPlan = {
      drafts: st.drafts.map((d) => { const m: Partial<Draft> = { ...d }; delete m.url; return m as DraftMeta }),
      pinned: st.pinned,
      hidden: st.hidden,
      aspect: st.aspect,
      appearance: st.appearance,
      size: st.size,
    }
    void kvSet('plan', plan).catch(() => {})
  }, 250)
})
