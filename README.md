# burning branches

Grow a forest out of a repository's commit history.

Every file becomes a plot of land on a one square kilometre map. Code nobody has touched in
years grows into old growth. Code rewritten last week is still burning. Code that churns in
every release never gets past bare earth.

Live at [burningbranches.dev](https://burningbranches.dev). Enter any public GitHub
repository as `owner/name`.

## How the biome is decided

Tree height follows a Chapman-Richards growth curve fitted to real closed-canopy stands, run
forward from the moment a file was last disturbed and capped by the project's own age. A one
year old project shows knee-high saplings no matter how stable it is; a fifteen year old
module nobody has opened shows a twenty five metre canopy. Growth is measured against wall
clock rather than the last commit, so an abandoned repository keeps maturing.

| Ground | Meaning |
| --- | --- |
| Old growth | Original code, never disturbed |
| Mature forest | Untouched for most of the project's life |
| Young forest | Untouched for a few years |
| Saplings, scrub | Quiet for a year or two |
| Grassland | Young or lightly worked |
| Bare earth | Churns in almost every window |
| Ash and char | Recently stripped out and replaced |
| Burning | Being torn out or rewritten right now |

Files deleted inside the recent window stay on the map as burnt scars rather than silently
vanishing. Repeated disturbance degrades the site, so a hot spot stays bare even during a
quiet spell. Lockfiles and build output are excluded; data files are not, because for plenty
of repositories the data genuinely is the project.

The x-y plane is a squarified treemap of the directory tree, so a directory's territory is
contiguous and its area tracks its weight. Boundaries are domain-warped when the map is
rasterised, which is why stands interlock instead of meeting at straight lines. Nesting depth
becomes elevation, so deeply nested code sits uphill.

## Reading a whole history cheaply

Asking GitHub for every commit's file list costs one request per commit, which is hopeless
for anything large. Instead history is sampled into eras on a geometric schedule, each era
boundary is resolved to a commit, and consecutive boundaries are diffed with the compare API.
Recent months get narrow eras so a rewrite last week reads as an active fire; the deep past
gets wide eras because all that is needed from it is "nothing has happened here in years".

An era that returns a truncated file list is split and re-read. Quiet stretches resolve to the
same commit on both sides and cost nothing. A repository of any size lands in roughly two
hundred and fifty requests, and the result is cached by commit forever.

## Cards for your README

Every surveyed repository gets a PNG rendered on demand:

```markdown
[![burning branches](https://api.burningbranches.dev/v1/card/OWNER/REPO.png)](https://burningbranches.dev/OWNER/REPO)
```

The image follows the repository and regrows as new commits land. It is rasterised in the
Worker with no image dependencies at all.

## Layout

```
apps/web        Vite, React for the interface, hand-written three.js for the scene
apps/api        Cloudflare Worker: scanner, Durable Objects, card renderer
packages/schema Shared types plus the growth, classification and treemap rules
```

The biome rules live in `packages/schema` so the scanner and the browser cannot disagree
about what a forest means.

## Running it

```sh
pnpm install
echo 'GITHUB_TOKEN = "ghp_your_token"' > apps/api/.dev.vars
pnpm --filter @burningbranches/api db:init:local
pnpm dev
```

The web app proxies `/v1` to the Worker on port 8787.

## Limits

A repository is re-read from GitHub at most once a day; requests in between replay the cached
survey. Surveys are metered per address, but only when they will actually reach GitHub, so
viewing an already-grown forest is never throttled.
