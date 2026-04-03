# BMAD Sprint Overview

A local-first dashboard for visualizing all your BMAD-managed projects in one place.

## Quick Start

```bash
npm install
npm start
# → http://localhost:3333
```

Auto-scans the parent directory for BMAD repos. Override with `REPOS_ROOT=/your/path npm start`.

## What It Does

- **Dashboard** — all BMAD projects at a glance with progress rings and story counts
- **Project drill-down** — click a project to see epics, stories, status badges, progress bars
- **Story reader** — click any story to read its `.md` file rendered Notion-style (slide-in panel)
- **Git status** — branch, uncommitted changes, unpushed commits per repo

## Stack

4 dependencies. Zero build step. One HTML file.

| Layer | Tech |
|-------|------|
| Server | Express (serves API + static files) |
| YAML | js-yaml |
| Markdown | marked |
| Git | simple-git |
| Frontend | Vanilla JS, single `index.html` |

## How It Discovers Projects

Scans `REPOS_ROOT` (default: parent of this folder) for any directory containing:
- `_bmad-output/sprint-status.yaml`, or
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

Also checks one level deep for monorepo sub-projects.

Parses both BMAD YAML formats:
- **Hierarchical** (epics → stories[] with file paths)
- **Flat key-value** (development_status with epic-N / N-N-title keys)

## Non-Goals

Read-only. No editing, no GitHub API, no cloud, no accounts.
