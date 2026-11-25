/**
 * Profile-grid planner — main-process side.
 *
 * Tiovivo never talks to Instagram. An external exporter (any script the
 * user picks) writes a snapshot folder:
 *
 *   grid.json        { version: 1, fetchedAt, account: {…, avatar?}, posts: [{ id, timestamp, thumb, … }] }
 *   avatar.jpg       optional, referenced by account.avatar
 *   thumbs/<id>.jpg  one grid cover per post, referenced by posts[].thumb
 *
 * This module remembers the folder and the optional refresh script the
 * user chose, reads the snapshot (only files inside that folder), and runs
 * the refresh script on request. Credentials stay with the exporter.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

interface GridConfig {
  snapshotDir: string | null
  refreshScript: string | null
}

const configPath = () => path.join(app.getPath('userData'), 'grid-planner.json')

function readConfig(): GridConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<GridConfig>
    return {
      snapshotDir: typeof raw.snapshotDir === 'string' ? raw.snapshotDir : null,
      refreshScript: typeof raw.refreshScript === 'string' ? raw.refreshScript : null,
    }
  } catch {
    return { snapshotDir: null, refreshScript: null }
  }
}

function writeConfig(patch: Partial<GridConfig>): GridConfig {
  const next = { ...readConfig(), ...patch }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2))
  return next
}

/** Resolve a snapshot-relative path, refusing anything outside the folder. */
function inside(dir: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel) return null
  const root = path.resolve(dir)
  const full = path.resolve(root, rel)
  return full.startsWith(root + path.sep) ? full : null
}

const parentOf = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender) ?? undefined

export interface GridSnapshotPayload {
  dir: string
  json: string
  files: Record<string, Uint8Array>
  missing: number
}

export function initGrid() {
  ipcMain.handle('grid-get-config', () => readConfig())

  ipcMain.handle('grid-pick-snapshot-dir', async (e) => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose the profile snapshot folder (contains grid.json)',
      properties: ['openDirectory'],
    }
    const parent = parentOf(e)
    const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    const dir = res.filePaths[0]
    if (!fs.existsSync(path.join(dir, 'grid.json'))) {
      throw new Error('That folder has no grid.json')
    }
    return writeConfig({ snapshotDir: dir })
  })

  ipcMain.handle('grid-load-snapshot', async (): Promise<GridSnapshotPayload | null> => {
    const { snapshotDir } = readConfig()
    if (!snapshotDir) return null
    const json = await fs.promises.readFile(path.join(snapshotDir, 'grid.json'), 'utf8')
    const parsed = JSON.parse(json) as { account?: { avatar?: unknown }; posts?: { thumb?: unknown }[] }
    const rels = [parsed.account?.avatar, ...(parsed.posts ?? []).map((p) => p.thumb)]
    const files: Record<string, Uint8Array> = {}
    let missing = 0
    await Promise.all(rels.map(async (rel) => {
      const full = inside(snapshotDir, rel)
      if (!full) return
      try {
        files[rel as string] = new Uint8Array(await fs.promises.readFile(full))
      } catch {
        missing++
      }
    }))
    return { dir: snapshotDir, json, files, missing }
  })

  ipcMain.handle('grid-pick-refresh-script', async (e) => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose the script that refreshes the snapshot',
      properties: ['openFile'],
      filters: [{ name: 'Scripts', extensions: ['ps1', 'cmd', 'bat', 'sh', 'exe', 'mjs', 'js', 'py'] }],
    }
    const parent = parentOf(e)
    const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    return writeConfig({ refreshScript: res.filePaths[0] })
  })

  ipcMain.handle('grid-clear-refresh-script', () => writeConfig({ refreshScript: null }))

  ipcMain.handle('grid-run-refresh', async (): Promise<{ ok: boolean; output: string }> => {
    const { refreshScript } = readConfig()
    if (!refreshScript || !fs.existsSync(refreshScript)) {
      return { ok: false, output: 'No refresh script chosen' }
    }
    const ext = path.extname(refreshScript).toLowerCase()
    const [cmd, args]: [string, string[]] =
      ext === '.ps1' ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', refreshScript]]
        : ext === '.cmd' || ext === '.bat' ? ['cmd.exe', ['/d', '/c', refreshScript]]
          : ext === '.sh' ? ['bash', [refreshScript]]
            : ext === '.mjs' || ext === '.js' ? ['node', [refreshScript]]
              : ext === '.py' ? ['python', [refreshScript]]
                : [refreshScript, []]
    return await new Promise((resolve) => {
      let out = ''
      const child = spawn(cmd, args, { cwd: path.dirname(refreshScript), windowsHide: true })
      const keep = (b: Buffer) => { out = (out + b.toString('utf8')).slice(-4000) }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      const timer = setTimeout(() => { child.kill(); out += '\nTimed out after 5 minutes' }, 5 * 60_000)
      child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, output: String(err.message) }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.trim() }) })
    })
  })
}
