---
title: Releasing
nav_order: 13
---

# Releasing

This page is for maintainers of cagr itself.

## What happens on its own

- **Docs**: GitHub Pages builds this `docs/` folder from `main`. Merge a change to a page and the site updates a minute or two later.
- **Tests**: `.github/workflows/test.yml` runs `bun run verify`, a host build and `bun run e2e` on every pull request and every push to `main`.
- **Release pull request**: on every push to `main`, `.github/workflows/release.yml` reads the commit subjects since the last release and opens or updates one pull request, `chore(release): vX.Y.Z`. It bumps the version in `package.json` and `src/version.ts` and lists the changes. `bun scripts/next-version.ts` prints the same plan locally.
- **Releases**: merging that pull request releases it. The same workflow sees a version in `src/version.ts` with no tag yet, runs `bun run verify`, builds every platform, and then:
  1. tags the merge commit and creates the GitHub release with the binaries, `SHA256SUMS` and `install.sh`, so the install script picks up the new version (on a rerun it uploads the assets again);
  2. when the repo variable `NPM_PUBLISH` is `true`, publishes the 7 `cagr-<os>-<arch>` packages, then `@krtinshet/cagr`, to npm. A version that is already on npm is skipped, so a failed run can be run again.

## How the version is chosen

Commit subjects follow conventional commits (cagr's commit-message guard keeps them that way), and a squash merge keeps the pull request's title as the subject. Since the last release:

| Commits                                                             | Next version                                     |
| ------------------------------------------------------------------- | ------------------------------------------------ |
| Only `docs`, `ci`, `chore`, `test`, `refactor` and the like         | No release, and no release pull request.         |
| A `fix` or `perf`                                                   | The last number: 0.2.0 to 0.2.1.                 |
| A `feat`                                                            | The middle number: 0.2.1 to 0.3.0.               |
| A `!` after the type, or a `BREAKING CHANGE:` footer                 | The first number, or the middle one while it is 0. |

The largest bump wins. Only plain `vX.Y.Z` versions are released; prerelease tags like `v0.2.0-rc.1` do nothing.

## Cut a release

1. Merge the open `chore(release): vX.Y.Z` pull request. Its tests run like any other pull request's.
2. Watch the `release` workflow in the Actions tab. When it is green, the install script gets the new version (and `bun add -d @krtinshet/cagr@X.Y.Z`, once npm is on).

To skip a release for now, leave the pull request open: it keeps collecting changes. To release by hand instead, set the version in `package.json` and `src/version.ts` in a pull request, merge it, and the same workflow releases it. Pushing a `vX.Y.Z` tag on `main` that matches `src/version.ts` also still works.

The workflow needs **Allow GitHub Actions to create and approve pull requests** on, under Settings, Actions, General.

## One-time setup: npm trusted publishing

The release workflow publishes without an npm token. npm trusts this repo's workflow instead, so no secret can leak. Each package needs this once, and a package must exist on npm before it can be set up.

So the first version of a new package name is published by hand, from a machine logged in to npm (`npm login`) as `krtinshet`:

```sh
bun run build && bun run package
cd dist/npm/cagr && bun publish --access public
```

Run `bun publish --access public` in the matching `dist/npm/cagr-*` folder for a new platform package. Then set up trusted publishing on it:

1. On npmjs.com, open the package, then **Settings**, then **Trusted publishing**.
2. Choose **GitHub Actions** and enter: owner `krtinshet`, repository `cagr`, workflow file `release.yml`. Leave the environment empty.
3. Save. Do this for `@krtinshet/cagr` and for each of the 7 `cagr-*` packages.

Once all 8 are set up, also choose **Require two-factor authentication and disallow tokens** under Publishing access, so only the workflow can publish. Then turn npm publishing on in the workflow: `gh variable set NPM_PUBLISH --body true`.
