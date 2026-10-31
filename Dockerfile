# DO NOT BUILD FROM THIS FILE — the PHP stages it used to contain
# were deleted with fork src/ in R6c (see docs/nextjs-strangler/phase5/
# findings-r6c.md §4 and §6). This file is kept as a pointer so the
# deletion is discoverable.
#
# Next.js deployment: apps/nextjs/Dockerfile
#   docker build -t fossbilling-next apps/nextjs
#
# PHP rollback artifact (R6d): build the `release-artifact` stage from
# the PARENT commit (the commit before the R6c deletion), where the
# PHP stages still exist:
#   git worktree add /tmp/r6d-rollback <parent-of-R6c>
#   cd /tmp/r6d-rollback
#   docker build --target release-artifact \
#     -t <registry>/fossbilling-php-rollback:<tag> .
# Retain the tag one full billing cycle (D5-6).
