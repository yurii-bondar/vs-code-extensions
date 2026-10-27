// Shared semantic-release config for every extension in this repo.
// Each extension folder has a release.config.cjs that re-exports this file,
// and semantic-release runs from inside that folder (see .github/workflows/release.yml).
//
// semantic-release-monorepo keeps only the commits that touch the current folder
// and tags releases as `<package name>-v<version>`, e.g. `personify-v1.2.0`.
module.exports = {
  extends: 'semantic-release-monorepo',
  branches: ['main'],
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    // Sets the new version in package.json, builds the .vsix and publishes it
    // to the VS Code Marketplace (VSCE_PAT) and/or Open VSX (OVSX_PAT).
    ['semantic-release-vsce', { packageVsix: true }],
    [
      '@semantic-release/git',
      {
        assets: ['package.json', 'package-lock.json', 'CHANGELOG.md'],
        message: 'chore(release): ${nextRelease.gitTag} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    ['@semantic-release/github', { assets: [{ path: '*.vsix' }] }],
  ],
};
