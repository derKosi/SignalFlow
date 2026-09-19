# Licensing: what we may do, and what we should pick

Written 2026-09-19. This is an engineering/administrative analysis, **not legal advice**.

## 1. What the challenge actually requires (verified)

* The public challenge API (`/back/api/challenges/smart-cities-traffic-flow-2026`) has
  **no licensing, copyright, IP or "open source" field at all** -- checked field by
  field (`licen`, `copyright`, `intellectual`, `ip`, `open source`, `public repo`,
  `github`, `terms`, `ownership` -- all absent).
* The site's `/terms` and `/about` pages are client-rendered (only the document title
  is visible without a JS engine), so their wording **could not be read with our
  tools**. `/rules` returns 404 on this host and the Devpost `/rules` page answered
  **HTTP 403** earlier. `check in a browser before submitting`.
* Consequence: as far as we can verify, the challenge does **not** mandate an open
  licence, and does **not** claim ownership of our code.

## 2. "Showing the code is not the same as letting people use it" -- correct

Copyright is the default. Publishing a repository (or a demo link for judges) gives
people the right to *view* it; **without a licence nobody may copy, modify,
redistribute or use it commercially**. A public GitHub repo with no `LICENSE` file is
"all rights reserved" (GitHub's ToS only adds viewing and forking *on GitHub*).

So we have three realistic postures: keep it closed (no licence), make it
source-available but restricted, or make it open.

## 3. Options

| Option | Others may use it | Commercial use | Notes for us |
|---|---|---|---|
| No `LICENSE` (all rights reserved) | no | no | safest legally, weakest signal for a hackathon/portfolio; judges can still view |
| **PolyForm Noncommercial 1.0.0** | yes, non-commercial only | no | source-available; readable, forkable for research/teaching; keeps monetisation for us; not OSI-approved |
| **Business Source Licence (BUSL-1.1)** | yes, with limits until a change date | restricted until change date, then Apache-2.0 | used by big infra companies; heavier to administer |
| **Apache-2.0** | yes | yes | permissive + explicit patent grant + attribution; best for adoption and sponsor/portfolio credibility |
| **MIT** | yes | yes | simplest permissive; no patent clause |
| **AGPL-3.0** | yes | yes, but network users must get the source | strong copyleft; prevents "take it and close it" |

Reminder: if we ever want sponsors/partners to adopt it, permissive helps. If the goal
is "visible, but ours to monetise", non-commercial source-available is the fit.

## 4. Recommendation

Given "we want to show it but not let everyone use it", the pragmatic middle is:

* **Default proposal: `PolyForm Noncommercial 1.0.0`** for the code -- viewable and
  usable for non-commercial purposes, commercial rights stay with us. Keep the
  copyright notice with the team.
* **If we prefer maximum credibility/adoption** (hackathon jury, CV, sponsor interest):
  `Apache-2.0` (permissive, patent grant, requires attribution).
* In both cases the **data** stays ODbL (see below) -- that is not negotiable.

We **switched to PolyForm Noncommercial 1.0.0** on 2026-09-19 (previously MIT). Switching is one file plus the
README/NOTICE wording; the ODbL attribution obligations do not change either way.

## 5. Dependency and asset inventory (what we must honour)

Scanned the tree: every Python import is the **standard library** or our own modules
(`__future__ argparse collections csv dataclasses heapq http io json math os pathlib
random re socket subprocess sys time unittest urllib ...`), the front end has **no CDN
or third-party JS** (only local files), and `pyproject.toml` declares
`dependencies = []`. So there is **no third-party code we redistribute**, and no
copyleft can attach to our code.

| Component | Role | Licence / terms | Our obligation |
|---|---|---|---|
| Python standard library | runtime | PSF-2.0 | none beyond the PSF licence text if we bundle Python (we do not) |
| OpenStreetMap data (`data/regions`, `data/osm`) | street networks | **ODbL 1.0** | attribution "© OpenStreetMap contributors"; share-alike applies to the **database** if redistributed |
| Overpass API | data fetch | OSMF usage policy | fair use, no bulk abuse, identified client |
| Nominatim | geocoding (live region add) | OSMF usage policy (max ~1 req/s, attribution) | attribution, low request rate |
| Featherless.ai | LLM explanations | provider ToS | do not redistribute the API key |
| ElevenLabs | text to speech | provider ToS | do not redistribute the API key |
| GitHub Actions | CI | no runtime dependency | none |
| Fonts / icons | UI | system fonts + hand-written SVG | none |

Data provenance notes: the sensor feed (`data/sample_traffic.csv`) is **synthetic, our
own**; the district graphs are **derived from OSM** (ODbL); the `.env` keys are
**never committed**.

## 6. Attribution obligations we already satisfy

* "© OpenStreetMap contributors" is in the UI, README, NOTICE and docs
  ([data.md](data.md#3-provenance--licensing)).
* ODbL share-alike is stated for the derived region graphs.
* Provider terms and the AI-assistance disclosure are in [NOTICE.md](../NOTICE.md).
* `.env` is gitignored; keys are read at runtime only.

## 7. Checklist before publishing

1. ~~Read `/terms` and the Devpost rules in a browser.~~ **Done** - the team supplied
   the rules text (section 8): no open-source requirement, closed parts allowed.
2. Pick one option from section 3 and put it in `LICENSE`.
3. Keep the ODbL attribution and the OSM copyright line wherever the data is shipped.
4. Note the licence + AI disclosure in the README and the Devpost "About the project".

## 8. Verified rules (provided by the team, 2026-09-19)

Quoted from the rules text the team obtained:

* "**Public GitHub URL required at submission; the core hackathon-built solution must
  be reviewable by judges.**" -- the repo must be public and the core readable.
* "**Proprietary/third-party deps and clearly disclosed closed components are
  allowed.**" -- a restrictive licence or even closed parts are explicitly permitted,
  as long as they are declared.
* "Declare all AI tools and usage honestly." -- our NOTICE.md disclosure covers this.
* "Build original work for the selected track/challenge." -- our own code + synthetic
  feed + ODbL-licensed map data; no third-party code bundled.
* Solo or teams up to 6; build window 1 Sep 06:00 - 20 Sep 17:00 CEST (online);
  Autumn Edition 20-22 Sep; on-site check-in; one People's Choice vote per email.

Consequence: **a restrictive licence is allowed.** The only hard requirements are
(a) public repo, (b) the core solution is reviewable, (c) honest disclosure. All three
are satisfied by any of the options in section 3, including
"No LICENSE (all rights reserved)" and PolyForm Noncommercial.

## 9. Prepared licence files (switch is one step)

Two full licence texts are committed next to MIT, so we can switch without fetching:

| File | Use |
|---|---|
| Apache-2.0 (apache.org/licenses) | permissive: adoption, patent grant, attribution |
| PolyForm Noncommercial 1.0.0 (polyformproject.org) — **in effect** | source-available, non-commercial only |
| `LICENSE` | **PolyForm Noncommercial 1.0.0 (current)** |

To switch:

```bash
# restrictive (recommended if we keep commercial rights)
# fetch the text from polyformproject.org/licenses/noncommercial/1.0.0 and save as LICENSE
# or permissive
# fetch the text from apache.org/licenses/LICENSE-2.0.txt and save as LICENSE
```

Then update the first line of the README "Licensing" section, the note in NOTICE.md and
the Devpost "About the project" text. The ODbL attribution obligations do not change.

**Decision (2026-09-19): PolyForm Noncommercial 1.0.0 -- applied.** Rationale: given "show it, but it stays ours to use commercially",
`PolyForm Noncommercial 1.0.0`; if jury/portfolio reach matters more, `Apache-2.0`.

## 10. Compatibility FAQ: ODbL data vs. our non-commercial code licence

**Is PolyForm Noncommercial compatible with OpenStreetMap (ODbL)?** Yes. Code and
database are two independent layers:

* Our **software** is ours: we license it PolyForm Noncommercial (source-available,
  non-commercial). ODbL imposes nothing on our own source code that merely *reads*
  map data.
* The **region graphs** (`data/regions/*.json`) are a **derivative database** of OSM,
  so they stay **ODbL**: attribution plus share-alike for the database. Shipping them
  in the same public repo is fine -- two licences side by side, clearly labelled
  (NOTICE section 2, docs/data.md section 3, plus the in-app "OpenStreetMap
  contributors" line).
* ODbL share-alike attaches to *derivative databases*, not to code that queries them,
  so the non-commercial code licence does not conflict with it.

**Three honest caveats:**

1. **The data stays usable commercially** by anyone under ODbL (with attribution and
   share-alike). Our "no commercial use" restricts **our code**, not the maps -- OSM
   data simply cannot be made non-commercial.
2. **Do not drop the attribution.** "OpenStreetMap contributors" must stay in the UI,
   README and NOTICE wherever the derived data ships.
3. **Overpass / Nominatim are OSMF services with usage policies** (fair use, low
   request rate, identified client). A demo with user-triggered region fetches is
   within policy; a production deployment would self-host or use a commercial geocoder.

**Other components:** the Python standard library (PSF-2.0) imposes nothing on our
code and is not bundled; Featherless/ElevenLabs are called as hosted APIs with private
keys (no software or model weights redistributed); the sample sensor feed is our own
synthetic data. So there is no licence conflict anywhere in the stack.

**Third-party evaluation:** reading the code (judges, sponsors, researchers) is a
permitted non-commercial purpose. A company that wants to *deploy* it commercially
needs a commercial licence from us -- which is exactly the intended effect.
