# NOTICE — licensing, data attribution, AI assistance

## 1. Code licence
The SignalFlow **software** is released under the **PolyForm Noncommercial 1.0.0** licence (source-available, non-commercial; see
[LICENSE](LICENSE)). You may relicense your own copy more restrictively if your
hackathon rules allow it — see §4.

## 2. Map data — OpenStreetMap (ODbL)
Street networks are derived from **OpenStreetMap** (via Overpass) and are
therefore subject to the **Open Database License (ODbL 1.0)**:

* **Attribution required:** “© OpenStreetMap contributors” (we ship this in the
  UI and docs).
* **Share-alike for derived *databases*:** if you redistribute the region graphs
  (`data/regions/*.json`, `data/osm/*.json`) as a database, they stay under ODbL.
* **Produced works** (e.g. rendered maps, metrics, screenshots) may be licensed
  however you like, with attribution.

This is *data*, not *code*: our PolyForm-Noncommercial code (or GPL/proprietary) can sit alongside ODbL
data as long as you keep the attribution and don’t relicense the OSM-derived
database itself.

## 3. Third-party services
* **Featherless.ai** and **ElevenLabs** are used via their APIs and are subject to
  their own terms of service and quotas. Keys are read from `.env`; no key is
  committed.
* No other third-party code is bundled (the app uses the Python standard library
  and vanilla JS only).

## 4. Hackathon rules — what to verify
The rules of the platform (`munichtechexpo.com`) could **not be fetched by tooling**
(re-verified 2026-09-19: the site is a client-rendered JS app behind a bot-verification
wall; earlier attempts got `/rules` → HTTP 403), so treat the following as general
guidance, not legal advice — **a human must read the rules page in a normal browser**:

* Devpost-style hackathons normally require the submission to be **your team’s own
  work** and the **source to be available to the judges** (public repo or shared
  access). A *restrictive* licence is usually **not prohibited**, but it can
  conflict with any explicit “open source” requirement — check the rules text.
* **AI-assisted development** is widely allowed on Devpost events (and is a stated
  feature of this event); disclose it if the rules ask for it. Suggested wording in
  §5.
* The organisers may require that prizes/special awards (ElevenLabs, Featherless)
  are claimed via their promo flow — see the README’s “Getting access” section.

## 5. Suggested AI-assistance disclosure
> SignalFlow was built for MunichTech EXPO 2026 with heavy use of AI coding
> assistance. Concrete stack:
>
> - **Claude Code** — agentic CLI harness, driven by the **GLM 5.3 Flash**
>   model (Z.ai)
> - **AutoClaw** and **Pi** — two further agentic harnesses used during
>   development
>
> all used for implementation, tests and documentation. The design, the traffic
> model, the calibration and all final decisions were made by the team; the
> numbers in the README are reproducible from the committed code and seeds.
> Tools used for demo/video production (e.g. TTS or video editing) will be
> appended to this list when they become part of the submission.

## 6. Reproducibility note
All simulation results are deterministic given a seed and reproducible from the
committed code and data — see `docs/results.md`.

See [docs/licensing.md](docs/licensing.md) for the challenge-rules evidence, the licence options and the full dependency inventory.

Alternative licence texts (e.g. Apache-2.0 as a permissive option) live on their
project pages — the repo ships exactly one licence file, `LICENSE`, the one in
effect. See docs/licensing.md section 9 for the decision record.
