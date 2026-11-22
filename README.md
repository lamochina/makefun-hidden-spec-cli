# makefun-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lamochina/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lamochina/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. mend reads a patch in one of four formats (a unified diff, SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON), applies every edit it names to the tree of text files rooted at the working directory, and writes every change or none. Lines an edit names are found at the first of three matching tiers: exact, trailing-whitespace-insensitive, then indentation-insensitive, with re-indentation of the replacement. It runs on Node 22 with its standard library alone.

## Run it

```sh
node main.ts [options] [PATCH]
```

---

Entered on [make.fun](https://make.fun/?ref=xcyg0czv&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
