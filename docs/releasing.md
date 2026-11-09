---
title: Releasing
nav_order: 11
---

# Releasing

This page is for maintainers of cagr itself.

## What happens on its own

- **Docs**: GitHub Pages builds this `docs/` folder from `main`. Merge a change to a page and the site updates a minute or two later.
- **Tests**: `.github/workflows/test.yml` runs `bun run verify`, a host build and `bun run e2e` on every pull request and every push to `main`.
- **Releases**: `.github/workflows/release.yml` runs when a tag like `v0.2.0` is pushed. It checks that the tag matches `src/version.ts`, runs `bun run verify`, builds every platform, and then:
  1. creates the GitHub release with the binaries, `SHA256SUMS` and `install.sh`, so the install script picks up the new version;
  2. publishes the 7 `cagr-<os>-<arch>` packages, then `@kslabs/cagr`, to npm. A version that is already on npm is skipped, so a failed run can be run again.

## Cut a release

1. On a branch, set the new version in both `package.json` and `src/version.ts`, and open a pull request.
2. Merge it.
3. Tag the merge commit and push the tag:

   ```sh
   git checkout main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. Watch the `release` workflow in the Actions tab. When it is green, `bun add -d @kslabs/cagr@0.2.0` and the install script both get the new version.

Versions follow semver: a fix bumps the last number, a new feature the middle one, and a change that breaks a config or a command the first one (while the first number is 0, the middle one).

## One-time setup: npm trusted publishing

The release workflow publishes without an npm token. npm trusts this repo's workflow instead, so no secret can leak. Each package needs this once, and a package must exist on npm before it can be set up:

1. On npmjs.com, open the package, then **Settings**, then **Trusted publishing**.
2. Choose **GitHub Actions** and enter: owner `krtinshet`, repository `cagr`, workflow file `release.yml`. Leave the environment empty.
3. Save. Do this for `@kslabs/cagr` and for each of the 7 `cagr-*` packages.

Once all 8 are set up, also choose **Require two-factor authentication and disallow tokens** under Publishing access, so only the workflow can publish.
