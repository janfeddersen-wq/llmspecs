# LLMSPEC — Curated LLM Skills and Definitions

LLMSPEC is a curated collection of meticulously crafted LLM skills and model/provider definitions. It powers **llmspec.dev** with downloadable skill packages and machine-readable JSON manifests for providers, models, capabilities, pricing, and limits.

## Repository structure

- `skills/` — Skill definitions (source content used to build distributable skill packages).
- `models.dev/` — Git submodule containing provider/model definitions (tracked on the `dev` branch).
- `website/` — Astro static site (build scripts + published JSON endpoints).

## Getting started

Clone the repo **with submodules**:

```bash
git clone --recurse-submodules <repo-url>
```

If you already cloned it:

```bash
git submodule update --init --recursive
```

Install the website dependencies:

```bash
cd website
npm install
```

Run the dev server:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

## Updating the model definitions submodule

```bash
cd models.dev
git fetch origin dev
git checkout dev
git pull origin dev
cd ..
git add models.dev
git commit -m "chore: update models.dev submodule"
```

## Build pipeline

The website build uses an `npm` `prebuild` hook to generate published artifacts before bundling the Astro site:

- `website/scripts/build-skills.mjs` — Packages skills into ZIP downloads and emits JSON manifests.
- `website/scripts/build-definitions.mjs` — Parses TOML provider/model data into JSON definition manifests.

## JSON API endpoints

- https://www.llmspec.dev/skills/skills.json
- https://www.llmspec.dev/definitions/definitions.json
