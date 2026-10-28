# Attributions

## inanna-malick/metacog — MIT

**Source repository:** [`inanna-malick/metacog`](https://github.com/inanna-malick/metacog)
**Pinned commit:** `3d89bb30cd26369fdcd242fd704f66641dca327c`
**License:** MIT
**Copyright:** Copyright (c) 2025 Inanna Malick

### What is copied and what is adapted

The upstream `feel` and `drugs` tool registrations: descriptions, field descriptions and return templates (`src/index.ts`, `feel` at lines 34–88 and `drugs` at lines 91–133, with the `clean` helper at line 31). The adapted form lives in `src/frames/feel-drugs.ts` and the verbatim form in `src/spike/feel-drugs/upstream-frames.ts`. The server-level `instructions` string and the other upstream registrations are not copied.

- **Plugins: adapted.** The `feel` and `drugs` tool descriptions, field descriptions and return text that the OpenCode plugin and the Claude Code and Codex plugin packages (`hosts/claude/`, `hosts/codex/`) ship are adapted from upstream at the pinned commit. Field names, types and the required/optional split are unchanged. Claims of efficacy and of changing how the model processes were rewritten, so the text describes a pause (`feel`) and a deliberate change of approach (`drugs`). Upstream's voice and imagery are kept where they are harmless.
- **Spike: verbatim.** The spike's MCP server (`src/spike/feel-drugs/server.ts`) serves the upstream text byte-for-byte (`UPSTREAM_*` in `src/spike/feel-drugs/upstream-frames.ts`, which the plugin bundle does not include), because the spike's committed records are evidence of that exact text. The registration handlers are lifted into the `upstreamFeelText` and `upstreamDrugsText` functions; the template literals are unchanged.

### License

```text
MIT License

Copyright (c) 2025 Inanna Malick

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
