// PubMed E-utilities wrapper. No API key required.
// Returns { query, count, items: [{pmid, title, authors, year, journal, abstract}], formatted }.

const PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

async function pubmedSearch(query, maxResults = 5) {
  const capped = Math.max(1, Math.min(8, Number(maxResults) || 5));

  // 1. esearch — get PMIDs
  const esearchUrl =
    `${PUBMED_BASE}/esearch.fcgi?db=pubmed&retmode=json` +
    `&retmax=${capped}&term=${encodeURIComponent(query)}`;
  const esearchRes = await fetch(esearchUrl);
  if (!esearchRes.ok) {
    throw new Error(`PubMed esearch failed (${esearchRes.status})`);
  }
  const esearchData = await esearchRes.json();
  const ids = esearchData?.esearchresult?.idlist ?? [];
  if (ids.length === 0) {
    return {
      query,
      count: 0,
      items: [],
      formatted: `PubMed search for "${query}" returned no results.`,
    };
  }

  // 2. esummary — metadata
  const esummaryUrl =
    `${PUBMED_BASE}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`;
  const summaryRes = await fetch(esummaryUrl);
  if (!summaryRes.ok) {
    throw new Error(`PubMed esummary failed (${summaryRes.status})`);
  }
  const summaryData = await summaryRes.json();

  // 3. efetch — abstracts (best-effort; tolerate failure)
  let abstractsByPmid = {};
  try {
    const efetchUrl =
      `${PUBMED_BASE}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=xml&id=${ids.join(",")}`;
    const efetchRes = await fetch(efetchUrl);
    if (efetchRes.ok) {
      const xmlText = await efetchRes.text();
      abstractsByPmid = parseAbstractsFromXml(xmlText);
    }
  } catch (e) {
    // Non-fatal — fall back to metadata only.
  }

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

  const formatted = formatForAgent(query, items);
  return { query, count: items.length, items, formatted };
}

function formatForAgent(query, items) {
  const lines = [`PubMed search results for "${query}":`, ""];
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
