# ThirdBrain

**Turn your notes into a contradiction-free knowledge graph.**

ThirdBrain is an Obsidian plugin that extracts propositions from your writing, builds a logical knowledge graph with typed edges, detects contradictions, and analyzes connections — all locally using your choice of AI provider.

---

## Features

### ✦ Graph Generation
Paste or drop any text. ThirdBrain extracts propositions (claims, concepts, insights) and builds a typed knowledge graph using 10 logical relation types across 4 axes:

| Axis | Relations |
|------|-----------|
| Causal | `causes`, `precedes`, `precondition_of` |
| Truth | `supports`, `conflicts_with`, `contrasts_with` |
| Hierarchy | `exemplifies`, `applies_to` |
| Topology | `analogous_to`, `isomorphic_to` |

### 🔍 Folder Analysis
Select any folder and get a synthesized insight report — not just a summary of connections, but concrete conclusions derived from the logical structure. Supports intent presets (core insight, contradiction detection, action extraction, etc.) and optional `_actions` subfolder inclusion.

### ⊕ Graph View
Open Obsidian's native graph view filtered to any folder for visual exploration.

### 🌉 Bridge
Find structural bridges between two folders — cross-domain connections your notes imply but haven't made explicit.

### Action Layer
Actions extracted from your notes are stored in `_actions/` subfolders, linked back to the propositions that motivated them.

---

## AI Provider Setup

ThirdBrain supports three AI backends. Set your preferred provider on first launch or in **Settings → ThirdBrain**.

| Provider | How to get started |
|----------|-------------------|
| **Gemini** | [Google AI Studio](https://aistudio.google.com/) → API keys → Create |
| **Claude API** | [Anthropic Console](https://console.anthropic.com/) → API Keys → Create |
| **Claude Code** | [claude.ai/code](https://claude.ai/code) → Install CLI → set path |

> All AI calls happen locally from your machine. No data is sent to any ThirdBrain server.

---

## Installation

### Community Plugins (recommended)
1. Open Obsidian → **Settings → Community plugins → Browse**
2. Search for **ThirdBrain**
3. Install and enable

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest)
2. Copy to `{vault}/.obsidian/plugins/thirdbrain-v2/`
3. Enable in **Settings → Community plugins**

---

## Usage

1. Open the ThirdBrain panel (click the sootball icon in the ribbon, or run **Open ThirdBrain panel** from the command palette)
2. Paste text into the input area and click **✦ 생성** to generate graph nodes
3. Use **🔍 분석** to analyze a folder and get a synthesized insight report
4. Use **🌉 연결** to find cross-folder bridges

---

## Requirements

- Obsidian 1.4.0+
- Desktop only (uses local AI CLI or network API calls)
- One of: Gemini API key, Anthropic API key, or Claude Code CLI

---

## License

MIT
