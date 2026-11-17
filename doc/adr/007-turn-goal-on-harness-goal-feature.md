# 007. A turn's goal runs on the harness's goal feature

Status: accepted

Turn send takes an optional goal: a condition the harness keeps working toward until it holds. The control plane stores the goal with the turn and returns it on every turn read. For Claude Code, the control plane folds the prompt and the goal into the turn's single prompt as a `/goal` message and always adds a turn cap, such as "or stop after 20 turns". The harness runs the goal loop from there. A send that names a goal for a harness without goal support is refused with an error that names the cause.

This follows tenets 1 and 2. The supervisor, the guest and the channel protocol version stay as they are. Tumpel keeps no goal-clearing logic, handles no leftover goal and never reads the transcript to judge whether the goal was met. A loop in the supervisor and a transcript check in the control plane are both rejected. The cost is that a goal works only on a harness with its own goal feature. The gain is that goals ship without a supervisor release.
