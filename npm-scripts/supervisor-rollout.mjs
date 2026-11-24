export const requireSupervisorRolloutApproval = (current, proposed, approved) => {
  if (approved === true) return;
  const live = current?.supervisors;
  const pinned = proposed.supervisors[0]?.supervisorVersion;
  if (pinned && Array.isArray(live) && live.length > 0 && live.every((entry) => entry?.supervisorVersion === pinned))
    return;
  throw new Error(
    "supervisor rollouts are on hold until the bootstrap release; set supervisor_rollout_approved to true after the owner approves",
  );
};
