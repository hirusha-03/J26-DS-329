# mock-uis

Static HTML/CSS/JS prototype of the 4 research modules + overview. Not wired
to `backend/` or `frontend/` — no npm install, no build step, no API calls.
All data is hardcoded in the HTML/JS.

Open `overview.html` (or `index.html`, which redirects there) directly in a
browser, or serve the folder with any static server, e.g.:

```
npx serve mock-uis
```

Pages:
- `overview.html` — plantation KPIs + module cards
- `disease-detection.html` — sample scan with a Grad-CAM-style overlay
- `digital-twin.html` — clickable plot map with a vine detail panel
- `growth-forecast.html` — vine-length chart + measurements table
- `vanilla-advisor.html` — Sinhala / Sinhala-English code-mixed chat mock,
  RAG+LLM-described assistant (this is the renamed "Recommendations"
  module — see `../Prototype Instructions.docx` equivalent spec baked in
  here: 4 tap-to-send sample questions with hardcoded answers, free-text
  falls back to a "not prepared yet" message).

Signature design element: the left nav is a "vine rail" — module links are
drawn as pods hanging off a climbing vine line, echoing how vanilla vines
grow up a support tree.
