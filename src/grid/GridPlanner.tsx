import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../lib/feedback'
import type { GridConfig } from '../electron'
import {
  INSET_MAX, INSET_MIN, ZOOM_MAX, ZOOM_MIN, clamp, panBy, placeImage, profileOrder, wheelScale,
  type GridCellRef,
} from './gridMath'
import { loadSnapshotFromDesktop, loadSnapshotFromFiles, type LivePost } from './gridSnapshot'
import { renderGridPng, type ExportCell } from './gridExport'
import { useGridStore, type Draft } from './useGridStore'
import './GridPlanner.css'

/** Nominal cell size the placement math runs in; cells scale with CSS. */
const NOMINAL_W = 300
const nominalH = (aspect: '3:4' | '1:1') => (aspect === '3:4' ? 400 : 300)

const MATTES = { white: '#ffffff', black: '#000000' } as const

interface Props {
  onClose: () => void
  /** The editor's active slide as an image, for "Add current slide". */
  getCurrentSlide?: () => Promise<{ blob: Blob; name: string } | null>
}

type Cell = GridCellRef<Draft | LivePost>

function fmtCount(n: number | null) {
  return n == null ? '–' : n.toLocaleString('en-US')
}

function fmtWhen(iso: string | null) {
  if (!iso) return 'unknown time'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

const imageFiles = (list: FileList | File[] | null | undefined) =>
  Array.from(list ?? []).filter((f) => f.type.startsWith('image/')).map((f) => ({ blob: f as Blob, name: f.name }))

export default function GridPlanner({ onClose, getCurrentSlide }: Props) {
  const st = useGridStore()
  const { snapshot, drafts, selectedId, aspect, appearance, size } = st
  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const desktop = !!window.electronAPI?.gridLoadSnapshot
  const [config, setConfig] = useState<GridConfig | null>(null)
  const [busy, setBusy] = useState<null | 'load' | 'refresh' | 'export'>(null)
  const [dropping, setDropping] = useState(false)

  const selected = drafts.find((d) => d.id === selectedId) ?? null
  const cellH = nominalH(aspect)

  /* ── Snapshot loading ─────────────────────────────────────────── */
  const reload = useCallback(async (quiet = false) => {
    setBusy('load')
    try {
      const s = await loadSnapshotFromDesktop()
      if (s) useGridStore.getState().setSnapshot(s)
      else if (!quiet) toast('Choose the snapshot folder first')
    } catch (e) {
      toast(`Could not read the snapshot: ${(e as Error).message}`, { kind: 'error' })
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    rootRef.current?.focus()
    void useGridStore.getState().hydrate()
    const api = window.electronAPI
    if (!api?.gridGetConfig) return
    void api.gridGetConfig().then((c) => {
      setConfig(c)
      if (c.snapshotDir && !useGridStore.getState().snapshot) void reload(true)
    })
  }, [reload])

  const chooseFolder = async () => {
    if (!desktop) { folderRef.current?.click(); return }
    try {
      const c = await window.electronAPI!.gridPickSnapshotDir!()
      if (c) { setConfig(c); await reload() }
    } catch (e) {
      toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { kind: 'error' })
    }
  }

  const chooseScript = async () => {
    const c = await window.electronAPI?.gridPickRefreshScript?.()
    if (c) setConfig(c)
  }

  const refresh = async () => {
    const api = window.electronAPI
    if (!api?.gridRunRefresh) return
    setBusy('refresh')
    try {
      const r = await api.gridRunRefresh()
      if (!r.ok) { toast(`Refresh failed. ${r.output.slice(-240)}`, { kind: 'error' }); return }
      const s = await loadSnapshotFromDesktop()
      if (s) {
        useGridStore.getState().setSnapshot(s)
        toast(`Profile refreshed: ${s.posts.length} posts`, { kind: 'success' })
      }
    } finally {
      setBusy(null)
    }
  }

  /* ── Grid order ───────────────────────────────────────────────── */
  const cells: Cell[] = useMemo(
    () => profileOrder<Draft, LivePost>(drafts, snapshot?.posts ?? [], st.pinned, st.hidden),
    [drafts, snapshot, st.pinned, st.hidden],
  )

  /* ── Adding images ────────────────────────────────────────────── */
  const add = (files: { blob: Blob; name: string }[], at = 0) => {
    if (!files.length) return
    void useGridStore.getState().addDrafts(files, at)
  }

  const addCurrentSlide = async () => {
    const r = await getCurrentSlide?.()
    if (r) add([r])
    else toast('Nothing on the current slide yet')
  }

  /* ── Gestures on cells ────────────────────────────────────────── */
  const gesture = useRef<null | {
    kind: 'pan' | 'reorder-armed' | 'reorder'
    id: string
    x: number
    y: number
    scale: number // nominal units per screen px
    panX: number
    panY: number
  }>(null)

  const onCellPointerDown = (e: React.PointerEvent, d: Draft) => {
    if (e.button !== 0) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const isSel = d.id === useGridStore.getState().selectedId
    if (!isSel) useGridStore.getState().select(d.id)
    gesture.current = {
      kind: isSel ? 'pan' : 'reorder-armed',
      id: d.id, x: e.clientX, y: e.clientY,
      scale: NOMINAL_W / Math.max(1, rect.width),
      panX: d.panX, panY: d.panY,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onCellPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g) return
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    const store = useGridStore.getState()
    const d = store.drafts.find((x) => x.id === g.id)
    if (!d) return
    if (g.kind === 'pan') {
      const p = panBy(d.natW, d.natH, NOMINAL_W, cellH, { ...d, panX: g.panX, panY: g.panY }, dx * g.scale, dy * g.scale)
      store.updateDraft(d.id, p)
      return
    }
    if (g.kind === 'reorder-armed' && Math.hypot(dx, dy) > 5) g.kind = 'reorder'
    if (g.kind === 'reorder') {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-draft-index]')
      if (!el) return
      const to = Number(el.dataset.draftIndex)
      const from = store.drafts.findIndex((x) => x.id === g.id)
      if (from !== -1 && to !== from) store.moveDraft(from, to)
    }
  }

  const endGesture = () => { gesture.current = null }

  // Wheel scales the selected draft; anywhere else the page scrolls.
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-draft-id]')
      const store = useGridStore.getState()
      if (!cell || cell.dataset.draftId !== store.selectedId) return
      const d = store.drafts.find((x) => x.id === store.selectedId)
      if (!d) return
      e.preventDefault()
      store.updateDraft(d.id, wheelScale(d, e.deltaY))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [snapshot])

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keep keystrokes away from the canvas shortcuts underneath.
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (!selected || (e.target as HTMLElement).matches('input, select, textarea')) return
    const store = useGridStore.getState()
    const step = e.shiftKey ? 0.2 : 0.05
    const nudge: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    }
    if (nudge[e.key]) {
      e.preventDefault()
      const [nx, ny] = nudge[e.key]!
      // Arrows move the picture the way it looks: right = picture right.
      const sign = selected.mode === 'fill' ? -1 : 1
      store.updateDraft(selected.id, {
        panX: clamp(selected.panX + nx * sign, -1, 1),
        panY: clamp(selected.panY + ny * sign, -1, 1),
      })
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      store.removeDraft(selected.id)
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault()
      store.updateDraft(selected.id, wheelScale(selected, e.key === '-' ? 120 : -120))
    }
  }

  /* ── Drop / paste ─────────────────────────────────────────────── */
  const dropIndex = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-draft-index]')
    return el ? Number(el.dataset.draftIndex) : 0
  }

  /* ── Export ───────────────────────────────────────────────────── */
  const exportPng = async () => {
    setBusy('export')
    try {
      const pins = cells.filter((c) => c.kind === 'pinned').length
      const rows = Math.max(4, Math.ceil((pins + drafts.length) / 3) + 3)
      const exportCells: ExportCell[] = cells.map((c) =>
        c.kind === 'draft'
          ? { url: (c.item as Draft).url, placement: c.item as Draft }
          : { url: (c.item as LivePost).thumbUrl })
      const blob = await renderGridPng({
        cells: exportCells,
        aspect: cellH / NOMINAL_W,
        rows,
        background: appearance === 'dark' ? '#000000' : '#ffffff',
        empty: appearance === 'dark' ? '#262626' : '#efefef',
        mattes: MATTES,
      })
      if (!blob) { toast('Nothing to export yet'); return }
      const name = `grid-plan-${new Date().toISOString().slice(0, 10)}.png`
      const api = window.electronAPI
      if (api) {
        const saved = await api.saveFile({
          defaultName: name,
          filters: [{ name: 'PNG', extensions: ['png'] }],
          buffer: new Uint8Array(await blob.arrayBuffer()),
        })
        if (saved) toast('Grid exported', { kind: 'success' })
      } else {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = name
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 2000)
      }
    } finally {
      setBusy(null)
    }
  }

  /* ── Render ───────────────────────────────────────────────────── */
  const acct = snapshot?.account
  const reported = acct?.mediaCount ?? null
  const shortfall = snapshot && reported != null ? reported - snapshot.posts.length : 0

  const renderDraft = (d: Draft, index: number) => {
    const r = placeImage(d.natW, d.natH, NOMINAL_W, cellH, d)
    const seq = drafts.length - index
    return (
      <div
        key={d.id}
        role="button"
        tabIndex={0}
        aria-pressed={d.id === selectedId}
        aria-label={`Planned post ${seq}: ${d.name}`}
        className={`gp-cell gp-cell--draft${d.id === selectedId ? ' gp-cell--selected' : ''}`}
        data-draft-id={d.id}
        data-draft-index={index}
        style={d.mode === 'inset' ? { background: MATTES[d.matte] } : undefined}
        onPointerDown={(e) => onCellPointerDown(e, d)}
        onPointerMove={onCellPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onFocus={() => { if (useGridStore.getState().selectedId !== d.id) useGridStore.getState().select(d.id) }}
      >
        <img
          src={d.url}
          alt=""
          draggable={false}
          className="gp-cell__img"
          style={{
            left: `${(r.x / NOMINAL_W) * 100}%`,
            top: `${(r.y / cellH) * 100}%`,
            width: `${(r.w / NOMINAL_W) * 100}%`,
            height: `${(r.h / cellH) * 100}%`,
          }}
        />
        <span className="gp-cell__badge" title="Posting order: 1 is the next to publish">{seq}</span>
      </div>
    )
  }

  const renderLive = (p: LivePost, pinned: boolean) => (
    <div key={p.id} className={`gp-cell gp-cell--live${pinned ? ' gp-cell--pinned' : ''}`}>
      {p.thumbUrl
        ? <img src={p.thumbUrl} alt="" draggable={false} className="gp-cell__cover" />
        : <span className="gp-cell__missing">No cover</span>}
      {pinned && <span className="gp-cell__pin">Pinned</span>}
      <span className="gp-cell__actions">
        <button type="button" className="gp-chip" onClick={() => st.togglePin(p.id)} title={pinned ? 'Unpin' : 'Pin to the top (Instagram allows three)'}>
          {pinned ? 'Unpin' : 'Pin'}
        </button>
        <button type="button" className="gp-chip" onClick={() => st.toggleHidden(p.id)} title="Leave it out of this plan">
          Hide
        </button>
      </span>
    </div>
  )

  return (
    <div
      ref={rootRef}
      className={`gp${dropping ? ' gp--dropping' : ''}`}
      role="dialog"
      aria-label="Profile grid planner"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPaste={(e) => add(imageFiles(e.clipboardData?.files))}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true) } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false) }}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        add(imageFiles(e.dataTransfer.files), dropIndex(e.clientX, e.clientY))
      }}
    >
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { add(imageFiles(e.target.files)); e.target.value = '' }} />
      <input
        ref={replaceRef} type="file" accept="image/*" hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f && selected) void st.replaceImage(selected.id, f, f.name)
          e.target.value = ''
        }}
      />
      <input
        ref={folderRef} type="file" hidden multiple
        {...({ webkitdirectory: '' } as Record<string, string>)}
        onChange={async (e) => {
          try {
            const s = await loadSnapshotFromFiles(Array.from(e.target.files ?? []))
            st.setSnapshot(s)
          } catch (err) {
            toast((err as Error).message, { kind: 'error' })
          }
          e.target.value = ''
        }}
      />

      <div className="gp__inner">
        <div className="gp__main">
          <header className="gp__head">
            <h1>Profile grid</h1>
            <button type="button" className="btn" onClick={onClose} title="Back to the canvas (Esc)">Back to canvas</button>
          </header>

          <div className="gp__toolbar">
            <button type="button" className="btn btn--accent" onClick={() => fileRef.current?.click()}>Add images</button>
            {getCurrentSlide && <button type="button" className="btn" onClick={() => void addCurrentSlide()}>Add current slide</button>}
            <span className="gp__spacer" />
            {desktop && config?.refreshScript && (
              <button type="button" className="btn" disabled={!!busy} onClick={() => void refresh()} title={config.refreshScript}>
                {busy === 'refresh' ? 'Refreshing…' : 'Refresh profile'}
              </button>
            )}
            <button type="button" className="btn" disabled={!!busy || !cells.length} onClick={() => void exportPng()}>
              {busy === 'export' ? 'Exporting…' : 'Export PNG'}
            </button>
          </div>

          <div className={`gp__stage gp__stage--${size}`}>
            <div className="gp-phone" data-appearance={appearance}>
              {acct ? (
                <div className="gp-profile">
                  <div className="gp-profile__top">
                    <span className="gp-profile__avatar">{acct.avatarUrl && <img src={acct.avatarUrl} alt="" />}</span>
                    <div className="gp-profile__id">
                      <b className="gp-profile__user">{acct.username}</b>
                      <div className="gp-profile__stats">
                        <span><b>{fmtCount(acct.mediaCount)}</b> posts</span>
                        <span><b>{fmtCount(acct.followers)}</b> followers</span>
                        <span><b>{fmtCount(acct.follows)}</b> following</span>
                      </div>
                    </div>
                  </div>
                  {acct.name && <b className="gp-profile__name">{acct.name}</b>}
                  {acct.biography && <p className="gp-profile__bio">{acct.biography}</p>}
                </div>
              ) : (
                <div className="gp-profile gp-profile--empty">
                  <p>No profile loaded. Your planned posts show on their own until you choose a snapshot folder.</p>
                  <button type="button" className="gp-chip gp-chip--solid" onClick={() => void chooseFolder()}>Choose snapshot folder</button>
                </div>
              )}

              <div
                ref={gridRef}
                className="gp-grid"
                style={{ ['--gp-cell-aspect' as string]: aspect === '3:4' ? '3 / 4' : '1 / 1' }}
                onPointerDown={(e) => { if (e.target === e.currentTarget) st.select(null) }}
              >
                {cells.map((c) => {
                  if (c.kind === 'draft') return renderDraft(c.item as Draft, drafts.indexOf(c.item as Draft))
                  return renderLive(c.item as LivePost, c.kind === 'pinned')
                })}
                {!cells.length && (
                  <button type="button" className="gp-cell gp-cell--add" onClick={() => fileRef.current?.click()}>
                    Drop images here
                  </button>
                )}
                {cells.length > 0 && cells.length % 3 !== 0 && Array.from({ length: 3 - (cells.length % 3) }, (_, i) => (
                  <span key={`pad${i}`} className="gp-cell gp-cell--pad" aria-hidden />
                ))}
              </div>
            </div>
          </div>
        </div>

        <aside className="gp__side">
          {selected ? (
            <section className="gp-panel">
              <h2 className="gp-panel__title">Planned post {drafts.length - drafts.indexOf(selected)}</h2>
              <p className="gp-panel__meta" title={selected.name}>{selected.name}<br />{selected.natW}×{selected.natH}</p>

              <div className="app__presets" role="group" aria-label="Placement">
                {(['fill', 'inset'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`btn ${selected.mode === m ? 'btn--seg-active' : ''}`}
                    style={{ flex: 1 }}
                    onClick={() => st.updateDraft(selected.id, { mode: m, panX: 0, panY: 0 })}
                    title={m === 'fill' ? 'Fill the cell, the way the grid crops it' : 'Smaller, on a white or black matte'}
                  >
                    {m === 'fill' ? 'Fill' : 'Inset'}
                  </button>
                ))}
              </div>

              {selected.mode === 'fill' ? (
                <label className="slider-field">
                  <span className="slider-field__label">Zoom<span className="slider-field__value">{Math.round(selected.zoom * 100)}%</span></span>
                  <input
                    type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={0.01} value={selected.zoom}
                    style={{ ['--fill' as string]: `${((selected.zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100}%` }}
                    onChange={(e) => st.updateDraft(selected.id, { zoom: Number(e.target.value) })}
                    onDoubleClick={() => st.updateDraft(selected.id, { zoom: 1 })}
                  />
                </label>
              ) : (
                <>
                  <label className="slider-field">
                    <span className="slider-field__label">Size<span className="slider-field__value">{Math.round(selected.insetScale * 100)}%</span></span>
                    <input
                      type="range" min={INSET_MIN} max={INSET_MAX} step={0.01} value={selected.insetScale}
                      style={{ ['--fill' as string]: `${((selected.insetScale - INSET_MIN) / (INSET_MAX - INSET_MIN)) * 100}%` }}
                      onChange={(e) => st.updateDraft(selected.id, { insetScale: Number(e.target.value) })}
                      onDoubleClick={() => st.updateDraft(selected.id, { insetScale: 0.8 })}
                    />
                  </label>
                  <div className="app__presets" role="group" aria-label="Matte">
                    {(['white', 'black'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`btn ${selected.matte === m ? 'btn--seg-active' : ''}`}
                        style={{ flex: 1 }}
                        onClick={() => st.updateDraft(selected.id, { matte: m })}
                      >
                        <span className="gp-swatch" style={{ background: MATTES[m] }} aria-hidden />
                        {m === 'white' ? 'White' : 'Black'}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <p className="gp-panel__hint">Drag the picture to move it. Scroll or press + and − to scale. Drag another planned post to reorder.</p>

              <div className="gp-panel__row">
                <button type="button" className="btn btn--sm" onClick={() => st.updateDraft(selected.id, { panX: 0, panY: 0 })}>Centre</button>
                <button type="button" className="btn btn--sm" onClick={() => replaceRef.current?.click()}>Replace</button>
                <button type="button" className="btn btn--sm btn--danger" onClick={() => st.removeDraft(selected.id)}>Remove</button>
              </div>
            </section>
          ) : (
            <section className="gp-panel">
              <h2 className="gp-panel__title">Plan the next posts</h2>
              <p className="gp-panel__hint">
                Add, drop or paste images. They go in above the published posts, the way they will appear once posted.
              </p>
              {drafts.length > 0 && <p className="gp-panel__hint">{drafts.length} planned. Select one to place it.</p>}
            </section>
          )}

          <section className="gp-panel">
            <h2 className="gp-panel__title">View</h2>
            <div className="gp-panel__field">
              <span>Grid crop</span>
              <div className="app__presets" role="group" aria-label="Grid crop">
                {(['3:4', '1:1'] as const).map((a) => (
                  <button key={a} type="button" className={`btn ${aspect === a ? 'btn--seg-active' : ''}`} onClick={() => st.setView({ aspect: a })}
                    title={a === '3:4' ? 'Instagram’s current profile grid' : 'The old square grid'}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
            <div className="gp-panel__field">
              <span>Instagram</span>
              <div className="app__presets" role="group" aria-label="Instagram appearance">
                {(['light', 'dark'] as const).map((a) => (
                  <button key={a} type="button" className={`btn ${appearance === a ? 'btn--seg-active' : ''}`} onClick={() => st.setView({ appearance: a })}>
                    {a === 'light' ? 'Light' : 'Dark'}
                  </button>
                ))}
              </div>
            </div>
            <div className="gp-panel__field">
              <span>Size</span>
              <div className="app__presets" role="group" aria-label="Preview size">
                {(['phone', 'large'] as const).map((a) => (
                  <button key={a} type="button" className={`btn ${size === a ? 'btn--seg-active' : ''}`} onClick={() => st.setView({ size: a })}>
                    {a === 'phone' ? 'Phone' : 'Large'}
                  </button>
                ))}
              </div>
            </div>
            {st.hidden.length > 0 && (
              <button type="button" className="btn btn--sm" onClick={() => st.showAllHidden()}>
                Show {st.hidden.length} hidden {st.hidden.length === 1 ? 'post' : 'posts'}
              </button>
            )}
          </section>

          <section className="gp-panel">
            <h2 className="gp-panel__title">Profile snapshot</h2>
            {snapshot ? (
              <p className="gp-panel__hint">
                {snapshot.posts.length} posts from {fmtWhen(snapshot.fetchedAt)}.
                {shortfall > 0 && <> Instagram reports {reported}; the API did not return {shortfall}.</>}
                {snapshot.missing > 0 && <> {snapshot.missing} covers missing.</>}
                {' '}Pinned posts and custom grid crops are not in the snapshot: pin by hand.
              </p>
            ) : (
              <p className="gp-panel__hint">No snapshot loaded.</p>
            )}
            {config?.snapshotDir && <p className="gp-panel__path" title={config.snapshotDir}>{config.snapshotDir}</p>}
            <div className="gp-panel__row">
              <button type="button" className="btn btn--sm" onClick={() => void chooseFolder()}>{snapshot ? 'Change folder' : 'Choose folder'}</button>
              {desktop && config?.snapshotDir && (
                <button type="button" className="btn btn--sm" disabled={!!busy} onClick={() => void reload()}>Reload</button>
              )}
            </div>
            {desktop && (
              <>
                <p className="gp-panel__hint">
                  {config?.refreshScript
                    ? <>Refresh runs <span className="gp-panel__path" title={config.refreshScript}>{config.refreshScript.split(/[/\\]/).pop()}</span></>
                    : 'Choose the script that writes the snapshot to refresh it from here.'}
                </p>
                <div className="gp-panel__row">
                  <button type="button" className="btn btn--sm" onClick={() => void chooseScript()}>{config?.refreshScript ? 'Change script' : 'Choose script'}</button>
                  {config?.refreshScript && (
                    <button type="button" className="btn btn--sm" onClick={() => void window.electronAPI?.gridClearRefreshScript?.().then(setConfig)}>Clear</button>
                  )}
                </div>
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
