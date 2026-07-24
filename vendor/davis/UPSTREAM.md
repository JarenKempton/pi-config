# Davis my-pi-setup upstream

Vendored from <https://github.com/davis7dotsh/my-pi-setup>.

Pinned commit: `21f40f41fb98e088281a6fcd512388d82bddf911`.

The user reported public reuse permission despite the upstream repository not containing a formal license at this pin. Keep this attribution with all vendored source.

## Vendored paths

- `extensions/shared/`
- `extensions/subagents/`
- `extensions/workflows/`
- `extensions/model-info/`
- `extensions/git-info/`
- `extensions/ui-customization/`
- `skills/subagents/`

## Sync process

1. Review upstream changes and permission/license status.
2. Download the pinned archive into a temporary repo-local file only.
3. Replace only the selected paths above under `vendor/davis/`, preserving upstream paths.
4. Re-apply local patches listed in `PATCHES.md`.
5. Run `npm install` if dependencies changed, then run typecheck/tests as feasible.
6. Do not touch user-local standalone extensions or protected files while syncing.
