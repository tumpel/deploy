# EDD-004: Snapshots and transcripts

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

A snapshot is the files in a box's overlay upper directory that changed since the session's last stored snapshot. The host uploads it to object storage on a presigned URL, so the host holds no storage key. A fresh box rebuilds the session from the chain of snapshots. Transcript lines carry a number per session that never restarts, and the control plane stores them in chunks in object storage.

## Taking a snapshot

A completed turn starts the session's snapshot timer, 30 s by default, and a new turn resets it. When it fires, the control plane sends a SnapshotRequest. The request carries the snapshot's number in the chain, a storage key under the tenant and session, and an upload URL that expires at the snapshot deadline. The supervisor reads the paused box's drive, builds the delta as a tar archive and uploads it with a PUT. No memory file leaves the host.

The delta carries a deleted file as an overlay whiteout, a character device 0/0. It marks an opaque directory with a PAX header for `trusted.overlay.opaque`, which the supervisor reads from the drive's inodes after it replays the ext4 journal. The guest's init extracts these attributes, so a restored box keeps a deletion and a replaced directory. A damaged attribute block, a truncated attribute entry or a reference to inode 0 fails the snapshot `UpperDirectoryUnreadable`, naming the inode and the block. The supervisor answers SnapshotDone, or SnapshotFailed with one of these reasons:

- BoxNotFound
- UpperDirectoryUnreadable
- UploadExpired
- UploadRejected
- SnapshotTimedOut

Past the deadline the snapshot fails NotAnswered. Each outcome sits on its snapshot record. Only the Worker holds a key that signs storage URLs.

## Restoring a session

Every turn offer lists the session's stored snapshots in order, each with a download URL that expires when the claim budget ends. With no warm box for the session, the supervisor downloads the chain in `snapshotSeq` order and merges it into one archive. It boots a fresh box from the image with an empty overlay drive and the archive on a third, read-only drive. The guest's init unpacks the archive onto the overlay drive, then the turn goes to the harness. Because the harness keeps its own state under its home directory in the overlay, it resumes the conversation. An unreadable snapshot fails the turn `SnapshotUnreadable`, naming the session and the snapshot. A session that moves to another host restores the same way.

## Known limits

Change detection compares modification times to the nanosecond.

## Transcripts

Line numbers start at 1 for each session and never restart. Each turn offer carries the session's last line number, and the guest keeps its counter in the overlay, so a fresh box keeps counting. Lines travel from the host in order. In object storage, the control plane writes them in chunks of 64 lines, a setting, under the tenant, session and turn. Only the cursor index sits in the tenant's database. A skipped number fails the turn `TranscriptGap`. TurnComplete names the turn's last line, and the turn reads Completed once the control plane holds every line up to it.

The read operation returns the lines after the cursor `after`, for the session or for one turn. `limit` caps the lines, one chunk when left out. `maxBytes` caps the bytes, 32,768 when left out, and cuts on a line boundary. A line longer than `maxBytes` comes back alone. A raw page counts the stored JSONL bytes, and a compact page counts the text it returns. `compact` takes Claude Code only. The assistant's text stays, and a tool call becomes one line, `[Tool] first-argument`. Tool results, system lines and result lines drop out. Any other harness gets 422 `InvalidRequest`, which names the harness.

A page holds `sessionState`, `lines`, `cursor` and `finished`. `cursor` is the line number the page read up to, dropped lines included, and the next read passes it as `after`. A compact page can be empty while its cursor moves forward. `finished` is true when no turn that matches the filter is in flight and no line follows the cursor. The control plane reads it in the same Durable Object call as the page. The MCP tool `tumpel_transcript_read` takes the same parameters. `tumpel transcript read <turnId>` takes `--after`, `--limit`, `--max-bytes` and `--compact`. With `--follow` it reads until the page reads `finished`, and it exits with an error when the turn failed.

## Stop and archive

The control plane refuses `tumpel session stop` while a turn runs or while the session's host is offline. It sets the session Stopping and sends a SnapshotRequest at once when a completed turn is not in a snapshot yet. Once it holds the snapshot, the control plane sends BoxTeardown. The supervisor tears the box down only when a snapshot holds its last completed turn, returns its TAP device and answers BoxGone; a box with an unsnapshotted turn stays and the answer is BoxTeardownFailed with `BoxDirty`. BoxGone sets the session Stopped, and its next send restores it on a fresh box. A send to a Stopping session gets `SessionStopping`. A snapshot that fails BoxNotFound goes on to BoxTeardown, since the box is gone. Any other failed snapshot, or no snapshot answer within `snapshotDeadlineSeconds`, sets it back to Idle. A BoxTeardownFailed, or no teardown answer within `snapshotDeadlineSeconds`, returns it to Idle too and records a stop failure with the reason `BoxDirty` or `NotAnswered`. `tumpel session stop-failures <sessionId>` lists them. After `BoxDirty` the control plane arms the snapshot timer again, so the box gets its snapshot and can then be evicted.

An archive takes a Stopped session only, and any other gets `SessionNotStopped`. It deletes the session's snapshot objects and records, keeps its transcript chunks readable and sets the session Archived. Every later send and stop gets `SessionArchived`.

## FAQ

**Does a snapshot hold memory?** No. It holds files. Memory state stays on the host.

**Does a read cursor survive a restore?** Yes. Line numbers never change.
