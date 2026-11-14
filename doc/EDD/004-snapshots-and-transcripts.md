# EDD-004: Snapshots and transcripts

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

A snapshot is the files in a box's overlay upper directory that changed since the session's last stored snapshot. The host uploads it to object storage on a presigned URL, so the host holds no storage key. A fresh box rebuilds the session from the chain of snapshots. Transcript lines carry a number per session that never restarts, and the control plane stores them in chunks in object storage.

## Taking a snapshot

A completed turn starts the session's snapshot timer, 30 s by default, and a new turn resets it. When it fires, the control plane sends a SnapshotRequest. The request carries the snapshot's number in the chain, a storage key under the tenant and session, and an upload URL that expires at the snapshot deadline. The supervisor reads the paused box's drive, builds the delta and uploads it. It answers SnapshotDone, or SnapshotFailed with one of these reasons:

- BoxNotFound
- UpperDirectoryUnreadable
- UploadExpired
- UploadRejected
- SnapshotTimedOut
- BoxSnapshotFailed

Past the deadline the snapshot fails NotAnswered. Each outcome sits on its snapshot record. Only the Worker holds a key that signs storage URLs.

## Restoring a session

Every turn offer lists the session's stored snapshots in order, each with a download URL that expires when the claim budget ends. With no warm box for the session, the supervisor boots a fresh box from the image. It applies the chain in order onto an empty drive, then hands the turn to the harness. Because the harness keeps its own state under its home directory in the overlay, it resumes the conversation. An unreadable snapshot fails the turn `SnapshotUnreadable`, naming the session and the snapshot. A session that moves to another host restores the same way.

## Transcripts

Line numbers start at 1 for each session and never restart. Each turn offer carries the session's last line number, and the guest keeps its counter in the overlay, so a fresh box keeps counting. Lines travel from the host in order. In object storage, the control plane writes them in chunks of 64 lines, a setting, under the tenant, session and turn. Only the cursor index sits in the tenant's database. A skipped number fails the turn `TranscriptGap`. TurnComplete names the turn's last line, and the turn reads Completed once the control plane holds every line up to it.

A read returns lines after a cursor and a new cursor naming the last line returned. An empty page means nothing new.

## Archive

Archiving a session deletes its snapshot objects and keeps its transcript chunks.

## FAQ

**Does a snapshot hold memory?** No. It holds files. Memory state stays on the host.

**Does a read cursor survive a restore?** Yes. Line numbers never change.
