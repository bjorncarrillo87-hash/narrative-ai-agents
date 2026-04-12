#!/usr/bin/env python3
"""Convert investor report markdown files to styled PDFs."""

import sys
import markdown
from weasyprint import HTML

CSS = """
@page {
    size: A4;
    margin: 2cm 2.5cm;
}
body {
    font-family: Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #1a1a1a;
}
h1 {
    font-size: 20pt;
    font-weight: 900;
    text-align: center;
    border-bottom: 3px solid #1a1a1a;
    padding-bottom: 10px;
    margin-bottom: 20px;
}
h2 {
    font-size: 14pt;
    font-weight: 800;
    margin-top: 24px;
    margin-bottom: 10px;
    border-bottom: 1.5px solid #ccc;
    padding-bottom: 4px;
}
h3 {
    font-size: 12pt;
    font-weight: 700;
}
table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 10pt;
}
th, td {
    border: 1px solid #bbb;
    padding: 6px 10px;
    text-align: left;
}
th {
    background-color: #222;
    color: #fff;
    font-weight: 700;
}
tr:nth-child(even) {
    background-color: #f5f5f5;
}
hr {
    border: none;
    border-top: 2px solid #ddd;
    margin: 20px 0;
}
blockquote {
    border-left: 4px solid #333;
    margin: 16px 0;
    padding: 8px 16px;
    background: #f9f9f9;
    font-size: 10pt;
}
code {
    font-family: 'Courier New', monospace;
    font-size: 9pt;
    background: #f0f0f0;
    padding: 1px 4px;
    border-radius: 3px;
}
pre {
    background: #1a1a1a;
    color: #e0e0e0;
    padding: 14px;
    border-radius: 6px;
    font-size: 8.5pt;
    line-height: 1.4;
    overflow-x: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
}
pre code {
    background: none;
    padding: 0;
    color: #e0e0e0;
}
strong {
    font-weight: 800;
}
ul {
    margin: 8px 0;
}
li {
    margin: 4px 0;
}
em {
    font-style: italic;
    color: #555;
}
"""

# Convert all reports or a specific one
REPORTS = [
    ("REPORT-2025-04-01.md", "REPORT-2025-04-01.pdf"),
    ("REPORT-2025-04-01-run2.md", "REPORT-2025-04-01-run2.pdf"),
    ("REPORT-2026-04-03.md", "REPORT-2026-04-03.pdf"),
    ("REPORT-2026-04-04.md", "REPORT-2026-04-04.pdf"),
    ("REPORT-2026-04-05.md", "REPORT-2026-04-05.pdf"),
    ("REPORT-1YEAR-PROJECTION.md", "REPORT-1YEAR-PROJECTION.pdf"),
]

BASE = "/home/user/Narrative_AI_Agent_Kabal/test-results"

targets = REPORTS
if len(sys.argv) > 1:
    # Convert specific file if passed as argument
    md_name = sys.argv[1]
    pdf_name = md_name.replace(".md", ".pdf")
    targets = [(md_name, pdf_name)]

for md_file, pdf_file in targets:
    md_path = f"{BASE}/{md_file}"
    pdf_path = f"{BASE}/{pdf_file}"
    try:
        with open(md_path, "r") as f:
            md_content = f.read()
        html_body = markdown.markdown(md_content, extensions=["tables", "fenced_code"])
        full_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>{CSS}</style></head>
<body>{html_body}</body>
</html>"""
        HTML(string=full_html).write_pdf(pdf_path)
        print(f"PDF saved: {pdf_path}")
    except FileNotFoundError:
        print(f"Skipped (not found): {md_path}")

