# DO NOT BUILD FROM THIS FILE — the PHP stages it used to contain
# were deleted with fork src/ in R6c (see docs/nextjs-strangler/phase5/
# findings-r6c.md §4 and §6). This file is kept as a pointer so the
# deletion is discoverable.
#
# Next.js deployment: apps/nextjs/Dockerfile
#   docker build -t fossbilling-next apps/nextjs
#
# PHP rollback artifact (R6d): build the `release-artifact` stage from
# the PARENT commit (the commit before the R6c deletion, 51abaf1),
# where the PHP stages still exist. Full procedure, gates, and
# retention rule: docs/nextjs-strangler/phase5/cutover-checklist.md
# (G4). The worktree path below is durable (~/scratch survives
# restarts; /tmp does not) so a failed build can be inspected:
#   git worktree add ~/scratch/fossbilling/r6d-rollback-worktree 51abaf1
#   cd ~/scratch/fossbilling/r6d-rollback-worktree
#   docker build --target release-artifact \
#     -t <registry>/fossbilling-php-rollback:51abaf1 .
#   docker push <registry>/fossbilling-php-rollback:51abaf1
# Retain the tag one full billing cycle FROM THE CUTOVER DATE (D5-6).
# NOTE: the image has NOT been built in the sandbox (no docker binary
# there) — the commands above run on a docker host.
