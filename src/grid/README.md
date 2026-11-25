# Profile grid planner

Header button **Grid**: try planned posts in the account's profile grid before publishing.

- Planned posts sit above the published ones, numbered in posting order (1 = next).
- Inside its cell a planned post can **fill** the cell (drag to move the crop, scroll or +/− to zoom) or sit **inset** on a white or black matte (drag to place, scroll to size).
- Drag an unselected planned post onto another to reorder. Published posts can be pinned (max 3, Instagram's limit) or hidden for the plan.
- View: 3:4 grid (current Instagram) or 1:1, Instagram light/dark, phone or large width. **Export PNG** renders the planned grid at 1080 px wide.
- The plan (images included) persists in IndexedDB, independent of `.vpost` documents.

## Snapshot folder

Tiovivo never talks to Instagram. Any exporter can write a folder that Tiovivo reads (`electron/grid.ts`):

```
grid.json        { version: 1, fetchedAt, account: { username, name, biography, mediaCount, followers, follows, avatar }, posts: [{ id, permalink, timestamp, mediaType, caption, thumb }] }
avatar.jpg       referenced by account.avatar
thumbs/<id>.jpg  one grid cover per post (video thumbnail, or the first image of a carousel), referenced by posts[].thumb
```

The folder and an optional refresh script are chosen once in the planner and stored in `userData/grid-planner.json`. **Refresh profile** runs that script (`.ps1`, `.cmd`, `.bat`, `.sh`, `.js`/`.mjs`, `.py` or an executable), then reloads the folder. Credentials stay with the exporter.

Not available from the Graph API, so set by hand: pinned posts, custom grid crops chosen in the Instagram app, and posts hidden from the grid.

At Verso the exporter is `integrations/instagram/export-grid.ps1` in the Hermes `verso` profile (read-only Graph API token, DPAPI-encrypted), writing to `00_VERSO/REDES/INSTAGRAM_GRID/`.
