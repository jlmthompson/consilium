# Computational Genomics Virtual Lab

Prototype of a multi-agent deliberation system for the Victor Chang Computational Genomics Lab. A human researcher poses a scientific agenda, and a team of LLM agents with specialist personas debates it across a structured set of rounds.

## Quick start

1. Clone or download the files into a directory.
2. Open `index.html` in a browser. For best results run a local server (so PubMed CORS and clipboard behave nicely):
   ```bash
   npx serve .
   # or
   python3 -m http.server 8000
   ```
3. In the header, paste your **Anthropic API key**. It is stored in `sessionStorage` only and is cleared when the tab closes.
4. (Optional) Change the **model ID** in the header. Defaults to `claude-sonnet-4-6`; you can swap to any Claude model your key has access to (e.g. `claude-opus-4-7` for higher-quality reasoning, `claude-haiku-4-5` for cheaper/faster runs). 
5. Write an **agenda**, paste optional **context** (data availability, prior results, constraints), pick the number of **rounds**, and click **Run Meeting**.

## Meeting types

- **Team meeting** — All four agents participate. Each round:
  1. PI opens with framing + 2-3 guiding questions
  2. Specialist 1 responds (Computational Genomicist by default)
  3. Specialist 2 responds (Clinical Cardiologist / Geneticist by default)
  4. Scientific Critic critiques both responses
  5. PI synthesises and poses follow-up questions for the next round

  After N rounds, the PI produces a **final summary** with conclusions, open questions, and recommended next steps.

- **Individual meeting** — One agent works through the agenda alone. Optional Scientific Critic review at the end.

## Tool use

Agents are instructed in their system prompt that they can request a **PubMed search** mid-discussion by emitting a JSON block on its own line:

```json
{"tool": "pubmed_search", "query": "polygenic risk score congenital heart disease", "max_results": 5}
```

The frontend detects this, runs the E-utilities query (`esearch` → `esummary` → `efetch` for abstracts), injects the results back into the conversation as a tool message, and re-prompts the same agent so it can incorporate the findings. Each agent turn is capped at one PubMed search to prevent loops.

Agents can also produce **code blocks** (Python or R). These are rendered with syntax-style monospace formatting and a **Copy** button. Scripts are **not** executed; the user runs them manually.

## Browser-direct API access

The frontend calls `api.anthropic.com` directly using the header:

```
anthropic-dangerous-direct-browser-access: true
```

This is required for browser-origin requests. Be aware:

- Your API key is exposed in the browser (visible in devtools / network tab).
- This is acceptable for a **local prototype** but should not be deployed publicly without a server-side proxy.

## Editing agent personas

Expand **Edit agent personas** in the setup panel to modify any of the four fields (Title, Expertise, Goal, Role) for each agent. Changes apply on the next meeting run. **Reset to defaults** restores the CHD/genomics lab defaults shipped in `agents.js`.

## Meeting chain

After each meeting, a pill appears in the footer. Click a pill to view that meeting's transcript. Click **New Meeting (carry forward summary)** to prepend the most recent meeting's final summary into the context field for a follow-up meeting.

## Export

The **Export as Markdown** button downloads the currently-displayed meeting as a `.md` file: agenda, context, every turn (including tool results), and the final summary, in chronological order.

## Test scenario

The brief's recommended test (Team meeting, 2 rounds):

> **Agenda**: We have whole-genome sequencing data for approximately 400 CHD trios (proband + parents) on NCI Gadi. We want to design a variant prioritisation pipeline that identifies high-confidence de novo and rare inherited variants in cardiac-relevant genes. What should the pipeline look like, and what are the key analytical decisions we need to make?

> **Context**: Available data: GATK-called VCFs, hg38. Tools available on Gadi: bcftools, plink2, GATK, Python 3, R. Compute allocation: project a32. Timeline: 3 months to first results. Prior work: DeepRare and Exomiser have been run on a subset.

Expected behaviour: agents debate filtering strategy, gene panel vs genome-wide approach, inheritance model assumptions, and statistical thresholds. The Critic should push back on hand-wavy recommendations. One or more agents may trigger a PubMed search.
