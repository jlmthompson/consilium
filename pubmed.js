// PubMed E-utilities wrapper. No API key required.
//
// Returns { query, usedQuery, broadened, count, items, formatted, attempts }.
// If the agent's query returns zero hits, the wrapper automatically retries with
// progressively shorter prefixes of the query (first half → first 3 → first 2),
// since space-separated PubMed terms are AND'd and overly specific queries
// almost always yield zero results.

const PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

async function pubmedSearch(query, maxResults = 5) {
  const capped = Math.max(1, Math.min(8, Number(maxResults) || 5));

  // 1. esearch — try the original query, then progressively broaden if it returned nothing.
  const variants = [query, ...broadenVariants(query)];
  const attempts = [];
  let ids = [];
  let usedQuery = query;

  for (const v of variants) {
    const found = await esearch(v, capped);
    attempts.push({ query: v, count: found.length });
    if (found.length > 0) {
      ids = found;
      usedQuery = v;
      break;
    }
  }

  if (ids.length === 0) {
    return {
      query,
      usedQuery: null,
      broadened: false,
      count: 0,
      items: [],
      attempts,
      formatted: formatEmpty(query, attempts),
    };
  }

  // 2. esummary — metadata.
  const summaryData = await esummary(ids);
  // 3. efetch — abstracts (best-effort; tolerate failure).
  const abstractsByPmid = await efetchAbstracts(ids).catch(() => ({}));

  const items = ids
    .map((id) => {
      const item = summaryData?.result?.[id];
      if (!item) return null;
      const authors = (item.authors || []).slice(0, 4).map((a) => a.name).join(", ");
      const more = (item.authors || []).length > 4 ? " et al." : "";
      const year = (item.pubdate || "").slice(0, 4) || "n.d.";
      return {
        pmid: id,
        title: cleanWhitespace(item.title || "(no title)"),
        authors: authors + more || "(no authors listed)",
        year,
        journal: item.source || "",
        abstract: abstractsByPmid[id] || "",
      };
    })
    .filter(Boolean);

  const broadened = usedQuery !== query;
  const formatted = formatForAgent(query, usedQuery, broadened, items);

  return { query, usedQuery, broadened, count: items.length, items, attempts, formatted };
}

// ---------------------------------------------------------------------------
// E-utilities calls
// ---------------------------------------------------------------------------

async function esearch(query, retmax) {
  const url =
    `${PUBMED_BASE}/esearch.fcgi?db=pubmed&retmode=json` +
    `&retmax=${retmax}&term=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PubMed esearch failed (${res.status})`);
  const data = await res.json();
  return data?.esearchresult?.idlist ?? [];
}

async function esummary(ids) {
  const url = `${PUBMED_BASE}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PubMed esummary failed (${res.status})`);
  return res.json();
}

async function efetchAbstracts(ids) {
  const url =
    `${PUBMED_BASE}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=xml&id=${ids.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PubMed efetch failed (${res.status})`);
  const xml = await res.text();
  return parseAbstractsFromXml(xml);
}

// ---------------------------------------------------------------------------
// Query broadening
// ---------------------------------------------------------------------------

function broadenVariants(query) {
  // Tokenise on whitespace and produce progressively shorter prefix queries,
  // each strictly shorter than the last. Stops at 2 tokens.
  const tokens = query.trim().split(/\s+/);
  if (tokens.length <= 3) return [];

  const candidateSizes = [
    Math.ceil(tokens.length * 0.66), // drop ~1/3 of trailing terms
    Math.ceil(tokens.length / 2),    // drop ~1/2
    3,
    2,
  ];
  const seen = new Set([tokens.length]);
  const variants = [];
  for (const s of candidateSizes) {
    if (s >= 2 && s < tokens.length && !seen.has(s)) {
      seen.add(s);
      variants.push(tokens.slice(0, s).join(" "));
    }
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatForAgent(originalQuery, usedQuery, broadened, items) {
  const lines = [];
  if (broadened) {
    lines.push(
      `PubMed search results — original query "${originalQuery}" returned 0 hits, ` +
        `broadened to "${usedQuery}" (consider whether the broadened results are still on-topic):`
    );
  } else {
    lines.push(`PubMed search results for "${originalQuery}":`);
  }
  lines.push("");
  items.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${item.title}`);
    lines.push(`   ${item.authors} (${item.year}). ${item.journal}. PMID:${item.pmid}`);
    if (item.abstract) {
      const snippet = item.abstract.length > 600
        ? item.abstract.slice(0, 600).trim() + "…"
        : item.abstract;
      lines.push(`   Abstract: ${snippet}`);
    }
    lines.push("");
  });
  return lines.join("\n").trim();
}

function formatEmpty(query, attempts) {
  const lines = [`PubMed search for "${query}" returned no results.`, ""];
  if (attempts.length > 1) {
    lines.push("Broadening attempts:");
    for (const a of attempts) lines.push(`  • "${a.query}" → 0 hits`);
    lines.push("");
  }
  lines.push(
    "Consider rephrasing with fewer, more general terms, or use OR to broaden synonyms " +
      'e.g. "(term-A OR synonym) core-concept".'
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function parseAbstractsFromXml(xml) {
  // Minimal XML parsing: pull each <PubmedArticle>...<PMID>id</PMID>...
  // ...<AbstractText>...</AbstractText> (possibly multiple labelled sections).
  const out = {};
  const articleRegex = /<PubmedArticle[\s\S]*?<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const articleXml = match[0];
    const pmidMatch = articleXml.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    if (!pmidMatch) continue;
    const pmid = pmidMatch[1];
    const abstractParts = [];
    const abstractRegex = /<AbstractText(?:\s+Label="([^"]+)"[^>]*)?[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let am;
    while ((am = abstractRegex.exec(articleXml)) !== null) {
      const label = am[1] ? `${am[1].toUpperCase()}: ` : "";
      const body = stripTags(am[2]);
      abstractParts.push(label + body);
    }
    if (abstractParts.length > 0) {
      out[pmid] = cleanWhitespace(abstractParts.join(" "));
    }
  }
  return out;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "");
}

function cleanWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}
