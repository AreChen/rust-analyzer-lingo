# Project Agent Guide

## Project Overview

`rust-analyzer-lingo` is a VS Code extension for multilingual Rust diagnostics. The current user-facing locale is Simplified Chinese, while the architecture is designed to add English and other locales later. The project has a TypeScript extension layer and a separate Rust JSON-RPC/LSP proxy for translating native diagnostic Hover content. The packaged native proxy currently targets Windows x64.

## Scope

- This file applies to the whole repository.
- User instructions in the current task take precedence over this guide.
- There are no child `AGENTS.md` files; add one only if a directory develops distinct local commands or safety boundaries.

## Quick Commands

Run these from the repository root:

- Install JavaScript dependencies: `npm install`
- Type-check: `npm run check`
- Compile the extension: `npm run compile`
- Check the Rust proxy: `cargo check --manifest-path proxy/Cargo.toml`
- Build the Windows proxy: `cargo build --release --manifest-path proxy/Cargo.toml`
- Copy the release proxy before packaging: `Copy-Item proxy/target/release/rust-analyzer-lingo-proxy.exe bin/rust-analyzer-lingo-proxy.exe -Force`
- Package the VSIX: `npm run package`
- Publish a release: push a tag matching the package version, for example `git tag v0.1.1` followed by `git push origin v0.1.1`

`npm run package` compiles TypeScript and invokes `vsce package`. In the maintained development environment, external commands are prefixed with `rtk` according to the global agent instructions.

## Key Paths

- `src/extension.ts` - VS Code activation, diagnostics, inline hints, Hover, commands, and settings.
- `src/translation.ts` - Diagnostic-code and message translation rules.
- `src/error-codes.ts` - The Simplified Chinese catalog for all 518 error-code pages in the local stable Rust toolchain.
- `proxy/src/main.rs` - LSP framing, server discovery, and native diagnostic translation.
- `proxy/Cargo.toml` - Rust proxy manifest and `serde_json` dependency.
- `bin/rust-analyzer-lingo-proxy.exe` - Windows x64 binary included in the VSIX.
- `package.json` - Extension manifest, commands, configuration keys, and npm scripts.
- `.github/workflows/release.yml` - Windows x64 CI, VSIX packaging, artifact upload, and tag-based GitHub Release workflow.
- `README.md` - English-only project landing page.
- `docs/README.zh-CN.md` - Simplified Chinese user documentation.

## Architecture Boundaries

- The TypeScript layer may create its own VS Code diagnostics, inlay hints, and Hover content; it must not assume that another extension's diagnostic collection can be mutated.
- The Rust proxy must forward non-diagnostic LSP traffic unchanged and translate only diagnostic notifications/responses and their related messages.
- The proxy loads the packaged catalog from `dist/error-codes.js`; update the TypeScript catalog and rebuild before testing a packaged proxy change.
- The native proxy is currently platform-specific. Do not describe it as cross-platform until binaries and launch behavior exist for the target platform.
- Keep the public identifier, command IDs, configuration keys, proxy executable name, environment variables, and repository URLs aligned with `rust-analyzer-lingo`.

## Error-Code Catalog

- Treat the local stable Rust toolchain's Rust error-code HTML directory as the source of truth for catalog coverage.
- Keep every official `E####` code represented in `src/error-codes.ts`, including retired or compiler-internal entries. Those entries should explain their status rather than silently disappearing.
- Preserve Rust keywords, identifiers, code fragments, ranges, and error codes in translated diagnostics so users can match the message to source code.
- When updating the catalog, compare its keys with the official local HTML pages and report the total, missing keys, duplicate keys, and extra keys.

## Conventions

- Keep user-facing diagnostic explanations concise and beginner-friendly.
- Use Chinese for the current diagnostic catalog; keep technical Rust terms, code, identifiers, and compiler locations intact.
- Keep TypeScript source under `src/` and Rust proxy source under `proxy/src/`.
- Treat `dist/`, `proxy/target/`, `node_modules/`, and `*.vsix` as generated artifacts; do not edit or commit them as source.
- Keep the root README in English and put localized documentation under `docs/`, linked from the root README. Future locales should follow the same locale-specific README convention under `docs/`.

## Definition of Done

- For TypeScript, catalog, or manifest changes, run `npm run check` and `npm run compile`.
- For proxy changes, run `cargo check --manifest-path proxy/Cargo.toml` and rebuild `bin/rust-analyzer-lingo-proxy.exe` before packaging.
- For release/package changes, run `npm run package` and inspect the VSIX file list for the expected `bin/` and `dist/` contents.
- For workflow changes, verify that the tag format and `package.json` version check remain aligned before pushing a release tag.
- For catalog changes, verify the catalog against the local stable Rust error-code HTML directory.
- Report any platform limitation, unavailable test, or unresolved packaging warning instead of hiding it.

## Boundaries

- Always preserve the user's existing rust-analyzer server settings when enabling or restoring the native proxy.
- Always keep secrets, access tokens, local credentials, and machine-specific settings out of the repository.
- Ask first before adding a dependency with a new runtime or licensing requirement, changing the public extension identifier, or modifying a user's global VS Code settings.
- Ask first before force-pushing, deleting a remote repository, or rewriting shared Git history.
- Never commit `node_modules/`, `dist/`, `proxy/target/`, generated VSIX files, or copied external extension files.

## References

- [`README.md`](README.md) - English project overview, installation, configuration, architecture, and roadmap.
- [`docs/README.zh-CN.md`](docs/README.zh-CN.md) - Simplified Chinese guide.
- [`package.json`](package.json) - extension metadata and verified scripts.
- [`proxy/Cargo.toml`](proxy/Cargo.toml) - native proxy build facts.
