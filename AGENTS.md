# Project Agent Guide

## Project Overview

`rust-analyzer-zh` is a VS Code extension for presenting Rust, `rust-analyzer`, and Clippy diagnostics in Chinese. It has a TypeScript extension layer and a separate Rust JSON-RPC/LSP proxy for native diagnostic Hover translation. The packaged native proxy is currently Windows x64.

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
- Copy the release proxy before packaging: `Copy-Item proxy/target/release/rust-analyzer-zh-proxy.exe bin/rust-analyzer-zh-proxy.exe -Force`
- Package the VSIX: `npm run package`

`npm run package` compiles TypeScript and invokes `vsce package`.

## Key Paths

- `src/extension.ts` - VS Code activation, diagnostics, inline hints, Hover, commands, and settings.
- `src/translation.ts` - Diagnostic-code and message translation rules.
- `src/error-codes.ts` - Rust error-code title catalog.
- `proxy/src/main.rs` - LSP framing, server discovery, and native diagnostic translation.
- `proxy/Cargo.toml` - Rust proxy manifest and `serde_json` dependency.
- `bin/rust-analyzer-zh-proxy.exe` - Windows x64 binary included in the VSIX.
- `package.json` - Extension manifest and verified npm scripts.
- `README.md` - User-facing English-first bilingual documentation.

## Architecture Boundaries

- The TypeScript layer may create its own VS Code diagnostics, inlay hints, and Hover content; it must not assume that another extension's diagnostic collection can be mutated.
- The Rust proxy must forward non-diagnostic LSP traffic unchanged and translate only diagnostic notifications/responses and their related messages.
- The proxy loads the packaged catalog from `dist/error-codes.js`; update the TypeScript catalog and rebuild before testing a packaged proxy change.
- The native proxy is currently platform-specific. Do not describe it as cross-platform until binaries and launch behavior exist for the target platform.

## Conventions

- Keep user-facing diagnostic explanations concise and beginner-friendly.
- Preserve Rust keywords, identifiers, code fragments, ranges, and error codes so a user can match the message to source code.
- Keep TypeScript source under `src/` and Rust proxy source under `proxy/src/`.
- Treat `dist/`, `proxy/target/`, `node_modules/`, and `*.vsix` as generated artifacts; do not edit or commit them as source.
- Keep README language navigation English-first and extend the locale structure rather than replacing the existing Chinese section.

## Definition of Done

- For TypeScript or manifest changes, run `npm run check` and `npm run compile`.
- For proxy changes, run `cargo check --manifest-path proxy/Cargo.toml` and rebuild `bin/rust-analyzer-zh-proxy.exe` before packaging.
- For release/package changes, run `npm run package` and inspect the VSIX file list for the expected `bin/` and `dist/` contents.
- Report any platform limitation, unavailable test, or unresolved packaging warning instead of hiding it.

## Boundaries

- Always preserve the user's existing rust-analyzer server settings when enabling or restoring the native proxy.
- Always keep secrets, access tokens, local credentials, and machine-specific settings out of the repository.
- Ask first before adding a dependency with a new runtime or licensing requirement, changing the public extension identifier, or modifying a user's global VS Code settings.
- Ask first before force-pushing, deleting a remote repository, or rewriting shared Git history.
- Never commit `node_modules/`, `dist/`, `proxy/target/`, generated VSIX files, or copied external extension files.

## References

- [`README.md`](README.md) - user installation, configuration, architecture, and roadmap.
- [`package.json`](package.json) - extension metadata and verified scripts.
- [`proxy/Cargo.toml`](proxy/Cargo.toml) - native proxy build facts.
