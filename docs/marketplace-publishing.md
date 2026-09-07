# Automatically publish GitHub Releases to VS Code Marketplace

The `Sync VS Code Marketplace` workflow downloads all eight VSIX packages from an existing stable GitHub Release, verifies SHA-256 checksums and package identities, then publishes the same files. It does not rebuild packages. Marketplace validation can continue after the upload completes.

## Configure the publishing identity once

Use a Microsoft Entra application with a federated credential:

- Issuer: `https://token.actions.githubusercontent.com`
- Subject: `repo:AreChen@20765464/rust-analyzer-lingo@1327756196:environment:marketplace`
- Audience: `api://AzureADTokenExchange`

This repository uses GitHub's immutable-ID subject format. When configuring another repository, use the actual subject shown by the Azure login step; do not omit the account/repository IDs when that format is enabled.

Configure GitHub environment `marketplace` with the non-secret variables `MARKETPLACE_AZURE_CLIENT_ID` and `MARKETPLACE_AZURE_TENANT_ID`. Restrict environment deployment branches to `main` and the `v*` release tags. Run the workflow once and copy the profile ID printed by **Identify Marketplace publishing principal**. Add that ID as a Contributor on the `rust-analyzer-lingo` Marketplace publisher, then retry the workflow. The first upload is expected to fail until this membership exists. The profile ID is not the application's client ID or Entra object ID. This does not require an Azure subscription role. No client secret or PAT is required. See Microsoft's [automated publishing documentation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace).

The workflow uses the released `vsce --azure-credential` support through `azure/login`. It does not depend on the unreleased direct `vsce --oidc` option.

## Release a new version

Update version fields and release notes, commit and push, then push the matching `vMAJOR.MINOR.PATCH` tag. The existing build workflow publishes all platform packages and `SHA256SUMS` to GitHub, then explicitly dispatches Marketplace synchronization on `main`. This explicit dispatch is necessary because a release created with `GITHUB_TOKEN` does not trigger another release-event workflow.

Manually published GitHub Releases also trigger synchronization. Drafts, prereleases, incomplete sets, mismatched hashes, and unexpected extension identities are rejected before authentication or upload.

## Validate or retry an existing release

In GitHub Actions, select **Sync VS Code Marketplace → Run workflow**, choose `main`, and enter the existing tag. Enable `dry_run` to download and validate without signing in or uploading.

For a real retry, leave `dry_run` disabled. Each package gets up to three attempts. `--skip-duplicate` skips platform versions already present, so partial failures can be resumed without increasing the version. Runs for the same tag are serialized. Check this workflow separately from **Build and Release**: the latter reports successful dispatch, not successful Marketplace upload.

The maintained branch supplies the publishing scripts; release files are treated as data. Checksums detect missing or altered downloads, but are not an independent signature of the release producer. GitHub branch/environment access controls remain part of the publishing trust boundary.
