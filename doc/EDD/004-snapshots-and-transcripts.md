# EDD-004: Snapshots and transcripts

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

A snapshot is every file in a box's overlay upper directory, stored as a manifest plus chunks. The host cuts each changed file into chunks and uploads only the chunks the tenant lacks, packed together, on presigned URLs, so the host holds no storage key. A fresh box rebuilds the session from the latest snapshot alone. Transcript lines carry a number per session that never restarts, and the control plane stores them in chunks in object storage.

## Taking a snapshot

Every turn end starts the session's snapshot timer, 30 s by default, whether the turn completed or failed, and a new turn resets it. When it fires, the control plane sends a SnapshotRequest. The request carries the snapshot's number, a storage key under the tenant and session, and an upload URL for that key that expires at the snapshot deadline. The supervisor reads the overlay upper directory from the paused box's drive. The harness layer and the guest drive mount outside the overlay, so no snapshot holds their files (EDD-007). No memory file leaves the host.

The manifest records a deleted file as an overlay whiteout, a character device 0/0. It marks an opaque directory with `trusted.overlay.opaque`, which the supervisor reads from the drive's inodes after it replays the ext4 journal. The guest's init restores these attributes, so a restored box keeps a deletion and a replaced directory. A damaged attribute block, a truncated attribute entry or a reference to inode 0 fails the snapshot `UpperDirectoryUnreadable`, naming the inode and the block. The supervisor answers SnapshotDone, or SnapshotFailed with one of these reasons:

- BoxNotFound
- UpperDirectoryUnreadable
- UploadExpired
- UploadRejected
- SnapshotTimedOut

The host runtime config's `snapshotSeconds` covers reading the drive and cutting the files, and ends in SnapshotTimedOut. The exchange, the packing and the uploads run until the request's `uploadExpiresAt`, and end in UploadExpired. Past the deadline the snapshot fails NotAnswered. Each outcome sits on its snapshot record.

## Chunks and packs

The supervisor cuts each changed regular file with content-defined chunking. Chunks run from 16 KiB to 256 KiB, 64 KiB on average, so most source files are one chunk. A file keeps its chunks from the box's last snapshot without being read when its size, mode, owner, mtime to the nanosecond and inode birth time all match. The supervisor always reads a file without a birth time.

The manifest lists every entry of the upper directory. A file's entry lists its chunks, each as digest, pack, offset and length. The supervisor encodes the manifest and cuts it with the same chunker, and its chunks travel like file chunks. Under the snapshot's storage key sits a small SnapshotRoot that names the manifest's chunks.

The supervisor concatenates new chunks into packs of about 8 MiB, with no header. Each pack is stored under `<tenantId>/packs/<sha256 of the pack>`. The tenant's `chunks` table holds each placement, keyed by digest and pack, and its `packs` table holds each pack's size.

## Uploading a snapshot

The exchange runs in lockstep parts of up to 500 chunks. The host sends a part only after the answer to the one before has arrived.

1. SnapshotChunks names the digests that the box's last snapshot lacked. SnapshotChunksHeld answers with the placement of each digest the tenant already holds.
2. The host packs the rest. SnapshotPacks names the new packs and placements. SnapshotPackUploads answers with a presigned PUT for each pack the tenant lacks. Each URL signs `x-amz-checksum-sha256`, so object storage refuses bytes that do not match the pack's digest.
3. The host uploads the packs, then the root, then sends SnapshotDone. Its `uploadedBytes` counts the packs plus the root.

Once the root exists, the control plane records the snapshot and its placements. A SnapshotDone that arrives after NotAnswered still records them, because the host builds its next snapshot on this one.

## Restoring a session

Each turn offer names the latest stored snapshot, with a download URL for its root. With no warm box for the session, the supervisor fetches the root. It asks for the chunks it lacks in RestoreChunks parts grouped by pack, first the manifest's chunks and then the files' chunks. RestoreDownloads answers each part with a presigned GET per pack. The control plane answers a pack only when every chunk asked in it belongs to the session at that placement. Restore URLs expire at the offer time plus `turnOfferTtlSeconds`.

The supervisor starts each part's downloads as its answer arrives. It downloads a whole pack when the host chunk cache (EDD-001) lacks half or more of it, and fetches ranges otherwise. The supervisor checks each chunk against its digest and reassembles the files into a tar archive. The archive carries nanosecond mtimes as PAX records, so the restored entries match the manifest. Birth times are new after a restore, so the next snapshot reads every file again.

The supervisor boots a fresh box from the image with an empty overlay drive and the archive on a third, read-only drive. The guest's init unpacks the archive onto the overlay drive, then the turn goes to the harness. Since the harness keeps its state in the overlay, it resumes the conversation. A root, pack or chunk that cannot be downloaded or read fails the turn `SnapshotUnreadable`, naming the session and the snapshot. On another host, a session restores the same way.

## Known limits

- Packs of a snapshot that fails after its upload stay in object storage.
- The host chunk cache grows without eviction.
- A manifest of 100,000 files encodes to about 40 MB. A snapshot ships only its changed chunks.
- Restoring such a tree cold takes about 210 lockstep round trips.
- Paths that are not UTF-8 fail the snapshot `UpperDirectoryUnreadable`.

## Transcripts

Line numbers start at 1 for each session and never restart. Each turn offer carries the session's last line number, and the guest keeps its counter in the overlay, so a fresh box keeps counting. In object storage, the control plane writes the lines in chunks of 64 lines, a setting, under the tenant, session and turn. A skipped number fails the turn `TranscriptGap`. TurnComplete names the turn's last line, and the turn reads Completed once the control plane holds every line up to it. A turn whose lines hold no successful result of its harness fails `HarnessExitedWithoutResult` instead: a Claude Code `result` with subtype `success`, a Codex `turn.completed`, an OpenCode `step_finish` with reason `stop`, or a Pi `agent_end` whose last message stopped with `stop`. A read returns the lines after a cursor (appendix).

## Stop

The control plane refuses `tumpel session stop` while a turn runs or while the session's host is offline. It sets the session Stopping and sends a SnapshotRequest at once when the last turn is not in a snapshot yet. Once it holds the snapshot, the control plane sends BoxTeardown. The supervisor tears the box down only when a snapshot holds its last turn, returns its TAP device and answers BoxGone; a box with an unsnapshotted turn stays and the answer is BoxTeardownFailed with `BoxDirty`. BoxGone sets the session Stopped, and its next send restores it on a fresh box. A send to a Stopping session gets `SessionStopping`. A snapshot that fails BoxNotFound goes on to BoxTeardown. Any other failed snapshot, or no snapshot answer within `snapshotDeadlineSeconds`, sets it back to Idle. A BoxTeardownFailed, or no teardown answer within `snapshotDeadlineSeconds`, returns it to Idle too and records a stop failure with the reason `BoxDirty` or `NotAnswered`. `tumpel session stop-failures <sessionId>` lists them. After `BoxDirty` the control plane arms the snapshot timer again, so the box gets its snapshot and can then be evicted.

## Archive

An archive takes a Stopped session only, and any other gets `SessionNotStopped`. It deletes the session's snapshot roots and records. In one transaction it then deletes the chunk rows that no other session holds, the session's `session_chunks` rows and the pack rows that no chunk row points at. It then deletes those pack objects, so a failed delete leaves objects in storage and never a row for a deleted object. The control plane never repacks, so a pack with one live chunk stays whole. The archive keeps the transcript chunks readable and sets the session Archived. Every later send and stop gets `SessionArchived`.

## FAQ

**Does a snapshot hold memory?** No. It holds files. Memory state stays on the host.

**Does a read cursor survive a restore?** Yes. Line numbers never change.

## Appendix: reading a transcript

The read operation returns the lines after the cursor `after`, for the session or for one turn. `limit` caps the lines, one chunk when left out. `maxBytes` caps the bytes, 32,768 when left out, and cuts on a line boundary. A line longer than `maxBytes` comes back alone. `compact` takes Claude Code only. The assistant's text stays, and a tool call becomes one line, `[Tool] first-argument`. Tool results, system lines and result lines drop out. Any other harness gets 422 `InvalidRequest`.

A page's `cursor` is the line number the page read up to, dropped lines included, and the next read passes it as `after`. A compact page can be empty while its cursor moves forward. `finished` is true when no turn that matches the filter is in flight and no line follows the cursor. The MCP tool `tumpel_transcript_read` and `tumpel transcript read <turnId>` take the same parameters. The CLI's `--follow` reads until a page reads `finished`, and exits with an error when the turn failed.
