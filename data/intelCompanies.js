/* =========================================================
   Companies the home-screen spotlight covers, by interest topic.
   Mirrors the iOS app's MockData+Interest.swift. Topic keys are the exact
   strings the app sends in ?topics= (URL-encoded, comma-separated).
========================================================= */
export const TOPIC_COMPANIES = {
  "Artificial Intelligence": ["IBM Consulting", "Dell Technologies", "NVIDIA", "VAST Data", "Hexaware Technologies", "ADP", "McDonald's", "Pinterest"],
  "Quantum Computing": ["IBM", "Xanadu", "Open Quantum Design", "Broadcom"],
  "Cybersecurity": ["Canadian Cybersecurity Network", "T-Mobile", "Broadcom", "Terranova Aerospace & Defense", "Wells Fargo", "IAPP"],
  "Robotics & Automation": ["Terranova Aerospace & Defense", "Dell Technologies", "DHL"],
  "Sustainability & CleanTech": ["Foresight Canada", "Ontario Centre of Innovation", "BDC"],
  "Healthcare & Lifesciences": ["Public Health Agency of Canada", "NEJM Group", "Hackensack Meridian Health", "Doctors Without Borders", "Sparrow BioAcoustics"],
  "Banking, Financial Services & Insurance": ["JPMorgan Chase & Co.", "Wells Fargo", "Helaba", "BDC", "Kraken", "Marsh", "KPMG"],
  "Supply Chain, Manufacturing & Infrastructure": ["DHL", "Amazon", "International Seaways", "LCBO", "Magna International", "Rockwell Automation"],
  "Defence & Public Safety": ["Global Affairs Canada", "Terranova Aerospace & Defense", "Public Health Agency of Canada"],
  "Energy & Utilities": ["Ontario IESO", "BC Hydro", "Schneider Electric", "Foresight Canada"],
};

export function companiesFor(topics = []) {
  const seen = new Set();
  const out = [];
  for (const t of topics) {
    for (const c of TOPIC_COMPANIES[t] || []) {
      if (!seen.has(c)) { seen.add(c); out.push(c); }
    }
  }
  return out;
}

export const ALL_COMPANIES = [...new Set(Object.values(TOPIC_COMPANIES).flat())];
