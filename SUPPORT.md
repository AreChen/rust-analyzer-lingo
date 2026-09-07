# Support

Lingo is an independent companion extension, not an official Rust or rust-analyzer project.

Install the official [rust-analyzer extension](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) and a Rust toolchain first. Lingo explains diagnostics produced by your Rust tools; it does not install the Rust toolchain or replace the official language features.

## Report a problem

Open an [issue](https://github.com/AreChen/rust-analyzer-lingo/issues) with:

- VS Code, Lingo, and rust-analyzer versions.
- The extension host's operating system and architecture, including SSH, WSL, or container details when relevant.
- The original diagnostic text, chosen display mode, and a small Rust example.
- The expected explanation and what appeared instead.

Remove credentials, private source code, and personal paths before sharing logs or screenshots.

## Restore the original server

Run **Rust 中文诊断：恢复原始诊断** from the Command Palette. The command restores the workspace's saved server configuration and preserves settings you changed after enabling translation. For a legacy 0.1.x backup, check the displayed previous server before confirming restoration.

## 中文帮助

请先阅读[中文使用说明](docs/README.zh-CN.md)。遇到问题时，在 [GitHub Issues](https://github.com/AreChen/rust-analyzer-lingo/issues) 提供版本、运行平台、显示方式、编译器原文和最小 Rust 示例。不要附带密钥或私有代码。

本扩展为独立项目，与 Rust 官方、rust-analyzer 官方没有隶属关系。
