<p align="right">
  <a href="../README.md">English</a>
  ·
  <strong>简体中文</strong>
</p>

# rust-analyzer-lingo

一个面向 VS Code 的 Rust 多语言诊断辅助扩展。当前版本重点支持简体中文，后续会继续加入英语和更多语言。

它不会替换 `rust-analyzer`、`rustc` 或 Clippy，而是在原有诊断之上增加更容易理解的中文解释，同时保留错误代码、源代码位置、严重级别、Rust 关键字和变量名。

## 主要功能

- 将 Rust 错误代码和常见编译器消息转换为简洁的中文提示。
- 收录当前稳定版 Rust 错误索引中的全部 518 个错误代码页面；已经废弃或仅供编译器内部使用的代码也会保留，并明确标注状态。
- 支持行内提示、扩展自己的 Hover，以及 Problems 面板中的中文诊断。
- 原始诊断不会被删除，方便对照官方编译器信息。
- Windows x64 提供原生 LSP 代理，可以把 `rust-analyzer` 自己的诊断 Hover 也翻译成中文。
- 诊断传输层与语言内容分离，为未来增加多国语言预留空间。

## 使用要求

- VS Code 1.90 或更高版本。
- 官方 [rust-analyzer 扩展](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)。
- 已安装 Rust 工具链，并且 `rustc`、`cargo` 可以在终端中使用。
- 原生 Hover 替换目前只支持 Windows x64；行内提示、扩展 Hover 和 Problems 面板不依赖原生代理。

## 安装

### 安装 VSIX

可以在 VS Code 命令面板中选择 **Extensions: Install from VSIX...**，然后选择项目生成的 VSIX 文件。

也可以在终端执行：

```powershell
code --install-extension .\rust-analyzer-lingo-0.1.0.vsix --force
```

### 从源码构建

```powershell
npm install
cargo build --release --manifest-path proxy\Cargo.toml
Copy-Item proxy\target\release\rust-analyzer-lingo-proxy.exe bin\rust-analyzer-lingo-proxy.exe -Force
npm run package
```

生成的文件名为 `rust-analyzer-lingo-0.1.0.vsix`。

## 基本使用

打开一个有错误的 Rust 文件。默认的 `inline` 模式会在错误所在行末尾添加一条紧凑的中文提示。鼠标悬停在提示上可以查看完整解释，原始的 `rust-analyzer` 或 `rustc` 诊断仍然保留。

在 VS Code 设置中搜索 `rust-analyzer-lingo`，或者直接编辑 `settings.json`：

```json
{
  "rust-analyzer-lingo.mode": "inline",
  "rust-analyzer-lingo.showFallback": false,
  "rust-analyzer-lingo.inlineTextMaxLength": 32
}
```

### 显示模式

| 模式 | 作用 |
| --- | --- |
| `inline` | 在错误所在行旁边显示紧凑中文提示。 |
| `hover` | 使用扩展自己的 Hover 显示中文解释。 |
| `problems` | 在 Problems 面板追加中文诊断。 |
| `both` | 同时启用扩展 Hover 和 Problems 中文诊断。 |

### 其他设置

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `rust-analyzer-lingo.showFallback` | `false` | 没有词典条目或消息规则时，是否显示通用中文说明。 |
| `rust-analyzer-lingo.inlineTextMaxLength` | `32` | 限制行内提示的可见长度；完整内容仍可通过 Hover 查看。 |

### 命令面板

- **Rust 中文诊断：解释当前错误**：解释光标所在位置的 Rust 诊断。
- **Rust 中文诊断：启用原生 Hover 中文替换**：让内置 Windows x64 代理接管 `rust-analyzer` 的服务器路径。
- **Rust 中文诊断：恢复原生 Hover**：恢复启用代理前保存的服务器路径和环境变量。

启用原生 Hover 时，扩展会修改当前工作区或全局的 `rust-analyzer` 设置，并在扩展状态中保存原配置。旧版 `rust-analyzer` 可能需要手动执行 **Rust Analyzer: Restart Server**。

## 错误代码词典

词典位于 [`src/error-codes.ts`](../src/error-codes.ts)。当前覆盖本机稳定 Rust 工具链 `share/doc/rust/html/error_codes` 目录中的 518 个 `E####` 页面。这里的 518 项是官方错误索引页面总数，不等于“当前编译器仍会主动发出的 518 种错误”：其中包含历史遗留代码和编译器内部代码。

每条词典内容都尽量保留 Rust 的技术术语、代码片段和错误代码，避免中文翻译让用户无法回到官方文档或搜索结果。更新 Rust 工具链后，应重新对照本机错误索引检查总数、缺失项、重复项和多余项。

## 工作原理

扩展层读取 VS Code 已经收到的 Rust 诊断，按照错误代码和常见英文消息匹配中文内容，然后把结果放到行内提示、Hover 或 Problems 面板中。原生 Hover 模式下，Windows x64 Rust 代理使用标准 LSP 转发所有无关消息，只翻译诊断消息，并通过 `RUST_ANALYZER_LINGO_REAL_SERVER` 找到真正的 `rust-analyzer` 可执行文件。

## 开发

```powershell
npm install
npm run check
npm run compile
cargo check --manifest-path proxy\Cargo.toml
cargo build --release --manifest-path proxy\Cargo.toml
Copy-Item proxy\target\release\rust-analyzer-lingo-proxy.exe bin\rust-analyzer-lingo-proxy.exe -Force
npm run package
```

生成的 `dist/`、`proxy/target/`、`node_modules/` 和 VSIX 文件都是构建产物，不要当作源文件提交。

## 后续计划

- 增加语言选择按钮和英语语言包。
- 在 `docs/` 和扩展翻译资源中加入更多语言。
- 为 macOS、Linux 等平台提供原生代理。
- 在保持行内提示简洁的同时，继续补充上下文解释。

## 参与贡献

欢迎提交错误报告和翻译改进。修改词典时，请附上错误代码、使用的 Rust 工具链版本或官方页面，以及翻译措辞的简短理由。提交前请运行 TypeScript 和 Rust 检查。

## 许可证

本项目使用 [MIT License](../LICENSE)。
