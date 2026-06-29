<div align="right">

🇺🇸 English | [🇰🇷 한국어](README.ko.md)

</div>

# ThirdBrain

**Turn your notes into a contradiction-free knowledge graph.**

ThirdBrain is an Obsidian plugin that extracts propositions from your writing, builds a logical knowledge graph with typed edges, detects contradictions, and analyzes connections — all locally using your choice of AI provider.

---

## Features

### ✦ Graph Generation
Paste or drop any text. ThirdBrain runs a multi-stage pipeline that builds three layers of structured knowledge:

| Stage | Layer | What it produces |
|-------|-------|-----------------|
| ① | **Context** | Key themes and concepts extracted from the source text |
| ② | **Propositions** | Atomic logical claims, each anchored to the exact source paragraph |
| ③ | **Edges** | Typed logical relations between propositions across 4 axes |
| ④ | **Actions** *(optional)* | Actionable tasks extracted from meeting notes or decision records |

**10 logical relation types across 4 axes:**

| Axis | Relations |
|------|-----------|
| Causal | `causes`, `precedes`, `precondition_of` |
| Truth | `supports`, `conflicts_with`, `contrasts_with` |
| Hierarchy | `exemplifies`, `applies_to` |
| Topology | `analogous_to`, `isomorphic_to` |

**Auto-connection to your existing graph:**
After the pipeline runs, ThirdBrain automatically scans your existing knowledge graph and proposes edges between the new nodes and your saved notes — surfacing connections you didn't know existed.

**Contradiction handling:**
When a new proposition conflicts with existing knowledge, ThirdBrain flags it immediately with a `conflicts_with` edge and presents three resolution options: discard one proposition, discard the other, or introduce a parent premise that encompasses both. No contradiction is silently buried.

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
2. Copy to `{vault}/.obsidian/plugins/thirdbrain/`
3. Enable in **Settings → Community plugins**

---

## Usage

1. Open the ThirdBrain panel (click the sootball icon in the ribbon, or run **Open ThirdBrain panel** from the command palette)
2. Paste text into the input area and click **✦ Generate** to run the pipeline
3. Use **🔍 Analyze** to analyze a folder and get a synthesized insight report
4. Use **🌉 Bridge** to find cross-folder connections

---

## Requirements

- Obsidian 1.4.0+
- Desktop only (uses local AI CLI or network API calls)
- One of: Gemini API key, Anthropic API key, or Claude Code CLI

---

## Enterprise Use Cases

ThirdBrain's architecture — typed logical edges, absolute source traceability, and contradiction detection — maps directly onto high-stakes organizational problems.

### Absolute Traceability from Idea to Code

Every business decision leaves a verifiable trail. Drop a product spec or domain document into ThirdBrain: it's archived as-is in `raw/`, decomposed into propositions with exact source spans, and linked to the development actions that implement them via `implements` edges. When a developer writes code, they can trace it back — without ambiguity — to the business proposition that demanded it, and to the original paragraph that proposition came from.

> Works today. Ingest your PRD, let ThirdBrain extract propositions, then create action nodes for each sprint task. The `implements` link is the audit trail.

### Semantic Collider — Cross-Domain Contradiction Detection

Different teams use different words for the same concepts, or the same words for conflicting ones. Feed documents from two domains (e.g. engineering specs and security policy) into separate folders, then run **Bridge** between them. ThirdBrain surfaces the structural connections your teams haven't made explicit — and the `conflicts_with` edges reveal where the two bodies of knowledge are on a collision course before anyone writes a line of code.

> Works today via the Bridge feature. Cross-folder analysis finds implicit agreements and contradictions across organizational silos.

### Logical API Gatekeeper — Contradiction-Driven Requirements Review

Build a master graph of your core architecture decisions and non-negotiable principles. When a new feature request or policy change arrives, ingest it. If it generates a `conflicts_with` edge against the master graph, the system surfaces the exact proposition it contradicts and demands resolution — not negotiation by exhaustion, but resolution by logic.

> Works today as a workflow. Automated rejection (blocking ingestion on conflict) is a planned extension.

---

## License

MIT
