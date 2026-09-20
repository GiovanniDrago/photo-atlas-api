# kDrive integration

Photo Atlas talks to the Infomaniak kDrive REST API with a personal API token. The token is stored
encrypted in the database and only used server-side, so the Flutter client never sees it.

## Base folder

Backups live under `KDRIVE_BASE_PATH` (default `Private/Media/PhotoAtlas`): per-folder backups in
`<base>/<folder>`, manual uploads in `<base>/Manual`. kDrive does not allow creating folders at the
drive root (`permission_denied`), so the base must start inside an existing writable space such as
`Private`. The API creates the missing segments on the first upload.

## Getting a token

1. Open <https://manager.infomaniak.com/v3/ng/accounts/token/list>.
2. Create a token with the **drive** scope (this is enough for listing, reading and thumbnails).
3. Copy the numeric drive id from the kDrive web app URL:
   `https://ksuite.infomaniak.com/all/kdrive/app/drive/<DRIVE_ID>`.
4. Verify the pair before connecting:

   ```bash
   bash scripts/kdrive-check.sh <token> <drive_id>
   ```

## Endpoints used

| Purpose | Request |
|---|---|
| Validate token and drive | `GET /2/drive/{drive_id}` |
| Folder/file metadata | `GET /3/drive/{drive_id}/files/{file_id}` (root = `1`) |
| List a folder | `GET /3/drive/{drive_id}/files/{file_id}/files?cursor=&type[]=file\|dir` |
| Search | `GET /3/drive/{drive_id}/files/search?query=&directory_id=&depth=` |
| Download bytes | `GET /2/drive/{drive_id}/files/{file_id}/download` |
| Thumbnail (best effort) | `GET /2/drive/{drive_id}/files/{file_id}/thumbnail?width=256` |

Pagination uses the `cursor` + `has_more` fields returned by the list endpoints.

## Rate limiting

Infomaniak allows 60 requests per minute. The API client enforces a 1100 ms minimum interval between
requests (`KDriveClient.throttle`), so long scans run at a safe pace. A folder with 5 000 images
takes roughly 90 seconds of listing plus one request per folder.

## Scan flow

Scanning is **folder by folder**: the app lets the user browse the drive and add one folder at a
time; each added folder becomes its own `source` with a stored `include_subfolders` choice.

```
POST /api/kdrive/scan { folder_id, include_subfolders, label }
        |
        +--> 202 { scan_run_id, source_id }   (returns immediately)
        |
        +--> background walk from folder_id
                -> directory listing pages (throttled)
                -> map files to media rows
                -> upsert batches of 100
                -> update scan_runs counters every 25 files
```

- `include_subfolders: true` walks the whole subtree below the chosen folder; `false` indexes only
  the files directly inside it. The value is persisted on the source and reused by "scan again",
  until the user toggles it.
- Re-adding the same folder updates its label and flag instead of creating a duplicate source
  (unique on owner + drive + folder).
- Scanning folder `1` (root) indexes the entire drive; the app shows a warning before doing it.
- `metadata_status` is `none` after a scan because the kDrive listing does not include capture date
  or GPS. The client shows this progress through `GET /api/scan-runs/:id`.

Deleting a source from the app removes only the local index (`sources`, its `media_items` and
`scan_runs` rows, via database cascade). **No kDrive file is ever touched**: the integration only
performs GET requests, and the delete handler does not contact kDrive at all.

## Previews

After a scan completes, the API starts a background job that generates and caches a small preview
for every newly indexed item that does not have one yet (`thumb_path`):

- requires **no extra kDrive calls per view**: each preview is fetched once (320 px thumbnail) and
  stored under `MEDIA_CACHE_DIR` (default `~/.cache/photo-atlas/thumbs`)
- runs at the same 60 req/min pace, so it continues for a while after the scan message says
  "complete"
- progress and errors: `GET /api/kdrive/previews`; manual run for everything still missing:
  `POST /api/kdrive/previews`

Views then hit the local cache and are served with long cache headers, so the browser/app keeps
them too.

## Enrichment flow

```
POST /api/kdrive/enrich { limit }
        |
        +--> 202 { queued }               (returns immediately)
        |
        +--> background worker
                -> SELECT kdrive image items WHERE metadata_status <> 'full'
                -> download only the first ~256 KB of each file
                -> parse EXIF/GPS with exifr
                -> update taken_at, lat, lon, width, height, metadata_status
```

Progress and errors are exposed by `GET /api/kdrive/enrich`:

```json
{ "running": true, "processed": 12, "updated": 9, "errors": [], "started_at": "...", "finished_at": null }
```

Videos are indexed from file metadata only (name, size, kDrive timestamps); they are not enriched
because video container metadata is not parsed by this service.

## Security

- The token is encrypted with AES-256-GCM before insert; the key lives in `KDRIVE_ENC_KEY`.
- `GET /api/kdrive/status` never returns the token, only label, drive id and timestamps.
- All kDrive calls happen server-side. Clients use `GET /api/media/:id/thumbnail`, which the server
  fulfils through its own authenticated connection.
- `DELETE /api/kdrive` removes the stored account.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401` on connect | Token lacks the `drive` scope or is expired; regenerate it |
| `403` when scanning | The account cannot read that folder; check sharing in kDrive |
| `409 enrichment_already_running` | Wait for `running: false` then retry |
| Empty folder listing | `parent_id=1` is the root; verify the folder id from the web app |
