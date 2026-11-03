# Maintainer notes

Maintainer notes, moved out of the README. User documentation is in the wiki.

## Releases

Actions → **Release** → *Run workflow* → the version (e.g. `1.2.3`; `1.2.3-rc.1` makes a pre-release). The workflow
runs the whole CI (tests, shellcheck, PSScriptAnalyzer, a real Linux and a real Windows install), builds
`foundry-world-backup-<version>-linux.tar.gz`, `-windows.zip` and `-setup.exe`, the fixed-name copies
(`foundry-world-backup-linux.tar.gz` etc., so `.../releases/latest/download/<name>` always points at the newest
release) and `SHA256SUMS.txt`, and publishes the release with a download table in front of the generated notes.
Fallback: publish a release with a tag `vX.Y.Z` by hand; the files are attached afterwards. The version comes from
the tag; nobody bumps `package.json` (the build stamps it into the archives).

After publishing, the workflow asks the [Workshop site](https://github.com/dxcufgb/FVTT-dev-showcase) to rebuild (a
`module-released` repository dispatch) when the repository secret `SITE_DISPATCH_TOKEN` is set: a fine-grained token
with access to only `dxcufgb/FVTT-dev-showcase` and **Contents: Read and write**. Without it the site picks the
release up at its next 6-hourly build; a refused ping is only a warning.

## Development

- `npm test`: `node --test` over `test/*.test.js`. The backup tests run the real `git` command (git ≥ 2.31) and push
  into a local bare repository; GitHub, Foundry and SMTP are faked.
- `shellcheck install.sh scripts/*.sh`; PSScriptAnalyzer (`Invoke-ScriptAnalyzer -Path scripts, packaging -Recurse`)
  for the PowerShell scripts, which target Windows PowerShell 5.1.
- Security scans as in CI: `gitleaks git --redact --log-opts="--full-history --diff-filter=tuxdb --diff-merges=first-parent HEAD" .`
  and `semgrep scan --metrics=off --error --severity WARNING --severity ERROR --config p/python --config p/javascript
  --config p/security-audit --config p/secrets --config p/github-actions --config r/bash`.
- Conventions: CommonJS, `'use strict'`, no npm dependencies, 2-space indent, single quotes, semicolons; behaviour
  changes need a test and a README edit. See `CLAUDE.md` for the review focus.

## Branch protection

`main` is protected by the **Protect main** ruleset (`.github/ruleset-protect-main.json`, applied through the
GitHub API/UI): no deletion or force push, changes through pull requests merged with squash, one approval, and the
CI and security jobs as required status checks. Release tags `v*` are protected by **Protect release tags**
(`.github/ruleset-protect-release-tags.json`): no deletion, update or force push. Keep the check names in the ruleset
in step with the job names in `ci.yml` and `security.yml`.
