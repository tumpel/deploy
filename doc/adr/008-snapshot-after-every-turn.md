# 008. A snapshot follows every turn

Status: accepted

The control plane snapshots a session after every turn, whatever the outcome: completed, failed, out of memory, timed out, or a harness that exited without a result. A follow-up turn on the same session always resumes where the last turn stopped. The snapshot is the only copy of unfinished work.

This follows tenet 2: Tumpel never judges a turn's work, so every outcome gets the same snapshot. A snapshot only after a completed turn, a revert to the last good snapshot and a push of unfinished work to `tumpel/wip/*` branches are all rejected. The cost is that a follow-up turn can start from a half-done working tree. The gain is that a failed turn, such as the one in #169 that ran out of memory mid-work, keeps what it did.
