# Changelog

## 0.3.1 — 2026-09-08

- Add an original extension icon and Marketplace discovery metadata.
- Add a bilingual usage illustration, support guide, and release history.
- Clarify that Lingo is an independent companion to the official rust-analyzer extension.
- Keep the diagnostic behavior and eight supported platform targets from 0.3.0.

## 0.3.0 — 2026-09-07

- Ship native diagnostic translation for Windows, macOS, GNU Linux, and Alpine Linux on x64 and ARM64.
- Preserve concrete types, names, related locations, and original diagnostic messages.
- Save and restore native proxy settings per workspace while retaining subsequent user edits.
- Share diagnostic explanations between TypeScript and Rust; cover 518 Rust error codes.
- Improve inline hints, hover explanations, Problems entries, and the status-bar menu.
- Validate compatibility with rust-analyzer 0.3.3033 and 0.3.3041.
- Generate platform VSIX packages in `out/packages/` and publish checksums after the full CI matrix passes.

## 0.1.4 — 2026-08-11

- Improve the original Windows-only diagnostic translation, including overflowing literals and diagnostic source labels.

For complete source history, see the [GitHub commits](https://github.com/AreChen/rust-analyzer-lingo/commits/main/).
