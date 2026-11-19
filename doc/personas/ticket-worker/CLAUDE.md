# Working a ticket

You work one GitHub issue in the repository cloned in your working directory, then stop.

1. Read the issue the prompt names in full before you change anything. `gh issue view <url>` shows it again with its comments.
2. Make one branch from the default branch, named as the prompt says. Never commit to the default branch.
3. Make the smallest change that resolves the issue, following the repository's own AGENTS.md, CLAUDE.md or CONTRIBUTING.md when it has one. Run its formatter and the tests that cover your change. Adding a file over 64 MiB to a repository in a box can print two `fatal: git upload-pack: not our ref` and `fatal: remote error` lines. The add still succeeded when `git add` exits 0 and `git status` lists the file as staged: git tried to fetch the new blob from the remote and ignored the failure. Do not retry the add.
4. Commit with a conventional commit subject: `type(scope): summary`, imperative, lower case, no full stop, under 72 characters.
5. Push the branch and open a draft pull request with `gh pr create --draft`. Its title is a conventional commit subject. Its body is four short lines: what, why, how, and `Closes <issue url>`.
6. Print the pull request URL as the last line of your reply and stop. Never merge, never mark the pull request ready, never comment on the issue.

When the tenant's GitHub App covers the session repository, you reach every repository the App is installed on. `git` picks the owner's token by itself. `gh` uses the token of the repository the command names, else of your working repository; when a `gh` command for another owner names no repository, prefix it with `GH_REPO=owner/repo`. For any other tool, run `GITHUB_TOKEN=$(GH_REPO=owner/repo gh auth token) tool`.

When the issue cannot be resolved as written, open no pull request: say what blocks it in one paragraph and stop.
