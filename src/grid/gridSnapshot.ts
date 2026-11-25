/**
 * Profile snapshot — the published side of the grid. Tiovivo only reads a
 * folder written by an external exporter (see electron/grid.ts for the
 * format); this file parses it into object URLs the planner can draw.
 */

export interface LivePost {
  id: string
  permalink: string | null
  timestamp: string
  mediaType: string
  caption: string
  thumbUrl: string | null
}

export interface ProfileSnapshot {
  fetchedAt: string | null
  source: string | null
  dir: string | null
  account: {
    username: string
    name: string
    biography: string
    website: string
    mediaCount: number | null
    followers: number | null
    follows: number | null
    avatarUrl: string | null
  }
  posts: LivePost[]
  /** Files grid.json referenced but the folder didn't have. */
  missing: number
  /** Object URLs owned by this snapshot — revoke when it's replaced. */
  urls: string[]
}

interface RawSnapshot {
  version?: number
  fetchedAt?: string
  source?: string
  account?: {
    username?: string; name?: string; biography?: string; website?: string
    mediaCount?: number; followers?: number; follows?: number; avatar?: string | null
  }
  posts?: { id?: string; permalink?: string; timestamp?: string; mediaType?: string; caption?: string; thumb?: string | null }[]
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function mime(path: string) {
  return /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg'
}

/** Build a snapshot from grid.json text and a lookup of its files' bytes. */
export function parseSnapshot(
  json: string,
  fileFor: (rel: string) => BlobPart | null,
  dir: string | null,
  missingFiles = 0,
): ProfileSnapshot {
  const raw = JSON.parse(json) as RawSnapshot
  if (!raw || !Array.isArray(raw.posts)) throw new Error('grid.json has no posts list')
  const urls: string[] = []
  let missing = missingFiles
  const urlFor = (rel: string | null | undefined): string | null => {
    if (!rel) return null
    const bytes = fileFor(rel)
    if (!bytes) { missing++; return null }
    const u = URL.createObjectURL(new Blob([bytes], { type: mime(rel) }))
    urls.push(u)
    return u
  }
  const posts: LivePost[] = raw.posts
    .filter((p) => typeof p.id === 'string')
    .map((p) => ({
      id: p.id!,
      permalink: p.permalink ?? null,
      timestamp: str(p.timestamp),
      mediaType: str(p.mediaType) || 'IMAGE',
      caption: str(p.caption),
      thumbUrl: urlFor(p.thumb),
    }))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
  const a = raw.account ?? {}
  return {
    fetchedAt: raw.fetchedAt ?? null,
    source: raw.source ?? null,
    dir,
    account: {
      username: str(a.username) || 'profile',
      name: str(a.name),
      biography: str(a.biography),
      website: str(a.website),
      mediaCount: num(a.mediaCount),
      followers: num(a.followers),
      follows: num(a.follows),
      avatarUrl: urlFor(a.avatar),
    },
    posts,
    missing,
    urls,
  }
}

/** Desktop: read the folder the user chose, through main. */
export async function loadSnapshotFromDesktop(): Promise<ProfileSnapshot | null> {
  const api = window.electronAPI
  if (!api?.gridLoadSnapshot) return null
  const payload = await api.gridLoadSnapshot()
  if (!payload) return null
  return parseSnapshot(payload.json, (rel) => (payload.files[rel] as BlobPart | undefined) ?? null, payload.dir, payload.missing)
}

/** Browser (and drag-in): a folder picked with <input webkitdirectory>. */
export async function loadSnapshotFromFiles(files: File[]): Promise<ProfileSnapshot> {
  const rel = (f: File) => {
    const p = (f.webkitRelativePath || f.name).replace(/\\/g, '/')
    const parts = p.split('/')
    return parts.length > 1 ? parts.slice(1).join('/') : p
  }
  // Folder pickers give relative paths; loose files (a drop, a multi-select)
  // only carry names, so fall back to matching on the file name.
  const base = (p: string) => p.split('/').pop() ?? p
  const map = new Map(files.map((f) => [rel(f), f]))
  const byName = new Map(files.map((f) => [f.name, f]))
  const json = map.get('grid.json') ?? byName.get('grid.json')
  if (!json) throw new Error('That folder has no grid.json')
  const raw = await json.text()
  const cache = new Map<File, ArrayBuffer>()
  const wanted = new Set<File>()
  const pick = (k: string) => map.get(k) ?? byName.get(base(k)) ?? null
  const parsed = JSON.parse(raw) as RawSnapshot
  for (const k of [parsed.account?.avatar, ...(parsed.posts ?? []).map((p) => p.thumb)]) {
    const f = k ? pick(k) : null
    if (f) wanted.add(f)
  }
  await Promise.all([...wanted].map(async (f) => { cache.set(f, await f.arrayBuffer()) }))
  return parseSnapshot(raw, (k) => { const f = pick(k); return f ? cache.get(f) ?? null : null }, null)
}

export function releaseSnapshot(s: ProfileSnapshot | null) {
  for (const u of s?.urls ?? []) URL.revokeObjectURL(u)
}
